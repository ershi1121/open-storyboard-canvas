import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/stores/canvasStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  resolveClipboardImageFile,
  resolveClipboardMediaFile,
} from '@/features/canvas/application/clipboardImage';
import { isImageFile } from '@/features/canvas/application/imageDragDrop';
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  getNodeSize,
  isLikelyVideoSourceText,
  resolveAbsoluteNodePosition,
} from '@/features/canvas/shared/utils/node-helpers';
import {
  fingerprintClipboardContent,
  fingerprintMediaFile,
  hasClipboardPayload,
  hashText,
  readClipboardContent,
  resolveMediaFingerprintKind,
  syncSingleCanvasNodeToSystemClipboard,
} from '@/features/canvas/shared/utils/clipboard';
import type {
  CanvasClipboardSnapshot,
  ClipboardContentReadResult,
  ClipboardFreshnessSource,
  ClipboardPasteSource,
  SystemClipboardPasteOptions,
} from '@/features/canvas/shared/types';
import type { CreatedMaterialNode } from '@/features/canvas/hooks/useMaterialImport';

/**
 * 系统剪贴板 ↔ 画布桥接（Canvas2D 版，移植自旧版 useCanvasClipboard 的系统剪贴板部分）。
 *
 * 职责：
 * - 内部节点复制时，把单节点内容（图片或文本）同步写入系统剪贴板，
 *   并记录"新鲜度指纹"基线，用于后续粘贴时判断内容来自内部还是外部。
 * - Ctrl+V 双通道：document paste 事件（同步 clipboardData，无需权限）优先，
 *   40ms 内未触发则回退到 readClipboardContent（Tauri 优先，浏览器 API 兜底）。
 * - 粘贴目标规则（与旧版一致）：
 *   选中上传节点 → 素材替换（upload-node/paste-material 事件）；
 *   选中提示词类节点（图片编辑/AI视频/AI文本）→ 图片建参考节点连线 / 视频源 / 文本追加 prompt；
 *   选中文本批注节点 → 文本追加 content；
 *   其余 → 图片/素材建节点，纯文本建文本批注节点（落点为最近指针世界坐标）。
 */

interface UseCanvasSystemClipboardOptions {
  /** 粘贴落点：最近一次指针位置的世界坐标（视图层保证非空） */
  resolvePasteWorldPosition: () => { x: number; y: number };
  /** 视图层内部剪贴板快照 */
  getInternalSnapshot: () => CanvasClipboardSnapshot | null;
  /** 视图层内部快照粘贴；返回是否执行 */
  pasteInternal: (worldPosition: { x: number; y: number } | null) => boolean;
  createUploadImageNodeAtWorldPosition: (
    file: File,
    worldPosition: { x: number; y: number },
  ) => Promise<string | null>;
  createMaterialNodeFromFileAtWorldPosition: (
    file: File,
    worldPosition: { x: number; y: number },
  ) => Promise<CreatedMaterialNode | null>;
  scheduleCanvasPersist: (delay?: number) => void;
}

export interface ContextMenuPasteState {
  nodeId: string | null;
  worldPosition: { x: number; y: number };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function useCanvasSystemClipboard(options: UseCanvasSystemClipboardOptions) {
  // 所有视图层回调经 ref 读取：本 hook 返回的函数身份跨渲染稳定，
  // 避免宿主视图（快捷键监听等）随之反复重绑。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const pasteEventHandledAtRef = useRef(0);
  const clipboardFreshnessRef = useRef<ClipboardFreshnessSource>(null);
  const systemClipboardFingerprintAtInternalCopyRef = useRef<string | null | undefined>(undefined);
  const systemClipboardFingerprintCaptureRef = useRef<Promise<string | null> | null>(null);

  /* ---------- 新鲜度管理 ---------- */

  /** 内部复制后调用：标记 internal 新鲜度并把单节点内容同步到系统剪贴板 */
  const noteInternalCopy = useCallback((snapshot: CanvasClipboardSnapshot | null) => {
    if (!snapshot?.nodes.length) return;
    clipboardFreshnessRef.current = 'internal';
    systemClipboardFingerprintAtInternalCopyRef.current = undefined;

    const capture = syncSingleCanvasNodeToSystemClipboard(
      snapshot,
      useCanvasStore.getState().nodes,
    ).catch((error) => {
      console.warn('Failed to capture clipboard freshness baseline', error);
      return null;
    });
    systemClipboardFingerprintCaptureRef.current = capture;

    void capture.then((fingerprint) => {
      if (
        systemClipboardFingerprintCaptureRef.current === capture &&
        optionsRef.current.getInternalSnapshot() === snapshot &&
        clipboardFreshnessRef.current === 'internal'
      ) {
        systemClipboardFingerprintAtInternalCopyRef.current = fingerprint;
      }
    });
  }, []);

  const markSystemClipboardFresh = useCallback(() => {
    clipboardFreshnessRef.current = 'system';
    systemClipboardFingerprintAtInternalCopyRef.current = null;
    systemClipboardFingerprintCaptureRef.current = null;
  }, []);

  const settleInternalBaseline = useCallback(async (): Promise<string | null | undefined> => {
    let settled = systemClipboardFingerprintAtInternalCopyRef.current;
    const capture = systemClipboardFingerprintCaptureRef.current;
    if (settled === undefined && capture) {
      settled = await capture;
      if (systemClipboardFingerprintCaptureRef.current === capture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settled;
      }
    }
    return settled;
  }, []);

  const resolveClipboardPasteSource = useCallback(async (): Promise<ClipboardPasteSource> => {
    const internalSnapshot = optionsRef.current.getInternalSnapshot();
    const hasInternalSnapshot = Boolean(internalSnapshot?.nodes.length);
    const internalIsFresh = clipboardFreshnessRef.current === 'internal' && hasInternalSnapshot;
    const clipboardContent = await readClipboardContent();

    if (internalIsFresh) {
      const baselineFingerprint = await settleInternalBaseline();

      if (
        clipboardContent.fingerprint &&
        baselineFingerprint !== undefined &&
        clipboardContent.fingerprint !== baselineFingerprint
      ) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }

      if (clipboardContent.fingerprint && baselineFingerprint === undefined) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }

      return { source: 'internal' };
    }

    if (clipboardContent.imageFile) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    if (clipboardContent.fingerprint) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    return { source: 'none' };
  }, [markSystemClipboardFresh, settleInternalBaseline]);

  /* ---------- 系统内容粘贴 ---------- */

  const pasteImageAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const nodeMap = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n] as const));
      const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
      const uploadNodeId = await optionsRef.current.createUploadImageNodeAtWorldPosition(file, {
        x: absolute.x - 300,
        y: absolute.y,
      });
      if (!uploadNodeId) return false;
      useCanvasStore.getState().addEdge(uploadNodeId, targetNode.id);
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteMaterialAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const nodeMap = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n] as const));
      const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
      const created = await optionsRef.current.createMaterialNodeFromFileAtWorldPosition(file, {
        x: absolute.x - 300,
        y: absolute.y,
      });
      if (!created) return false;
      useCanvasStore.getState().addEdge(created.nodeId, targetNode.id);
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteVideoSourceAsNodeReference = useCallback(
    (videoSource: string, targetNode: CanvasNode) => {
      const trimmedSource = videoSource.trim();
      if (!isLikelyVideoSourceText(trimmedSource)) return false;
      const nodeMap = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n] as const));
      const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
      const videoNodeId = useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.video,
        { x: absolute.x - 300, y: absolute.y },
        {
          videoUrl: trimmedSource,
          localVideoUrl:
            trimmedSource.startsWith('http://') || trimmedSource.startsWith('https://')
              ? null
              : trimmedSource,
          thumbnailUrl: null,
          isGenerating: false,
          sourcePrompt: '',
        },
      );
      useCanvasStore.getState().addEdge(videoNodeId, targetNode.id);
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteTextIntoPromptNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return false;
      const data = targetNode.data as { prompt?: unknown };
      const currentPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
      useCanvasStore.getState().updateNodeData(targetNode.id, {
        prompt: currentPrompt ? `${currentPrompt}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteTextIntoTextNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      if (targetNode.type !== CANVAS_NODE_TYPES.textAnnotation) return false;
      const trimmedText = text.trim();
      if (!trimmedText) return false;
      const currentContent = (targetNode.data as { content?: unknown }).content;
      const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
      useCanvasStore.getState().updateNodeData(targetNode.id, {
        content: normalizedCurrent ? `${normalizedCurrent}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteTextAsTextNode = useCallback(
    (text: string, worldPosition?: { x: number; y: number }) => {
      const trimmedText = text.trim();
      if (!trimmedText) return false;
      useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        worldPosition ?? optionsRef.current.resolvePasteWorldPosition(),
        { content: trimmedText },
      );
      optionsRef.current.scheduleCanvasPersist(0);
      return true;
    },
    [],
  );

  const pasteSystemClipboardContent = useCallback(
    async (
      clipboardContent: ClipboardContentReadResult,
      pasteOptions: SystemClipboardPasteOptions,
    ) => {
      const targetNode = pasteOptions.targetNode;
      const isPromptPasteTarget =
        targetNode?.type === CANVAS_NODE_TYPES.imageEdit ||
        targetNode?.type === CANVAS_NODE_TYPES.aiVideo ||
        targetNode?.type === CANVAS_NODE_TYPES.aiText;
      const isTextPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.textAnnotation;

      const mediaFile = clipboardContent.mediaFile ?? clipboardContent.imageFile;
      const imageFile = clipboardContent.imageFile ?? (isImageFile(mediaFile) ? mediaFile : null);
      const materialFile = mediaFile ?? imageFile;

      if (
        materialFile &&
        pasteOptions.pasteIntoSelectedUpload &&
        targetNode?.type === CANVAS_NODE_TYPES.upload
      ) {
        canvasEventBus.publish('upload-node/paste-material', {
          nodeId: targetNode.id,
          file: materialFile,
        });
        markSystemClipboardFresh();
        return true;
      }

      if (isPromptPasteTarget && targetNode) {
        if (imageFile) {
          const handled = await pasteImageAsNodeReference(imageFile, targetNode);
          if (handled) {
            markSystemClipboardFresh();
            return true;
          }
        }
        if (mediaFile && !imageFile) {
          const handled = await pasteMaterialAsNodeReference(mediaFile, targetNode);
          if (handled) {
            markSystemClipboardFresh();
            return true;
          }
        }
        if (pasteVideoSourceAsNodeReference(clipboardContent.text, targetNode)) {
          markSystemClipboardFresh();
          return true;
        }
        if (pasteTextIntoPromptNode(targetNode, clipboardContent.text)) {
          markSystemClipboardFresh();
          return true;
        }
      }

      if (isTextPasteTarget && targetNode && pasteTextIntoTextNode(targetNode, clipboardContent.text)) {
        markSystemClipboardFresh();
        return true;
      }

      if (imageFile) {
        const createdNodeId = await optionsRef.current.createUploadImageNodeAtWorldPosition(
          imageFile,
          pasteOptions.worldPosition ?? optionsRef.current.resolvePasteWorldPosition(),
        );
        if (!createdNodeId) return false;
        markSystemClipboardFresh();
        return true;
      }

      if (mediaFile && !imageFile) {
        const created = await optionsRef.current.createMaterialNodeFromFileAtWorldPosition(
          mediaFile,
          pasteOptions.worldPosition ?? optionsRef.current.resolvePasteWorldPosition(),
        );
        if (!created) return false;
        markSystemClipboardFresh();
        return true;
      }

      if (pasteTextAsTextNode(clipboardContent.text, pasteOptions.worldPosition)) {
        markSystemClipboardFresh();
        return true;
      }

      return false;
    },
    [
      markSystemClipboardFresh,
      pasteImageAsNodeReference,
      pasteMaterialAsNodeReference,
      pasteTextAsTextNode,
      pasteTextIntoPromptNode,
      pasteTextIntoTextNode,
      pasteVideoSourceAsNodeReference,
    ],
  );

  /* ---------- 快捷键粘贴（Ctrl+V 双通道） ---------- */

  const resolveSelectedTargetNode = useCallback((): CanvasNode | null => {
    const store = useCanvasStore.getState();
    return store.selectedNodeId
      ? store.nodes.find((node) => node.id === store.selectedNodeId) ?? null
      : null;
  }, []);

  const handleShortcutPaste = useCallback(async (): Promise<boolean> => {
    const pasteSource = await resolveClipboardPasteSource();

    if (pasteSource.source === 'internal') {
      return optionsRef.current.pasteInternal(optionsRef.current.resolvePasteWorldPosition());
    }

    if (pasteSource.source !== 'system') {
      return false;
    }

    const selectedTargetNode = resolveSelectedTargetNode();
    const selectedUploadNodeId =
      selectedTargetNode?.type === CANVAS_NODE_TYPES.upload ? selectedTargetNode.id : null;

    return await pasteSystemClipboardContent(pasteSource.content, {
      targetNode: selectedTargetNode,
      worldPosition: optionsRef.current.resolvePasteWorldPosition(),
      pasteIntoSelectedUpload: Boolean(selectedUploadNodeId),
    });
  }, [pasteSystemClipboardContent, resolveClipboardPasteSource, resolveSelectedTargetNode]);

  /** keydown Ctrl+V 入口：先给 document paste 事件 40ms 窗口，未触发再走异步读取 */
  const requestShortcutPaste = useCallback(() => {
    const pasteStartedAt = Date.now();
    window.setTimeout(() => {
      if (pasteEventHandledAtRef.current >= pasteStartedAt) return;
      void handleShortcutPaste();
    }, 40);
  }, [handleShortcutPaste]);

  const pasteMediaFromClipboardEvent = useCallback(
    async (file: File) => {
      const selectedTargetNode = resolveSelectedTargetNode();
      await pasteSystemClipboardContent(
        {
          mediaFile: file,
          imageFile: isImageFile(file) ? file : null,
          text: '',
          fingerprint: `event-${resolveMediaFingerprintKind(file)}:${file.name}:${file.size}:${file.type}:${file.lastModified}`,
        },
        {
          targetNode: selectedTargetNode,
          worldPosition: optionsRef.current.resolvePasteWorldPosition(),
          pasteIntoSelectedUpload: selectedTargetNode?.type === CANVAS_NODE_TYPES.upload,
        },
      );
    },
    [pasteSystemClipboardContent, resolveSelectedTargetNode],
  );

  const pasteTextFromClipboardEvent = useCallback(
    async (text: string) => {
      const selectedTargetNode = resolveSelectedTargetNode();
      await pasteSystemClipboardContent(
        {
          mediaFile: null,
          imageFile: null,
          text,
          fingerprint: `event-text:${text.trim().length}:${hashText(text.trim())}`,
        },
        {
          targetNode: selectedTargetNode,
          worldPosition: optionsRef.current.resolvePasteWorldPosition(),
        },
      );
    },
    [pasteSystemClipboardContent, resolveSelectedTargetNode],
  );

  const shouldHandleClipboardEventPaste = useCallback(
    async (payload: { mediaFile?: File | null; imageFile: File | null; text: string }) => {
      const internalSnapshot = optionsRef.current.getInternalSnapshot();
      const internalSnapshotIsFresh =
        clipboardFreshnessRef.current === 'internal' && Boolean(internalSnapshot?.nodes.length);

      if (!internalSnapshotIsFresh) return true;

      const settledInternalBaseline = await settleInternalBaseline();
      if (settledInternalBaseline === undefined) return false;

      const eventFingerprint = payload.mediaFile
        ? await fingerprintMediaFile(payload.mediaFile)
        : payload.imageFile
          ? await fingerprintMediaFile(payload.imageFile)
          : fingerprintClipboardContent({ text: payload.text });

      return Boolean(eventFingerprint && eventFingerprint !== settledInternalBaseline);
    },
    [settleInternalBaseline],
  );

  /* ---------- document paste 事件通道 ---------- */

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return;

      const mediaFile = resolveClipboardMediaFile(event);
      const imageFile =
        mediaFile && isImageFile(mediaFile) ? mediaFile : resolveClipboardImageFile(event);
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!mediaFile && !imageFile && !text) return;

      event.preventDefault();
      pasteEventHandledAtRef.current = Date.now();

      void (async () => {
        let shouldHandle = true;
        try {
          shouldHandle = await shouldHandleClipboardEventPaste({ mediaFile, imageFile, text });
        } catch (error) {
          console.warn('Failed to classify clipboard paste event', error);
        }

        if (!shouldHandle) {
          void handleShortcutPaste();
          return;
        }

        markSystemClipboardFresh();

        const materialFile = mediaFile ?? imageFile;
        const selectedTargetNode = resolveSelectedTargetNode();
        if (materialFile && selectedTargetNode?.type === CANVAS_NODE_TYPES.upload) {
          canvasEventBus.publish('upload-node/paste-material', {
            nodeId: selectedTargetNode.id,
            file: materialFile,
          });
          return;
        }

        if (materialFile) {
          void pasteMediaFromClipboardEvent(materialFile);
          return;
        }

        if (text) {
          void pasteTextFromClipboardEvent(text);
        }
      })();
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [
    handleShortcutPaste,
    markSystemClipboardFresh,
    pasteMediaFromClipboardEvent,
    pasteTextFromClipboardEvent,
    resolveSelectedTargetNode,
    shouldHandleClipboardEventPaste,
  ]);

  /* ---------- 右键菜单粘贴（决策树与旧版一致） ---------- */

  const handleContextMenuPaste = useCallback(
    async (state: ContextMenuPasteState) => {
      const targetNode = state.nodeId
        ? useCanvasStore.getState().nodes.find((node) => node.id === state.nodeId) ?? null
        : null;

      const nodeMap = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node] as const));
      const pasteWorldPosition =
        targetNode &&
        (targetNode.type === CANVAS_NODE_TYPES.upload ||
          targetNode.type === CANVAS_NODE_TYPES.exportImage ||
          targetNode.type === CANVAS_NODE_TYPES.video ||
          targetNode.type === CANVAS_NODE_TYPES.audio)
          ? (() => {
              const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
              const size = getNodeSize(targetNode);
              return { x: absolute.x + size.width + 80, y: absolute.y };
            })()
          : state.worldPosition;

      const clipboardContent = await readClipboardContent({ avoidBrowserApiWhenTauriAvailable: true });

      const internalSnapshot = optionsRef.current.getInternalSnapshot();
      const internalSnapshotIsFresh =
        clipboardFreshnessRef.current === 'internal' && Boolean(internalSnapshot?.nodes.length);

      let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
      if (internalSnapshotIsFresh && settledInternalBaseline === undefined) {
        settledInternalBaseline = await settleInternalBaseline();
      }

      const clipboardHasPayload = hasClipboardPayload(clipboardContent);
      const clipboardReadCanConfirmEmpty = !clipboardContent.readFailed;
      const clipboardMatchesSettledInternalBaseline =
        internalSnapshotIsFresh &&
        settledInternalBaseline !== undefined &&
        clipboardContent.fingerprint === settledInternalBaseline;
      const clipboardCanConfirmSettledInternalBaseline =
        clipboardMatchesSettledInternalBaseline &&
        (clipboardHasPayload || clipboardReadCanConfirmEmpty);

      if (clipboardHasPayload && !clipboardCanConfirmSettledInternalBaseline) {
        await pasteSystemClipboardContent(clipboardContent, {
          targetNode,
          worldPosition: pasteWorldPosition,
        });
        return;
      }

      if (clipboardContent.readFailed && !clipboardCanConfirmSettledInternalBaseline) {
        return;
      }

      if (internalSnapshotIsFresh) {
        optionsRef.current.pasteInternal(pasteWorldPosition);
        return;
      }

      const isPromptPasteTarget =
        targetNode?.type === CANVAS_NODE_TYPES.imageEdit ||
        targetNode?.type === CANVAS_NODE_TYPES.aiVideo ||
        targetNode?.type === CANVAS_NODE_TYPES.aiText;

      if (!isPromptPasteTarget && clipboardFreshnessRef.current !== 'system') {
        optionsRef.current.pasteInternal(pasteWorldPosition);
      }
    },
    [pasteSystemClipboardContent, settleInternalBaseline],
  );

  return useMemo(
    () => ({
      noteInternalCopy,
      markSystemClipboardFresh,
      requestShortcutPaste,
      handleShortcutPaste,
      handleContextMenuPaste,
    }),
    [
      noteInternalCopy,
      markSystemClipboardFresh,
      requestShortcutPaste,
      handleShortcutPaste,
      handleContextMenuPaste,
    ],
  );
}
