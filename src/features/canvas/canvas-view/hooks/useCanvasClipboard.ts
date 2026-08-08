import { useCallback, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { isImageFile } from '@/features/canvas/application/imageDragDrop';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  fingerprintClipboardContent,
  fingerprintImageFile,
  fingerprintMediaFile,
  hasClipboardPayload,
  hashText,
  readClipboardContent,
  resolveMediaFingerprintKind,
  syncSingleCanvasNodeToSystemClipboard,
} from '../utils/clipboard';
import {
  buildDuplicateEdge,
  cloneNodeData,
  collectNodeIdsWithDescendants,
  getNodeSize,
  getSnapshotBounds,
  hasRectCollision,
  isLikelyVideoSourceText,
  resolveAbsoluteNodePosition,
  sortNodesForDuplication,
} from '../utils/node-helpers';
import type {
  CanvasClipboardSnapshot,
  ClipboardContentReadResult,
  ClipboardFreshnessSource,
  ClipboardPasteSource,
  DuplicateOptions,
  DuplicateResult,
  NodeContextMenuState,
  SystemClipboardPasteOptions,
} from '../types';

interface UseCanvasClipboardOptions {
  wrapperRef: { current: HTMLDivElement | null };
  lastCanvasPointerRef: { current: { x: number; y: number } | null };
  nodeContextMenu: NodeContextMenuState | null;
  setNodeContextMenu: (state: NodeContextMenuState | null) => void;
  scheduleCanvasPersist: (delay?: number) => void;
  createUploadImageNodeAtFlowPosition: (file: File, flowPosition: { x: number; y: number }) => Promise<string | null>;
  createUploadImageNodeAtClientPosition: (file: File, clientPosition: { x: number; y: number }) => Promise<void>;
  createMaterialNodeFromFileAtFlowPosition: (file: File, flowPosition: { x: number; y: number }) => Promise<{ nodeId: string; type: CanvasNodeType } | null>;
  createMaterialNodeFromFileAtClientPosition: (file: File, clientPosition: { x: number; y: number }) => Promise<{ nodeId: string; type: CanvasNodeType } | null>;
}

export function useCanvasClipboard({
  wrapperRef,
  lastCanvasPointerRef,
  nodeContextMenu,
  setNodeContextMenu,
  scheduleCanvasPersist,
  createUploadImageNodeAtFlowPosition,
  createUploadImageNodeAtClientPosition,
  createMaterialNodeFromFileAtFlowPosition,
  createMaterialNodeFromFileAtClientPosition,
}: UseCanvasClipboardOptions) {
  const reactFlowInstance = useReactFlow();
  const nodes = useCanvasStore((state) => state.nodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);

  const pasteIterationRef = useRef(0);
  const copiedSnapshotRef = useRef<CanvasClipboardSnapshot | null>(null);
  const clipboardFreshnessRef = useRef<ClipboardFreshnessSource>(null);
  const systemClipboardFingerprintAtInternalCopyRef = useRef<string | null | undefined>(null);
  const systemClipboardFingerprintCaptureRef = useRef<Promise<string | null> | null>(null);

  const selectedUploadNodeId = useMemo(() => {
    const selected = nodes.filter((node) => Boolean(node.selected));
    if (selected.length !== 1) {
      return null;
    }
    const node = selected[0];
    return node.type === CANVAS_NODE_TYPES.upload ? node.id : null;
  }, [nodes]);

  const resolveShortcutPasteFlowPosition = useCallback(() => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const clientPosition = lastCanvasPointerRef.current ?? (
      containerRect
        ? {
            x: containerRect.left + containerRect.width / 2,
            y: containerRect.top + containerRect.height / 2,
          }
        : {
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          }
    );
    return reactFlowInstance.screenToFlowPosition(clientPosition);
  }, [lastCanvasPointerRef, reactFlowInstance, wrapperRef]);

  const pasteImageAtCanvasPosition = useCallback(
    async (file: File) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerRef.current ?? (
        containerRect
          ? {
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + containerRect.height / 2,
            }
          : {
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            }
      );
      await createUploadImageNodeAtClientPosition(file, clientPosition);
    },
    [createUploadImageNodeAtClientPosition, lastCanvasPointerRef, wrapperRef]
  );

  const pasteMaterialAtCanvasPosition = useCallback(
    async (file: File) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerRef.current ?? (
        containerRect
          ? {
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + containerRect.height / 2,
            }
          : {
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            }
      );
      await createMaterialNodeFromFileAtClientPosition(file, clientPosition);
    },
    [createMaterialNodeFromFileAtClientPosition, lastCanvasPointerRef, wrapperRef]
  );

  const createClipboardSnapshot = useCallback(
    (sourceNodeIds: string[]): CanvasClipboardSnapshot | null => {
      const expandedIds = collectNodeIdsWithDescendants(nodes, sourceNodeIds);
      if (expandedIds.length === 0) {
        return null;
      }
      const sourceIdSet = new Set(expandedIds);
      const snapshotNodes = nodes
        .filter((node) => sourceIdSet.has(node.id))
        .map((node) => cloneNodeData(node));
      if (snapshotNodes.length === 0) {
        return null;
      }
      return {
        nodes: snapshotNodes,
        edges: nodes.length >= 0
          ? useCanvasStore.getState().edges
              .filter((edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target))
              .map((edge) => cloneNodeData(edge))
          : [],
      };
    },
    [nodes]
  );

  const copyNodesToClipboard = useCallback(
    (sourceNodeIds: string[]) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      copiedSnapshotRef.current = snapshot;
      if (snapshot?.nodes.length) {
        clipboardFreshnessRef.current = 'internal';
        pasteIterationRef.current = 0;
        systemClipboardFingerprintAtInternalCopyRef.current = undefined;
        const capture = syncSingleCanvasNodeToSystemClipboard(snapshot, nodes).catch((error) => {
          console.warn('Failed to capture clipboard freshness baseline', error);
          return null;
        });
        systemClipboardFingerprintCaptureRef.current = capture;
        void capture.then((fingerprint) => {
          if (
            systemClipboardFingerprintCaptureRef.current === capture
            && copiedSnapshotRef.current === snapshot
            && clipboardFreshnessRef.current === 'internal'
          ) {
            systemClipboardFingerprintAtInternalCopyRef.current = fingerprint;
          }
        });
      }
    },
    [createClipboardSnapshot, nodes]
  );

  const markSystemClipboardFresh = useCallback(() => {
    clipboardFreshnessRef.current = 'system';
    systemClipboardFingerprintAtInternalCopyRef.current = null;
    systemClipboardFingerprintCaptureRef.current = null;
  }, []);

  const resolveClipboardPasteSource = useCallback(async (): Promise<ClipboardPasteSource> => {
    const hasInternalSnapshot = Boolean(copiedSnapshotRef.current?.nodes.length);
    const internalIsFresh = clipboardFreshnessRef.current === 'internal' && hasInternalSnapshot;
    const clipboardContent = await readClipboardContent();
    if (internalIsFresh) {
      let baselineFingerprint = systemClipboardFingerprintAtInternalCopyRef.current;
      const capture = systemClipboardFingerprintCaptureRef.current;
      if (baselineFingerprint === undefined && capture) {
        baselineFingerprint = await capture;
        if (systemClipboardFingerprintCaptureRef.current === capture) {
          systemClipboardFingerprintAtInternalCopyRef.current = baselineFingerprint;
        }
      }
      if (
        clipboardContent.fingerprint
        && baselineFingerprint !== undefined
        && clipboardContent.fingerprint !== baselineFingerprint
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
  }, [markSystemClipboardFresh]);

  const duplicateSnapshot = useCallback(
    (snapshot: CanvasClipboardSnapshot, options: DuplicateOptions = {}): DuplicateResult | null => {
      const sourceNodes = sortNodesForDuplication(snapshot.nodes);
      if (sourceNodes.length === 0) {
        return null;
      }
      const sourceNodeMap = new Map(sourceNodes.map((node) => [node.id, node] as const));
      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = snapshot.edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      );
      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];
      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        const absolute = resolveAbsoluteNodePosition(node, sourceNodeMap);
        return !hasRectCollision(
          {
            x: absolute.x + offset.x + offsetStep * 8,
            y: absolute.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });
      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }
      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('isStreaming' in (data as Record<string, unknown>)) {
          (data as { isStreaming?: boolean }).isStreaming = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }
        if ('generationRetryResultUrl' in (data as Record<string, unknown>)) {
          (data as { generationRetryResultUrl?: string | null }).generationRetryResultUrl = null;
        }
        const copiedParentId = sourceNode.parentId && sourceIdSet.has(sourceNode.parentId)
          ? sourceNode.parentId
          : null;
        const absolute = resolveAbsoluteNodePosition(sourceNode, sourceNodeMap);
        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          copiedParentId
            ? sourceNode.position
            : {
                x: absolute.x + chosenOffset.x + offsetStep * 8,
                y: absolute.y + chosenOffset.y + offsetStep * 6,
              },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }
      const sizeSyncChanges: NodeChange<CanvasNode>[] = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          const sourceEntry = Array.from(idMap.entries()).find(([, copyId]) => copyId === currentNode.id);
          if (!sourceEntry) {
            return currentNode;
          }
          const [sourceId] = sourceEntry;
          const sourceNode = sourceNodeMap.get(sourceId);
          if (!sourceNode) {
            return currentNode;
          }
          const copiedParentId = sourceNode.parentId ? idMap.get(sourceNode.parentId) : undefined;
          const sourceStyle = sourceNode.style && typeof sourceNode.style === 'object'
            ? cloneNodeData(sourceNode.style)
            : undefined;
          return {
            ...currentNode,
            parentId: copiedParentId,
            extent: copiedParentId ? (sourceNode.extent ?? 'parent') : undefined,
            selected: false,
            style: {
              ...(currentNode.style ?? {}),
              ...(sourceStyle ?? {}),
            },
          };
        }),
      }));
      if (internalEdges.length > 0) {
        useCanvasStore.setState((state) => {
          const existingEdgeIds = new Set(state.edges.map((edge) => edge.id));
          const duplicatedEdges = internalEdges
            .map((edge) => {
              const nextSource = idMap.get(edge.source);
              const nextTarget = idMap.get(edge.target);
              if (!nextSource || !nextTarget) {
                return null;
              }
              return buildDuplicateEdge(edge, nextSource, nextTarget, existingEdgeIds);
            })
            .filter((edge): edge is CanvasEdge => Boolean(edge));
          if (duplicatedEdges.length === 0) {
            return state;
          }
          return {
            edges: [...state.edges, ...duplicatedEdges],
          };
        });
      }
      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}): DuplicateResult | null => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      if (!snapshot) {
        return null;
      }
      return duplicateSnapshot(snapshot, options);
    },
    [createClipboardSnapshot, duplicateSnapshot]
  );

  const pasteCopiedNodes = useCallback(
    (flowPosition?: { x: number; y: number }): DuplicateResult | null => {
      const snapshot = copiedSnapshotRef.current;
      if (!snapshot || snapshot.nodes.length === 0) {
        return null;
      }
      const bounds = flowPosition ? getSnapshotBounds(snapshot) : null;
      const targetOffset = flowPosition && bounds
        ? {
            x: flowPosition.x - bounds.minX,
            y: flowPosition.y - bounds.minY,
          }
        : null;
      return duplicateSnapshot(
        snapshot,
        targetOffset
          ? {
              explicitOffset: targetOffset,
              disableOffsetIteration: true,
            }
          : undefined
      );
    },
    [duplicateSnapshot]
  );

  const pasteImageAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const uploadNodeId = await createUploadImageNodeAtFlowPosition(file, {
        x: targetNode.position.x - 300,
        y: targetNode.position.y,
      });
      if (!uploadNodeId) {
        return false;
      }
      addEdge(uploadNodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [addEdge, createUploadImageNodeAtFlowPosition, scheduleCanvasPersist]
  );

  const pasteMaterialAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const created = await createMaterialNodeFromFileAtFlowPosition(file, {
        x: targetNode.position.x - 300,
        y: targetNode.position.y,
      });
      if (!created) {
        return false;
      }
      addEdge(created.nodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [addEdge, createMaterialNodeFromFileAtFlowPosition, scheduleCanvasPersist]
  );

  const pasteVideoSourceAsNodeReference = useCallback(
    (videoSource: string, targetNode: CanvasNode) => {
      const trimmedSource = videoSource.trim();
      if (!isLikelyVideoSourceText(trimmedSource)) {
        return false;
      }
      const videoNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        {
          x: targetNode.position.x - 300,
          y: targetNode.position.y,
        },
        {
          videoUrl: trimmedSource,
          localVideoUrl: trimmedSource.startsWith('http://') || trimmedSource.startsWith('https://')
            ? null
            : trimmedSource,
          thumbnailUrl: null,
          isGenerating: false,
          sourcePrompt: '',
        }
      );
      addEdge(videoNodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [addEdge, addNode, scheduleCanvasPersist]
  );

  const pasteTextIntoPromptNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const data = targetNode.data as { prompt?: unknown };
      const currentPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
      updateNodeData(targetNode.id, {
        prompt: currentPrompt ? `${currentPrompt}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist, updateNodeData]
  );

  const pasteTextIntoTextNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      if (targetNode.type !== CANVAS_NODE_TYPES.textAnnotation) {
        return false;
      }
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const currentContent = (targetNode.data as { content?: unknown }).content;
      const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
      updateNodeData(targetNode.id, {
        content: normalizedCurrent ? `${normalizedCurrent}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist, updateNodeData]
  );

  const pasteTextAsTextNode = useCallback(
    (text: string, flowPosition?: { x: number; y: number }) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        flowPosition ?? resolveShortcutPasteFlowPosition(),
        {
          content: trimmedText,
        }
      );
      scheduleCanvasPersist(0);
      return true;
    },
    [addNode, resolveShortcutPasteFlowPosition, scheduleCanvasPersist]
  );

  const pasteSystemClipboardContent = useCallback(
    async (
      clipboardContent: ClipboardContentReadResult,
      options: SystemClipboardPasteOptions
    ) => {
      const targetNode = options.targetNode;
      const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
        || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
        || targetNode?.type === CANVAS_NODE_TYPES.aiText;
      const isTextPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.textAnnotation;
      const mediaFile = clipboardContent.mediaFile ?? clipboardContent.imageFile;
      const imageFile = clipboardContent.imageFile ?? (isImageFile(mediaFile) ? mediaFile : null);
      const materialFile = mediaFile ?? imageFile;
      if (materialFile && options.pasteIntoSelectedUpload && targetNode?.type === CANVAS_NODE_TYPES.upload) {
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
        if (options.flowPosition) {
          const createdNodeId = await createUploadImageNodeAtFlowPosition(imageFile, options.flowPosition);
          if (createdNodeId) {
            markSystemClipboardFresh();
            return true;
          }
          return false;
        }
        await pasteImageAtCanvasPosition(imageFile);
        markSystemClipboardFresh();
        return true;
      }
      if (mediaFile && !imageFile) {
        if (options.flowPosition) {
          const created = await createMaterialNodeFromFileAtFlowPosition(mediaFile, options.flowPosition);
          if (created) {
            markSystemClipboardFresh();
            return true;
          }
          return false;
        }
        await pasteMaterialAtCanvasPosition(mediaFile);
        markSystemClipboardFresh();
        return true;
      }
      if (pasteTextAsTextNode(clipboardContent.text, options.flowPosition)) {
        markSystemClipboardFresh();
        return true;
      }
      return false;
    },
    [
      createMaterialNodeFromFileAtFlowPosition,
      createUploadImageNodeAtFlowPosition,
      markSystemClipboardFresh,
      pasteImageAsNodeReference,
      pasteImageAtCanvasPosition,
      pasteMaterialAsNodeReference,
      pasteMaterialAtCanvasPosition,
      pasteTextAsTextNode,
      pasteTextIntoPromptNode,
      pasteTextIntoTextNode,
      pasteVideoSourceAsNodeReference,
    ]
  );

  const handleShortcutPaste = useCallback(async () => {
    const pasteSource = await resolveClipboardPasteSource();
    if (pasteSource.source === 'internal') {
      return Boolean(pasteCopiedNodes(resolveShortcutPasteFlowPosition()));
    }
    if (pasteSource.source !== 'system') {
      return false;
    }
    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    return await pasteSystemClipboardContent(pasteSource.content, {
      targetNode: selectedTargetNode,
      flowPosition: resolveShortcutPasteFlowPosition(),
      pasteIntoSelectedUpload: Boolean(
        selectedUploadNodeId && selectedTargetNode?.id === selectedUploadNodeId
      ),
    });
  }, [
    pasteCopiedNodes,
    pasteSystemClipboardContent,
    resolveClipboardPasteSource,
    resolveShortcutPasteFlowPosition,
    selectedNodeId,
    selectedUploadNodeId,
  ]);

  const pasteMediaFromClipboardEvent = useCallback(async (file: File) => {
    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    await pasteSystemClipboardContent(
      {
        mediaFile: file,
        imageFile: isImageFile(file) ? file : null,
        text: '',
        fingerprint: `event-${resolveMediaFingerprintKind(file)}:${file.name}:${file.size}:${file.type}:${file.lastModified}`,
      },
      {
        targetNode: selectedTargetNode,
        pasteIntoSelectedUpload: Boolean(
          selectedUploadNodeId && selectedTargetNode?.id === selectedUploadNodeId
        ),
      }
    );
  }, [pasteSystemClipboardContent, selectedNodeId, selectedUploadNodeId]);

  const pasteImageFromClipboardEvent = useCallback(
    async (file: File) => {
      await pasteMediaFromClipboardEvent(file);
    },
    [pasteMediaFromClipboardEvent]
  );

  const pasteTextFromClipboardEvent = useCallback(async (text: string) => {
    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    await pasteSystemClipboardContent(
      {
        mediaFile: null,
        imageFile: null,
        text,
        fingerprint: `event-text:${text.trim().length}:${hashText(text.trim())}`,
      },
      {
        targetNode: selectedTargetNode,
        flowPosition: resolveShortcutPasteFlowPosition(),
      }
    );
  }, [pasteSystemClipboardContent, resolveShortcutPasteFlowPosition, selectedNodeId]);

  const shouldHandleClipboardEventPaste = useCallback(async (payload: {
    mediaFile?: File | null;
    imageFile: File | null;
    text: string;
  }) => {
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    if (!internalSnapshotIsFresh) {
      return true;
    }
    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }
    if (settledInternalBaseline === undefined) {
      return false;
    }
    const eventFingerprint = payload.mediaFile
      ? await fingerprintMediaFile(payload.mediaFile)
      : payload.imageFile
        ? await fingerprintImageFile(payload.imageFile)
        : fingerprintClipboardContent({ text: payload.text });
    return Boolean(eventFingerprint && eventFingerprint !== settledInternalBaseline);
  }, []);

  const handleContextMenuPaste = useCallback(async () => {
    const menuState = nodeContextMenu;
    if (!menuState) {
      return;
    }
    setNodeContextMenu(null);
    const targetNode = menuState.nodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === menuState.nodeId) ?? null
      : null;
    const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
      || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
      || targetNode?.type === CANVAS_NODE_TYPES.aiText;
    const pasteFlowPosition = targetNode && (
      targetNode.type === CANVAS_NODE_TYPES.upload
      || targetNode.type === CANVAS_NODE_TYPES.exportImage
      || targetNode.type === CANVAS_NODE_TYPES.video
      || targetNode.type === CANVAS_NODE_TYPES.audio
    )
      ? (() => {
          const nodeMap = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node] as const));
          const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
          const size = getNodeSize(targetNode);
          return {
            x: absolute.x + size.width + 80,
            y: absolute.y,
          };
        })()
      : menuState.flowPosition;
    const clipboardContent = await readClipboardContent({ avoidBrowserApiWhenTauriAvailable: true });
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (internalSnapshotIsFresh && settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }
    const clipboardHasPayload = hasClipboardPayload(clipboardContent);
    const clipboardReadCanConfirmEmpty = !clipboardContent.readFailed;
    const clipboardMatchesSettledInternalBaseline = internalSnapshotIsFresh
      && settledInternalBaseline !== undefined
      && clipboardContent.fingerprint === settledInternalBaseline;
    const clipboardCanConfirmSettledInternalBaseline = clipboardMatchesSettledInternalBaseline
      && (clipboardHasPayload || clipboardReadCanConfirmEmpty);
    if (clipboardHasPayload && !clipboardCanConfirmSettledInternalBaseline) {
      await pasteSystemClipboardContent(clipboardContent, {
        targetNode,
        flowPosition: pasteFlowPosition,
      });
      return;
    }
    if (clipboardContent.readFailed && !clipboardCanConfirmSettledInternalBaseline) {
      return;
    }
    if (internalSnapshotIsFresh) {
      pasteCopiedNodes(pasteFlowPosition);
      return;
    }
    if (!isPromptPasteTarget && clipboardFreshnessRef.current !== 'system') {
      pasteCopiedNodes(pasteFlowPosition);
    }
  }, [
    nodeContextMenu,
    pasteCopiedNodes,
    pasteSystemClipboardContent,
    setNodeContextMenu,
  ]);

  return {
    copyNodesToClipboard,
    markSystemClipboardFresh,
    duplicateNodes,
    pasteCopiedNodes,
    pasteImageAtCanvasPosition,
    handleShortcutPaste,
    pasteImageFromClipboardEvent,
    pasteMediaFromClipboardEvent,
    pasteTextFromClipboardEvent,
    shouldHandleClipboardEventPaste,
    handleContextMenuPaste,
  };
}