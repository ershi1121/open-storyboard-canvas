import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { X } from 'lucide-react';
import type { NodeChange, Viewport } from '@/features/canvas/domain/graphTypes';
import type { CanvasViewportHost } from '@/features/canvas/hooks/useCanvasPersistence';

import { resolveFreeNodePosition, useCanvasStore, type CanvasNode } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import { useSnapStore } from '@/stores/snapStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { useMaterialImport } from '@/features/canvas/hooks/useMaterialImport';
import { useCanvasSystemClipboard } from '@/features/canvas/hooks/useCanvasSystemClipboard';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  getGeneratedTextForConnection,
  resolveAllowedNodeTypes,
} from '@/features/canvas/shared/utils/node-helpers';
import { NodeSelectionMenu } from '@/features/canvas/NodeSelectionMenu';
import { BatchToolbar } from '@/features/canvas/shared/components/BatchToolbar';
import { resolveBatchToolbarState, type BatchToolbarState } from '@/features/canvas/domain/batchToolbar';
import { ContextMenu } from '@/features/canvas/shared/components/ContextMenu';
import type { NodeContextMenuState } from '@/features/canvas/shared/types';
import { SnapToggle } from '@/features/canvas/shared/components/SnapToggle';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';
import { SelectedNodeOverlay } from '@/features/canvas/ui/SelectedNodeOverlay';
import { NodeToolDialog } from '@/features/canvas/ui/NodeToolDialog';
import { AssetPanel, type CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { CanvasSideToolbar } from '@/features/canvas/CanvasSideToolbar';
import { nodeTypes } from '@/features/canvas/nodes';
import { withNodeRenderErrorBoundary } from '@/features/canvas/nodes/NodeRenderErrorBoundary';
import { extractCanvasAssets } from '@/features/canvas/shared/utils/assets';
import { HiddenHostContext, NodeHostIdContext } from '@/features/canvas/compat/nodeHostApi';
import { registerCanvas2DEngine, useViewportSnapshotStore } from '@/features/canvas/compat/engineBridge';
import { buildSceneModel, type SceneModel } from './sceneModel';
import { DomIslands } from './DomIslands';
import { isSoftwareRaster, probeRasterBackend } from './gpuProbe';
import { filterDragDescendants } from './spatialGrid';
import { Canvas2DEngine, type ConnectHandleType, type EngineStats, type ViewportLike } from './engine';

/**
 * Canvas2D 画布视图 —— 本项目唯一渲染引擎。
 *
 * 设计原则：手势期间零 store 写入、零 React 渲染；手势结束一次性 commit。
 * 共享基础设施：canvasStore 文档模型、useCanvasPersistence 持久化、
 * useCanvasGenerationPolling 生成轮询、撤销历史、NodeSelectionMenu /
 * ContextMenu / ImageViewerModal / SnapToggle / AssetPanel 等 DOM 组件。
 *
 * 画布交互：平移/缩放/全览、拖拽（分组带子节点、Alt 复制、磁吸对齐参考线、
 * 贴合节点跟随移动）、Shift 多选、右键/Ctrl 框选、连接桩拖拽连线（落空白弹
 * 新建菜单）、单节点右下角缩放、右键菜单（复制/粘贴/删除/文本生图）、双击
 * 看图/标签跳源/空白建节点、内部剪贴板（Ctrl+C/V）、系统剪贴板图片/媒体/
 * 文本粘贴（Ctrl+V 双通道 + 目标节点规则）、素材文件拖入（OS 文件/本地路径）、
 * Ctrl+A 全选、Ctrl+G 打组/解组、WASD 平移、小地图导航、多选批量工具条
 * （复制/打组/解组/批量触发/删除，批量触发经 HiddenTriggerHost 补齐订阅）。
 *
 * 节点编辑：视口内节点以 DOM 岛内嵌原版编辑组件（与旧版画布内编辑一致，
 * 无右侧检视面板；仅岛层整体异常时回退启用 NodeInspector 兜底），
 * SelectedNodeOverlay / NodeToolDialog / CanvasSideToolbar / AssetPanel
 * 全套面板生态可用。
 */

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const MAX_HISTORY_STEPS = 50;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function viewportEquals(a: ViewportLike | null | undefined, b: ViewportLike | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom - b.zoom) < 0.0001;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface NodeMenuState {
  position: { x: number; y: number };
  allowedTypes: CanvasNodeType[] | undefined;
  pendingConnect: { nodeId: string; handleType: ConnectHandleType } | null;
  worldPos: { x: number; y: number };
}

export function Canvas2DView() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Canvas2DEngine | null>(null);
  const modelRef = useRef<SceneModel | null>(null);
  const lastEmittedSelectionRef = useRef<string | null>(null);
  const lastCommittedViewportRef = useRef<ViewportLike | null>(null);
  const lastPointerLocalRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const schedulePersistRef = useRef<(delayMs?: number) => void>(() => {});
  const prevSlowFramesRef = useRef(0);
  const diagAutoOpenedRef = useRef(false);
  const clipboardRef = useRef<ClipboardSnapshot | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [islandCount, setIslandCount] = useState(0);
  const [rasterBackend] = useState(() => probeRasterBackend());
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [contextMenu, setContextMenu] = useState<NodeContextMenuState | null>(null);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [assetButtonRect, setAssetButtonRect] = useState<DOMRect | null>(null);
  /** 引擎多选集合的 React 镜像（仅在选区变更回调时更新，手势期间零写入） */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 批量触发时隐藏挂载的节点编辑组件 id（订阅 generation-node/trigger 用） */
  const [triggerHostIds, setTriggerHostIds] = useState<string[]>([]);
  /** DOM 岛层整体异常时回退启用检视面板（正常路径不渲染侧栏） */
  const [islandsBroken, setIslandsBroken] = useState(false);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const currentViewport = useCanvasStore((state) => state.currentViewport);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const theme = useThemeStore((state) => state.theme);
  const snapEnabled = useSnapStore((state) => state.snapEnabled);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const enableCanvasWasdPan = useSettingsStore((state) => state.enableCanvasWasdPan);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  const canvasWasdPanSensitivity = useSettingsStore((state) => state.canvasWasdPanSensitivity);

  /* ---------- 持久化（与旧版共用同一套 hook，传入视口适配器） ---------- */
  const persistenceAdapter = useMemo(
    () =>
      ({
        getViewport: (): Viewport => {
          const live = engineRef.current?.getViewport();
          return live
            ? { x: live.x, y: live.y, zoom: live.zoom }
            : useCanvasStore.getState().currentViewport ?? DEFAULT_VIEWPORT;
        },
        setViewport: (viewport: Viewport) => {
          useCanvasStore.getState().setViewportState(viewport);
        },
      }) satisfies CanvasViewportHost,
    [],
  );
  const { scheduleCanvasPersist } = useCanvasPersistence(persistenceAdapter);
  schedulePersistRef.current = scheduleCanvasPersist;

  useCanvasGenerationPolling(nodes, apiKeys);

  /* ---------- 素材拖入（OS 文件 / 本地路径文本 → 上传/视频/音频节点） ---------- */
  const materialImport = useMaterialImport({ scheduleCanvasPersist });

  /* ---------- 系统剪贴板（图片/媒体/文本粘贴 + 单节点复制同步） ---------- */
  const resolvePasteWorldPosition = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      const local = lastPointerLocalRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const lx = rect && (local.x <= 0 || local.y <= 0 || local.x >= rect.width || local.y >= rect.height)
        ? { x: rect.width / 2, y: rect.height / 2 }
        : local;
      return engine.toWorld(lx.x, lx.y);
    }
    const vp = useCanvasStore.getState().currentViewport ?? DEFAULT_VIEWPORT;
    return {
      x: (window.innerWidth / 2 - vp.x) / vp.zoom,
      y: (window.innerHeight / 2 - vp.y) / vp.zoom,
    };
  }, []);
  const systemClipboard = useCanvasSystemClipboard({
    resolvePasteWorldPosition,
    getInternalSnapshot: () => clipboardRef.current,
    pasteInternal: (worldPos) => pasteAtWorld(worldPos),
    createUploadImageNodeAtWorldPosition: materialImport.createUploadImageNodeAtWorldPosition,
    createMaterialNodeFromFileAtWorldPosition: materialImport.createMaterialNodeFromFileAtWorldPosition,
    scheduleCanvasPersist,
  });

  const handleIslandsChange = useCallback((next: ReadonlySet<string>) => {
    setIslandCount(next.size);
  }, []);
  const handleIslandsFallback = useCallback(() => setIslandsBroken(true), []);

  /* ---------- 渲染模型 ---------- */
  const model = useMemo(
    () => buildSceneModel(nodes, edges, { resolveUrl: resolveImageDisplayUrl }),
    [nodes, edges],
  );
  modelRef.current = model;

  /* ---------- 资产面板（浏览模式） ---------- */
  const assetItems = useMemo(
    () => (assetPanelOpen ? extractCanvasAssets(nodes) : []),
    [assetPanelOpen, nodes],
  );
  const handleOpenAssets = useCallback((buttonRect: DOMRect) => {
    setAssetButtonRect(buttonRect);
    setAssetPanelOpen((open) => !open);
  }, []);
  const handleAssetActivate = useCallback((asset: CanvasAssetItem) => {
    setAssetPanelOpen(false);
    const rawUrl = 'imageUrl' in asset ? asset.imageUrl : '';
    if (!rawUrl) return;
    const url = resolveImageDisplayUrl(rawUrl);
    useCanvasStore.getState().openImageViewer(url, [url]);
  }, []);

  /* ---------- 工具对话框事件总线 ---------- */
  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });
    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  /* ---------- 复制/粘贴（内部剪贴板） ---------- */

  const expandWithDescendants = useCallback((ids: string[], source: CanvasNode[]): string[] => {
    const idSet = new Set(ids);
    const out = [...ids];
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of source) {
        if (node.parentId && idSet.has(node.parentId) && !idSet.has(node.id)) {
          idSet.add(node.id);
          out.push(node.id);
          changed = true;
        }
      }
    }
    return out;
  }, []);

  const absoluteOf = useCallback((node: CanvasNode, byId: Map<string, CanvasNode>): { x: number; y: number } => {
    let x = node.position.x;
    let y = node.position.y;
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      x += parent.position.x;
      y += parent.position.y;
      parentId = parent.parentId;
    }
    return { x, y };
  }, []);

  /**
   * 复制一组节点（含内部连线）。forDrag=true 时把撤销快照挂到
   * dragHistorySnapshot（拖拽结束统一入历史），否则立即压栈。
   */
  const duplicateSnapshot = useCallback(
    (snapshot: ClipboardSnapshot, offset: { x: number; y: number }, forDrag: boolean): string[] => {
      const store = useCanvasStore.getState();
      const storeById = new Map(store.nodes.map((node) => [node.id, node]));
      const snapIds = new Set(snapshot.nodes.map((node) => node.id));
      const snapById = new Map(snapshot.nodes.map((node) => [node.id, node]));
      const depthOf = (node: CanvasNode): number => {
        let depth = 0;
        let parentId = node.parentId;
        const visited = new Set<string>([node.id]);
        while (parentId && snapIds.has(parentId) && !visited.has(parentId)) {
          visited.add(parentId);
          depth++;
          parentId = snapById.get(parentId)?.parentId;
        }
        return depth;
      };
      const ordered = [...snapshot.nodes].sort((a, b) => depthOf(a) - depthOf(b));
      const idMap = new Map<string, string>();
      const clones: CanvasNode[] = [];
      const newRootIds: string[] = [];
      for (const node of ordered) {
        const newId = uuidv4();
        idMap.set(node.id, newId);
        const parentInSnapshot = node.parentId ? snapIds.has(node.parentId) : false;
        let position = { ...node.position };
        let parentId = node.parentId;
        if (parentInSnapshot && node.parentId) {
          parentId = idMap.get(node.parentId) ?? node.parentId;
        } else {
          // 根节点（或父不在快照内）：转绝对坐标 + 偏移，脱离原父
          const abs = absoluteOf(node, storeById);
          position = { x: abs.x + offset.x, y: abs.y + offset.y };
          parentId = undefined;
          newRootIds.push(newId);
        }
        clones.push({
          ...node,
          id: newId,
          position,
          parentId,
          selected: false,
          dragging: false,
        } as CanvasNode);
      }
      const newEdges: CanvasEdge[] = snapshot.edges
        .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
        .map((edge) => ({
          ...edge,
          id: uuidv4(),
          source: idMap.get(edge.source) as string,
          target: idMap.get(edge.target) as string,
        }));
      const prevSnapshot = { nodes: store.nodes, edges: store.edges };
      useCanvasStore.setState((state) => ({
        nodes: [...state.nodes, ...clones],
        edges: [...state.edges, ...newEdges],
        selectedNodeId: newRootIds[0] ?? state.selectedNodeId,
        history: forDrag
          ? state.history
          : {
              past: [...state.history.past, prevSnapshot].slice(-MAX_HISTORY_STEPS),
              future: [],
            },
        dragHistorySnapshot: forDrag ? prevSnapshot : null,
      }));
      return ordered.filter((n) => idMap.has(n.id)).map((n) => idMap.get(n.id) as string);
    },
    [absoluteOf],
  );

  const copySelection = useCallback(() => {
    const store = useCanvasStore.getState();
    const selected = engineRef.current?.getSelectedIds();
    const seeds = selected && selected.size > 0 ? [...selected] : store.selectedNodeId ? [store.selectedNodeId] : [];
    if (seeds.length === 0) return;
    const ids = new Set(expandWithDescendants(seeds, store.nodes));
    const snapNodes = store.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => JSON.parse(JSON.stringify(node)) as CanvasNode);
    const snapEdges = store.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => JSON.parse(JSON.stringify(edge)) as CanvasEdge);
    clipboardRef.current = { nodes: snapNodes, edges: snapEdges };
  }, [expandWithDescendants]);

  /** 复制选中节点：内部快照 + 单节点内容同步到系统剪贴板（可粘贴到外部应用） */
  const copySelectionWithSync = useCallback(() => {
    copySelection();
    systemClipboard.noteInternalCopy(clipboardRef.current);
  }, [copySelection, systemClipboard]);

  const pasteAtWorld = useCallback(
    (worldPos: { x: number; y: number } | null): boolean => {
      const snapshot = clipboardRef.current;
      if (!snapshot || snapshot.nodes.length === 0) return false;
      const store = useCanvasStore.getState();
      const storeById = new Map(store.nodes.map((node) => [node.id, node]));
      const snapIds = new Set(snapshot.nodes.map((node) => node.id));
      let minX = Infinity;
      let minY = Infinity;
      for (const node of snapshot.nodes) {
        if (node.parentId && snapIds.has(node.parentId)) continue;
        const merged = new Map<string, CanvasNode>(storeById);
        for (const snapNode of snapshot.nodes) merged.set(snapNode.id, snapNode);
        const abs = absoluteOf(node, merged);
        minX = Math.min(minX, abs.x);
        minY = Math.min(minY, abs.y);
      }
      if (!Number.isFinite(minX)) return false;
      // 旧版粘贴语义：落点避让（连续粘贴不原地重叠、不压住已有节点）
      const anchor = worldPos ?? { x: minX + 32, y: minY + 32 };
      const free = resolveFreeNodePosition(store.nodes, anchor);
      const offset = { x: free.x - minX, y: free.y - minY };
      const newIds = duplicateSnapshot(snapshot, offset, false);
      engineRef.current?.setSelection(newIds);
      setSelectedIds(newIds);
      lastEmittedSelectionRef.current = newIds[newIds.length - 1] ?? null;
      schedulePersistRef.current(0);
      return true;
    },
    [absoluteOf, duplicateSnapshot],
  );

  /* ---------- 引擎生命周期 ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Canvas2DEngine({
      onSelect: (ids, primary) => {
        lastEmittedSelectionRef.current = primary;
        setSelectedIds(ids);
        const store = useCanvasStore.getState();
        if (store.selectedNodeId !== primary) store.setSelectedNode(primary);
      },
      onDragStart: (ids) => {
        const store = useCanvasStore.getState();
        const byId = new Map(store.nodes.map((node) => [node.id, node]));
        const changes: NodeChange<CanvasNode>[] = [];
        for (const id of ids) {
          const node = byId.get(id);
          if (!node) continue;
          changes.push({ type: 'position', id, position: { ...node.position }, dragging: true });
        }
        if (changes.length > 0) store.onNodesChange(changes);
      },
      onDragCommit: (ids, dx, dy) => {
        const store = useCanvasStore.getState();
        const byId = new Map(store.nodes.map((node) => [node.id, node]));
        const parentOf = new Map(store.nodes.map((node) => [node.id, node.parentId]));
        const effective = new Set(filterDragDescendants(ids, parentOf));
        const changes: NodeChange<CanvasNode>[] = [];
        for (const id of ids) {
          const node = byId.get(id);
          if (!node) continue;
          const position = effective.has(id)
            ? { x: node.position.x + dx, y: node.position.y + dy }
            : { ...node.position };
          changes.push({ type: 'position', id, position, dragging: false });
        }
        if (changes.length > 0) store.onNodesChange(changes);
        schedulePersistRef.current(0);
      },
      onDragRequestDuplicate: (ids) => {
        const store = useCanvasStore.getState();
        const byId = new Map(store.nodes.map((node) => [node.id, node]));
        const expanded = expandWithDescendants(ids, store.nodes);
        const snapshot: ClipboardSnapshot = {
          nodes: expanded.map((id) => byId.get(id)).filter((n): n is CanvasNode => Boolean(n)),
          edges: store.edges.filter((edge) => expanded.includes(edge.source) && expanded.includes(edge.target)),
        };
        if (snapshot.nodes.length === 0) return null;
        const newIds = duplicateSnapshot(snapshot, { x: 0, y: 0 }, true);
        schedulePersistRef.current(0);
        return newIds;
      },
      onResizeStart: (id) => {
        const store = useCanvasStore.getState();
        const node = store.nodes.find((n) => n.id === id);
        if (!node) return;
        const width = node.measured?.width ?? node.width ?? 220;
        const height = node.measured?.height ?? node.height ?? 150;
        store.onNodesChange([
          { type: 'dimensions', id, dimensions: { width, height }, resizing: true, setAttributes: true },
        ]);
      },
      onResizeCommit: (id, width, height) => {
        const store = useCanvasStore.getState();
        store.onNodesChange([
          {
            type: 'dimensions',
            id,
            dimensions: { width: Math.round(width), height: Math.round(height) },
            resizing: false,
            setAttributes: true,
          },
        ]);
        schedulePersistRef.current(0);
      },
      onViewportCommit: (viewport) => {
        lastCommittedViewportRef.current = viewport;
        useCanvasStore.getState().setViewportState({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
        useViewportSnapshotStore.getState().set(viewport);
      },
      onCursor: (cursor) => {
        if (canvasRef.current) canvasRef.current.style.cursor = cursor;
      },
      onConnect: (sourceId, targetId) => {
        const store = useCanvasStore.getState();
        store.onConnect({ source: sourceId, target: targetId, sourceHandle: 'source', targetHandle: 'target' });
        schedulePersistRef.current(0);
      },
      onConnectEndEmpty: (payload) => {
        const allowed = resolveAllowedNodeTypes(payload.handleType);
        if (allowed.length === 0) return;
        setContextMenu(null);
        setNodeMenu({
          position: { x: payload.sx, y: payload.sy },
          allowedTypes: allowed,
          pendingConnect: { nodeId: payload.nodeId, handleType: payload.handleType },
          worldPos: payload.world,
        });
      },
      onContextMenu: (payload) => {
        setNodeMenu(null);
        setContextMenu({
          nodeId: payload.nodeId,
          position: { x: payload.sx, y: payload.sy },
          worldPosition: payload.world,
          selectedText: window.getSelection()?.toString().trim() ?? '',
        });
      },
      onNodeDoubleClick: (nodeId) => {
        const store = useCanvasStore.getState();
        const node = store.nodes.find((n) => n.id === nodeId);
        const modelNow = modelRef.current;
        if (!node || !modelNow) return;
        const data = node.data as Record<string, unknown>;
        // 图片类：打开大图查看器（列表 = 画布上所有带原图的节点）
        const rawUrl = typeof data.imageUrl === 'string' ? data.imageUrl : '';
        if (rawUrl) {
          const list: string[] = [];
          for (const n of store.nodes) {
            const d = n.data as Record<string, unknown>;
            const url = typeof d.imageUrl === 'string' ? d.imageUrl : '';
            if (url) list.push(resolveImageDisplayUrl(url));
          }
          store.openImageViewer(resolveImageDisplayUrl(rawUrl), list);
          return;
        }
        // 标签类：跳到源节点
        if (node.type === CANVAS_NODE_TYPES.tag || node.type === CANVAS_NODE_TYPES.tagGroup) {
          let sourceId: string | null = typeof data.sourceId === 'string' ? data.sourceId : null;
          if (!sourceId && Array.isArray(data.sources)) {
            const first = (data.sources as Array<Record<string, unknown>>).find(
              (s) => s.enabled !== false && typeof s.sourceNodeId === 'string',
            );
            sourceId = (first?.sourceNodeId as string) ?? null;
          }
          if (sourceId && modelNow.byId.has(sourceId)) {
            const target = modelNow.byId.get(sourceId);
            if (target) {
              engineRef.current?.centerOnWorld(target.x + target.w / 2, target.y + target.h / 2);
              lastEmittedSelectionRef.current = sourceId;
              store.setSelectedNode(sourceId);
            }
          }
          return;
        }
      },
      onEdgeDelete: (edgeId) => {
        useCanvasStore.getState().deleteEdge(edgeId);
        schedulePersistRef.current(0);
      },
      onCanvasDoubleClick: (payload) => {
        setContextMenu(null);
        setNodeMenu({
          position: { x: payload.sx, y: payload.sy },
          allowedTypes: undefined,
          pendingConnect: null,
          worldPos: payload.world,
        });
      },
    });

    console.warn(`[canvas2d] 光栅化后端: ${probeRasterBackend()}`);
    engine.attach(canvas);
    const rect = containerRef.current?.getBoundingClientRect();
    engine.resize(rect?.width ?? 800, rect?.height ?? 600, Math.min(window.devicePixelRatio || 1, 2));
    engine.setTheme(useThemeStore.getState().theme);
    engine.setSnapEnabled(useSnapStore.getState().snapEnabled);
    engine.setConnectionValidator((sourceId, targetId) => {
      const store = useCanvasStore.getState();
      if (!sourceId || !targetId || sourceId === targetId) return false;
      const targetNode = store.nodes.find((n) => n.id === targetId);
      if (!targetNode) return true;
      const exists = store.edges.some((e) => e.source === sourceId && e.target === targetId);
      if (exists) return false;
      if (targetNode.type === CANVAS_NODE_TYPES.tag) {
        const hasOtherIncoming = store.edges.some((e) => e.target === targetId && e.source !== sourceId);
        if (hasOtherIncoming) return false;
      }
      return true;
    });
    const vp = useCanvasStore.getState().currentViewport;
    if (vp) {
      engine.adoptViewport(vp);
      lastCommittedViewportRef.current = vp;
    }
    engine.start();
    engineRef.current = engine;
    registerCanvas2DEngine(engine, canvas);
    useViewportSnapshotStore.getState().set(engine.getViewport());

    const statsTimer = setInterval(() => {
      const slow = engine.slowFrameCount;
      if (!diagAutoOpenedRef.current && slow - prevSlowFramesRef.current > 25) {
        diagAutoOpenedRef.current = true;
        setDiagOpen(true);
        console.warn('[canvas2d] 检测到持续慢帧，已自动打开诊断面板，请截图面板反馈以定位瓶颈');
      }
      prevSlowFramesRef.current = slow;
      setStats({ ...engine.getStats(), slowFrames: slow } as EngineStats);
      // 低频喂给 useViewport() 垫片（检视面板里的原图/预览图切换等场景足够）
      useViewportSnapshotStore.getState().set(engine.getViewport());
    }, 500);

    return () => {
      clearInterval(statsTimer);
      engine.stop();
      registerCanvas2DEngine(null, null);
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- store → engine 同步 ---------- */
  useEffect(() => {
    engineRef.current?.setModel(model);
  }, [model]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    engineRef.current?.setSnapEnabled(snapEnabled);
  }, [snapEnabled]);

  useEffect(() => {
    engineRef.current?.setWasdConfig(enableCanvasWasdPan, canvasWasdPanSensitivity);
  }, [enableCanvasWasdPan, canvasWasdPanSensitivity]);

  useEffect(() => {
    engineRef.current?.setEdgeRoutingMode(canvasEdgeRoutingMode);
  }, [canvasEdgeRoutingMode]);

  useEffect(() => {
    if (selectedNodeId === lastEmittedSelectionRef.current) return;
    lastEmittedSelectionRef.current = selectedNodeId;
    engineRef.current?.setSelection(selectedNodeId ? [selectedNodeId] : []);
    setSelectedIds(selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId]);

  /* ---------- 选区镜像清理：节点被删除后同步剔除失效 id ---------- */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.length === 0) return prev;
      const alive = new Set(nodes.map((node) => node.id));
      const next = prev.filter((id) => alive.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [nodes]);

  useEffect(() => {
    if (viewportEquals(currentViewport, lastCommittedViewportRef.current)) return;
    lastCommittedViewportRef.current = currentViewport ?? null;
    if (currentViewport) engineRef.current?.adoptViewport(currentViewport);
  }, [currentViewport]);

  /* ---------- 输入 ---------- */
  const localXY = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  const closeMenus = useCallback(() => {
    setNodeMenu(null);
    setContextMenu(null);
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const p = localXY(event);
      lastPointerLocalRef.current = p;
      closeMenus();
      engineRef.current?.pointerDown(p.x, p.y, {
        button: event.button,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
    },
    [localXY, closeMenus],
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const p = localXY(event);
      lastPointerLocalRef.current = p;
      engineRef.current?.pointerMove(p.x, p.y, { altKey: event.altKey });
    },
    [localXY],
  );
  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = localXY(event);
    engineRef.current?.pointerUp(p.x, p.y);
  }, [localXY]);
  const handleContextMenuEvent = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      engineRef.current?.wheel(event.clientX - rect.left, event.clientY - rect.top, event.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      engineRef.current?.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /* ---------- 新建节点菜单 ---------- */
  const handleNodeMenuSelect = useCallback(
    (type: CanvasNodeType) => {
      const menu = nodeMenu;
      if (!menu) return;
      const store = useCanvasStore.getState();
      const newNodeId = store.addNode(type, menu.worldPos);
      if (menu.pendingConnect) {
        const { nodeId, handleType } = menu.pendingConnect;
        if (handleType === 'source') {
          store.onConnect({ source: nodeId, target: newNodeId, sourceHandle: 'source', targetHandle: 'target' });
          if (type === CANVAS_NODE_TYPES.textAnnotation) {
            const sourceNode = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
            if (sourceNode) {
              const sourceText = getGeneratedTextForConnection(sourceNode, useCanvasStore.getState().nodes);
              if (sourceText) {
                store.updateNodeData(newNodeId, { content: sourceText } as Partial<CanvasNodeData>);
              }
            }
          }
        } else {
          store.onConnect({ source: newNodeId, target: nodeId, sourceHandle: 'source', targetHandle: 'target' });
        }
      }
      lastEmittedSelectionRef.current = newNodeId;
      useCanvasStore.getState().setSelectedNode(newNodeId);
      engineRef.current?.setSelection([newNodeId]);
      setSelectedIds([newNodeId]);
      schedulePersistRef.current(0);
      setNodeMenu(null);
    },
    [nodeMenu],
  );

  /* ---------- 右键菜单动作 ---------- */
  const handleContextMenuCopyNode = useCallback(() => {
    const state = contextMenu;
    setContextMenu(null);
    if (!state?.nodeId) return;
    const store = useCanvasStore.getState();
    const byId = new Map(store.nodes.map((node) => [node.id, node]));
    const expanded = expandWithDescendants([state.nodeId], store.nodes);
    const snapshot: ClipboardSnapshot = {
      nodes: expanded.map((id) => byId.get(id)).filter((n): n is CanvasNode => Boolean(n)),
      edges: store.edges.filter((edge) => expanded.includes(edge.source) && expanded.includes(edge.target)),
    };
    const newIds = duplicateSnapshot(snapshot, { x: 24, y: 24 }, false);
    engineRef.current?.setSelection(newIds);
    setSelectedIds(newIds);
    schedulePersistRef.current(0);
  }, [contextMenu, duplicateSnapshot, expandWithDescendants]);

  const handleContextMenuPaste = useCallback(() => {
    const state = contextMenu;
    setContextMenu(null);
    void systemClipboard.handleContextMenuPaste({
      nodeId: state ? state.nodeId : null,
      worldPosition: state ? state.worldPosition : resolvePasteWorldPosition(),
    });
  }, [contextMenu, resolvePasteWorldPosition, systemClipboard]);

  const handleContextMenuDelete = useCallback(() => {
    const state = contextMenu;
    setContextMenu(null);
    if (!state?.nodeId) return;
    useCanvasStore.getState().deleteNode(state.nodeId);
    schedulePersistRef.current(0);
  }, [contextMenu]);

  const handleContextMenuCreateImageFromText = useCallback(() => {
    const state = contextMenu;
    setContextMenu(null);
    if (!state?.nodeId) return;
    const store = useCanvasStore.getState();
    const node = store.nodes.find((n) => n.id === state.nodeId);
    const modelNow = modelRef.current;
    if (!node || !modelNow) return;
    const text = getGeneratedTextForConnection(node, store.nodes);
    if (!text) return;
    const rendered = modelNow.byId.get(node.id);
    const pos = rendered
      ? { x: rendered.x + rendered.w + 80, y: rendered.y }
      : { x: node.position.x + 300, y: node.position.y };
    const newId = store.addNode(CANVAS_NODE_TYPES.imageEdit, pos);
    store.onConnect({ source: node.id, target: newId, sourceHandle: 'source', targetHandle: 'target' });
    store.updateNodeData(newId, { prompt: text } as Partial<CanvasNodeData>);
    schedulePersistRef.current(0);
  }, [contextMenu]);

  const handleContextMenuCopySelectedText = useCallback(() => {
    setContextMenu(null);
  }, []);

  /* ---------- 多选批量工具条 ---------- */
  const batchState = useMemo(() => resolveBatchToolbarState(nodes, selectedIds), [nodes, selectedIds]);

  const handleBatchGroup = useCallback(() => {
    if (selectedIds.length < 2) return;
    const grouped = useCanvasStore.getState().groupNodes(selectedIds);
    if (grouped) schedulePersistRef.current(0);
  }, [selectedIds]);

  const handleBatchUngroup = useCallback(() => {
    let changed = false;
    for (const groupId of batchState.groupIds) {
      changed = useCanvasStore.getState().ungroupNode(groupId) || changed;
    }
    if (changed) schedulePersistRef.current(0);
  }, [batchState.groupIds]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    useCanvasStore.getState().deleteNodes(selectedIds);
    schedulePersistRef.current(0);
  }, [selectedIds]);

  const handleBatchArrange = useCallback(
    (sortBy: 'name' | 'position') => {
      useCanvasStore.getState().arrangeNodesToGrid(selectedIds, { sortBy });
      schedulePersistRef.current(0);
    },
    [selectedIds],
  );

  // 框选整理并打组：把选中的节点（含其所在整组）先释放成顶层，排整齐，再打成一个新组
  const handleTidyAndGroup = useCallback(
    (sortBy: 'name' | 'position') => {
      const state = useCanvasStore.getState();
      const nodeById = new Map(state.nodes.map((node) => [node.id, node] as const));
      const groupsToRelease = new Set<string>();
      const working = new Set<string>();
      const addGroupChildren = (groupId: string) => {
        for (const node of state.nodes) {
          if (node.parentId === groupId) working.add(node.id);
        }
      };
      for (const id of selectedIds) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (node.type === CANVAS_NODE_TYPES.group) {
          groupsToRelease.add(id);
          addGroupChildren(id);
        } else if (node.parentId) {
          if (!groupsToRelease.has(node.parentId)) {
            groupsToRelease.add(node.parentId);
            addGroupChildren(node.parentId);
          }
          working.add(id);
        } else {
          working.add(id);
        }
      }
      // 先拆组：子节点变顶层绝对坐标，才能被 dagre 重新排布
      for (const groupId of groupsToRelease) {
        state.ungroupNode(groupId);
      }
      const workingIds = [...working];
      if (workingIds.length === 0) return;
      useCanvasStore.getState().arrangeNodesToGrid(workingIds, { sortBy });
      if (workingIds.length >= 2) {
        useCanvasStore.getState().groupNodes(workingIds);
      }
      schedulePersistRef.current(0);
    },
    [selectedIds],
  );

  /**
   * 批量触发：检视面板中已挂载的节点直接发事件；其余可触发节点先经
   * HiddenTriggerHost 隐藏挂载（补齐事件订阅）再统一发布。
   * 生成提交后的轮询/结果落盘由视图级 useCanvasGenerationPolling 接管，
   * 宿主组件延时卸载不影响进行中的任务。
   */
  const handleBatchTrigger = useCallback(() => {
    const ids = batchState.triggerIds;
    if (ids.length === 0) return;
    const mountedId = useCanvasStore.getState().selectedNodeId;
    if (mountedId && ids.includes(mountedId)) {
      canvasEventBus.publish('generation-node/trigger', { nodeId: mountedId });
    }
    const unmounted = ids.filter((id) => id !== mountedId);
    if (unmounted.length > 0) setTriggerHostIds(unmounted);
  }, [batchState.triggerIds]);

  // 触发宿主自动回收：20s 兜底卸载；选区变化立即卸载
  useEffect(() => {
    if (triggerHostIds.length === 0) return;
    const timer = setTimeout(() => setTriggerHostIds([]), 20_000);
    return () => clearTimeout(timer);
  }, [triggerHostIds]);
  useEffect(() => {
    setTriggerHostIds((prev) => (prev.length === 0 ? prev : []));
  }, [selectedIds]);

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      // WASD 平移（不拦截修饰键组合）
      if (!isEditableTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const lower = key.toLowerCase();
        if (['w', 'a', 's', 'd'].includes(lower)) {
          engineRef.current?.setWasdKey(lower, true);
        }
      }
      if (isEditableTarget(event.target)) return;
      const store = useCanvasStore.getState();
      if (key === 'Escape') {
        closeMenus();
        engineRef.current?.cancelGesture();
        engineRef.current?.clearEdgeSelection();
        engineRef.current?.clearSelection();
        return;
      }
      if (store.activeToolDialog || store.imageViewer.isOpen) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (key === 'z' || key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && (key === 'y' || key === 'Y')) {
        event.preventDefault();
        store.redo();
        return;
      }
      if (mod && (key === 'a' || key === 'A')) {
        event.preventDefault();
        engineRef.current?.selectAll();
        return;
      }
      if (mod && (key === 'c' || key === 'C')) {
        event.preventDefault();
        copySelectionWithSync();
        return;
      }
      if (mod && (key === 'v' || key === 'V')) {
        // 不 preventDefault：让 document paste 事件先走同步通道（40ms 兜底在 hook 内）
        systemClipboard.requestShortcutPaste();
        return;
      }
      if (mod && (key === 'g' || key === 'G')) {
        event.preventDefault();
        const ids = [...(engineRef.current?.getSelectedIds() ?? [])];
        if (ids.length === 0) return;
        if (event.shiftKey) {
          let changed = false;
          for (const id of ids) {
            const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
            if (node?.type === CANVAS_NODE_TYPES.group) {
              changed = store.ungroupNode(id) || changed;
            }
          }
          if (changed) schedulePersistRef.current(0);
        } else if (ids.length >= 2) {
          const grouped = store.groupNodes(ids);
          if (grouped) schedulePersistRef.current(0);
        }
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        const edgeId = engineRef.current?.getSelectedEdgeId() ?? null;
        if (edgeId) {
          event.preventDefault();
          store.deleteEdge(edgeId);
          engineRef.current?.clearEdgeSelection();
          schedulePersistRef.current(0);
          return;
        }
        const ids = [...(engineRef.current?.getSelectedIds() ?? [])];
        if (ids.length === 0) return;
        event.preventDefault();
        store.deleteNodes(ids);
        schedulePersistRef.current(0);
        return;
      }
      if (key === 'f' || key === 'F') {
        event.preventDefault();
        engineRef.current?.fitView();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const lower = event.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(lower)) {
        engineRef.current?.setWasdKey(lower, false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [closeMenus, copySelectionWithSync, systemClipboard]);

  /* ---------- HUD ---------- */
  const hudFps = stats?.fps ?? 0;
  const fpsClass = hudFps >= 50 ? 'text-emerald-400' : hudFps >= 30 ? 'text-amber-400' : 'text-red-400';

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-bg-dark"
      onDragOver={materialImport.handleCanvasDragOver}
      onDrop={materialImport.handleCanvasDrop}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ cursor: 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={handleContextMenuEvent}
      />

      {/* DOM 岛层（混合渲染）：放大时视口内节点内嵌原版编辑组件 */}
      <DomIslands
        engineRef={engineRef}
        model={model}
        selectedIds={selectedIds}
        onIslandsChange={handleIslandsChange}
        onFallback={handleIslandsFallback}
      />

      {/* 状态 HUD */}
      <div className="pointer-events-none absolute right-3 top-3 min-w-[190px] rounded-lg border border-border-dark bg-[rgba(11,15,24,0.85)] p-3 font-mono text-[11px] leading-5 text-text-muted backdrop-blur-sm">
        <div className={`text-xl font-bold ${fpsClass}`}>{stats ? stats.fps : '--'} FPS</div>
        <div className="mt-1 flex justify-between gap-3">
          <span>{t('canvas2d.hudFrame')}</span>
          <b className="text-text-dark">{stats ? `${stats.frameMs.toFixed(1)} ms` : '--'}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>{t('canvas2d.hudVisible')}</span>
          <b className="text-text-dark">{stats ? `${stats.visible} / ${stats.total}` : '--'}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>{t('canvas2d.hudEdges')}</span>
          <b className="text-text-dark">{stats ? `${stats.edgesDrawn}` : '--'}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>zoom</span>
          <b className="text-text-dark">{stats ? `${stats.zoom.toFixed(2)}×` : '--'}</b>
        </div>
        <div className="pointer-events-auto mt-2 flex gap-1.5">
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.zoomBy(1.25)}
          >
            +
          </button>
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.zoomBy(0.8)}
          >
            −
          </button>
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.fitView()}
          >
            {t('canvas2d.fit')}
          </button>
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => setDiagOpen((open) => !open)}
          >
            {t('canvas2d.diag')}
          </button>
        </div>
      </div>

      {/* 诊断面板：截图即可定位性能瓶颈层级 */}
      {diagOpen && (
        <div className="absolute right-3 top-40 z-50 w-[360px] rounded-lg border border-border-dark bg-[rgba(11,15,24,0.92)] p-3 font-mono text-[11px] leading-5 text-text-muted backdrop-blur-sm">
          <div className="mb-1 text-xs font-semibold text-text-dark">{t('canvas2d.diagTitle')}</div>
          <div>backend: <b className={isSoftwareRaster(rasterBackend) ? 'text-red-400' : 'text-emerald-400'}>{rasterBackend}</b></div>
          {isSoftwareRaster(rasterBackend) && (
            <div className="text-red-300">{t('canvas2d.diagSoftware')}</div>
          )}
          <div>fps: {stats?.fps ?? '--'} / frame: {stats ? stats.frameMs.toFixed(1) : '--'} ms</div>
          <div>slowFrames(&gt;48ms): {((stats as (EngineStats & { slowFrames?: number }) | null)?.slowFrames) ?? 0}</div>
          <div>nodes: {stats?.total ?? 0} / visible: {stats?.visible ?? 0} / edges: {stats?.edgesDrawn ?? 0}</div>
          <div>domIslands: {islandCount} / zoom: {stats ? stats.zoom.toFixed(2) : '--'}</div>
        </div>
      )}

      {/* 操作提示横幅 */}
      <div className="pointer-events-none absolute left-3 top-3 max-w-[460px] rounded-lg border border-sky-500/30 bg-[rgba(12,42,61,0.88)] px-3 py-2 text-[11px] leading-4 text-sky-200 backdrop-blur-sm">
        <b className="text-sky-100">{t('canvas2d.badge')}</b>
        <span className="mx-1.5 opacity-50">|</span>
        {t('canvas2d.banner')}
      </div>

      {/* 磁吸开关（读 snapStore） */}
      <div className="absolute bottom-3 left-3">
        <SnapToggle />
      </div>

      {/* 左侧节点工具栏（经 nodeHostApi 桥接引擎坐标） */}
      <CanvasSideToolbar onOpenAssets={handleOpenAssets} />

      {/* 多选批量工具条（复制/打组/解组/批量触发/删除） */}
      <BatchToolbarLayer
        engineRef={engineRef}
        containerRef={containerRef}
        state={batchState}
        onCopy={copySelectionWithSync}
        onGroup={handleBatchGroup}
        onUngroup={handleBatchUngroup}
        onTrigger={handleBatchTrigger}
        onDelete={handleBatchDelete}
        onArrange={handleBatchArrange}
        onTidyAndGroup={handleTidyAndGroup}
      />

      {/* 批量触发隐藏宿主：为未挂载的可触发节点补齐事件订阅 */}
      {triggerHostIds.length > 0 && <HiddenTriggerHost ids={triggerHostIds} />}

      <AssetPanel
        isOpen={assetPanelOpen}
        assets={assetItems}
        buttonRect={assetButtonRect}
        mode="browse"
        onClose={() => setAssetPanelOpen(false)}
        onActivate={handleAssetActivate}
      />

      {/* 选中节点的浮动工具栏与生成面板（全套面板生态） */}
      <SelectedNodeOverlay />
      <NodeToolDialog />
      {/* 仅岛层异常回退时渲染检视面板；正常编辑全部在画布岛内完成 */}
      {islandsBroken && <NodeInspector />}

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <div className="rounded-xl border border-border-dark bg-surface-dark/90 px-6 py-4 text-center text-sm text-text-muted">
            {t('canvas2d.empty')}
          </div>
        </div>
      )}

      {nodeMenu && (
        <NodeSelectionMenu
          position={nodeMenu.position}
          allowedTypes={nodeMenu.allowedTypes}
          onSelect={handleNodeMenuSelect}
          onClose={closeMenus}
        />
      )}

      <ContextMenu
        state={contextMenu}
        onCopySelectedText={handleContextMenuCopySelectedText}
        onCreateImageFromText={handleContextMenuCreateImageFromText}
        onCopyNode={handleContextMenuCopyNode}
        onPaste={handleContextMenuPaste}
        onDeleteNode={handleContextMenuDelete}
      />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />
    </div>
  );
}

/* 按组件类型缓存错误边界包装（检视面板 / 触发宿主共用） */
const safeComponentCache = new WeakMap<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React.ComponentType<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React.ComponentType<any>
>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeComponent<T extends React.ComponentType<any>>(Comp: T): React.ComponentType<any> {
  let wrapped = safeComponentCache.get(Comp);
  if (!wrapped) {
    wrapped = withNodeRenderErrorBoundary(Comp);
    safeComponentCache.set(Comp, wrapped);
  }
  return wrapped;
}

/**
 * 节点检视面板：选中单个节点时，在右侧停靠渲染其【原版节点编辑组件】。
 * 节点编辑组件通过 compat/nodeHostApi 提供的宿主 API 运行：
 * Handle 渲染为空（连接桩由 canvas 绘制）、NodeToolbar 浮动定位到画布节点上方、
 * useCanvasApi/useViewport 桥接到 Canvas2D 引擎。编辑能力零重写、全保留。
 */
function NodeInspector() {
  const { t } = useTranslation();
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const imageViewerOpen = useCanvasStore((state) => state.imageViewer.isOpen);
  const node = useCanvasStore((state) =>
    selectedNodeId ? state.nodes.find((n) => n.id === selectedNodeId) : undefined,
  );

  const close = useCallback(() => {
    useCanvasStore.getState().setSelectedNode(null);
  }, []);

  const updateNodeData = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (update: any) => {
      if (!selectedNodeId) return;
      const current = useCanvasStore.getState().nodes.find((n) => n.id === selectedNodeId);
      const next = typeof update === 'function' ? update(current?.data ?? {}) : update;
      useCanvasStore.getState().updateNodeData(selectedNodeId, next as Partial<CanvasNodeData>);
    },
    [selectedNodeId],
  );

  if (!node || !node.type || imageViewerOpen) return null;
  const Comp = nodeTypes[node.type];
  if (!Comp) return null;
  const SafeComp = safeComponent(Comp);

  const rawWidth = node.measured?.width ?? node.width ?? 360;
  const rawHeight = node.measured?.height ?? node.height ?? 240;
  const nodeWidth = Math.max(220, rawWidth);
  const panelWidth = Math.min(620, Math.max(360, nodeWidth + 56));

  const editorProps = {
    id: node.id,
    data: node.data,
    type: node.type,
    selected: true,
    dragging: false,
    isConnectable: false,
    zIndex: node.zIndex ?? 0,
    width: rawWidth,
    height: rawHeight,
    positionAbsoluteX: node.position.x,
    positionAbsoluteY: node.position.y,
    parentId: node.parentId,
    updateNodeData,
    sourcePosition: 'right' as const,
    targetPosition: 'left' as const,
  };

  return (
    <div
      className="absolute right-0 top-0 z-40 flex h-full flex-col border-l border-border-dark bg-bg-dark/95 shadow-2xl backdrop-blur"
      style={{ width: panelWidth }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border-dark px-3 py-2">
        <span className="truncate text-xs font-medium text-text-muted">
          {t('canvas2d.inspector')}
        </span>
        <button
          type="button"
          onClick={close}
          className="flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-dark hover:text-text-dark"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="ui-scrollbar flex-1 overflow-x-auto overflow-y-auto p-3">
        <NodeHostIdContext.Provider value={node.id}>
          <div className="relative mx-auto" style={{ width: nodeWidth, minHeight: 120 }}>
            <SafeComp {...editorProps} />
          </div>
        </NodeHostIdContext.Provider>
      </div>
    </div>
  );
}

/**
 * 批量工具条定位层：rAF 读取引擎实时选区包围盒（含拖拽偏移），
 * 位置写入本组件 state（epsilon 去抖），不触发父组件重渲染。
 * 仅多选可见时运行 rAF 循环。
 */
function BatchToolbarLayer({
  engineRef,
  containerRef,
  state,
  onCopy,
  onGroup,
  onUngroup,
  onTrigger,
  onDelete,
  onArrange,
  onTidyAndGroup,
}: {
  engineRef: { current: Canvas2DEngine | null };
  containerRef: { current: HTMLDivElement | null };
  state: BatchToolbarState;
  onCopy: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onTrigger: () => void;
  onDelete: () => void;
  onArrange: (sortBy: 'name' | 'position') => void;
  onTidyAndGroup: (sortBy: 'name' | 'position') => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!state.visible) {
      setPosition(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const engine = engineRef.current;
      const container = containerRef.current;
      if (engine && container) {
        const rect = engine.getSelectionWorldRect();
        if (rect) {
          const containerRect = container.getBoundingClientRect();
          const center = engine.toScreen(rect.x + rect.w / 2, rect.y);
          const left = Math.max(12, Math.min(containerRect.width - 12, center.x));
          const top = Math.max(12, center.y - 42);
          setPosition((prev) =>
            prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5
              ? prev
              : { left, top },
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.visible, engineRef, containerRef]);

  if (!state.visible) return null;

  return (
    <BatchToolbar
      position={position}
      selectedCount={state.count}
      canGroup={state.canGroup}
      canUngroup={state.canUngroup}
      canTrigger={state.canTrigger}
      onCopy={onCopy}
      onGroup={onGroup}
      onUngroup={onUngroup}
      onTrigger={onTrigger}
      onDelete={onDelete}
      onArrange={onArrange}
      onTidyAndGroup={onTidyAndGroup}
    />
  );
}

/**
 * 批量触发隐藏宿主：把选中但未挂载的可触发节点编辑组件挂载到 1px 隐藏容器中，
 * 等待其 generation-node/trigger 订阅生效后（双 rAF）统一发布触发事件。
 * HiddenHostContext 抑制 NodeToolbar / NodeResizeControl 的可见渲染。
 */
function HiddenTriggerHost({ ids }: { ids: string[] }) {
  const nodes = useCanvasStore((state) => state.nodes);
  const publishedRef = useRef(false);

  useEffect(() => {
    if (publishedRef.current || ids.length === 0) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        publishedRef.current = true;
        for (const id of ids) {
          canvasEventBus.publish('generation-node/trigger', { nodeId: id });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ids]);

  return (
    <div
      className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
      aria-hidden="true"
    >
      <HiddenHostContext.Provider value={true}>
        {ids.map((id) => {
          const node = nodes.find((n) => n.id === id);
          if (!node || !node.type) return null;
          const Comp = nodeTypes[node.type];
          if (!Comp) return null;
          const SafeComp = safeComponent(Comp);
          const updateNodeData = (update: unknown) => {
            const current = useCanvasStore.getState().nodes.find((n) => n.id === id);
            const next =
              typeof update === 'function'
                ? (update as (data: unknown) => unknown)(current?.data ?? {})
                : update;
            useCanvasStore.getState().updateNodeData(id, next as Partial<CanvasNodeData>);
          };
          return (
            <NodeHostIdContext.Provider key={id} value={id}>
              <SafeComp
                id={node.id}
                data={node.data}
                type={node.type}
                selected={false}
                dragging={false}
                isConnectable={false}
                zIndex={node.zIndex ?? 0}
                width={node.measured?.width ?? node.width ?? 360}
                height={node.measured?.height ?? node.height ?? 240}
                positionAbsoluteX={node.position.x}
                positionAbsoluteY={node.position.y}
                parentId={node.parentId}
                updateNodeData={updateNodeData}
                sourcePosition={'right' as const}
                targetPosition={'left' as const}
              />
            </NodeHostIdContext.Provider>
          );
        })}
      </HiddenHostContext.Provider>
    </div>
  );
}
