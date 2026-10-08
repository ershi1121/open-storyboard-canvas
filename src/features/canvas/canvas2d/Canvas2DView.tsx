import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { X } from 'lucide-react';
import type { NodeChange, Viewport } from '@/features/canvas/domain/graphTypes';
import type { CanvasViewportHost } from '@/features/canvas/hooks/useCanvasPersistence';

import { useCanvasStore, type CanvasNode } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import { useSnapStore } from '@/stores/snapStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
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
import { ContextMenu } from '@/features/canvas/shared/components/ContextMenu';
import type { NodeContextMenuState } from '@/features/canvas/shared/types';
import { SnapToggle } from '@/features/canvas/shared/components/SnapToggle';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';
import { SelectedNodeOverlay } from '@/features/canvas/ui/SelectedNodeOverlay';
import { NodeToolDialog } from '@/features/canvas/ui/NodeToolDialog';
import { AssetPanel, type CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { CanvasSideToolbar } from '@/features/canvas/CanvasSideToolbar';
import { nodeTypes } from '@/features/canvas/nodes';
import { extractCanvasAssets } from '@/features/canvas/shared/utils/assets';
import { ShimNodeIdContext } from '@/features/canvas/compat/flowShim';
import { registerCanvas2DEngine, useViewportSnapshotStore } from '@/features/canvas/compat/engineBridge';
import { buildSceneModel, type SceneModel } from './sceneModel';
import { filterDragDescendants } from './spatialGrid';
import { Canvas2DEngine, type ConnectHandleType, type EngineStats, type ViewportLike } from './engine';

/**
 * Canvas2D 渲染后端 v1 —— React Flow 的替代画布。
 *
 * 设计原则：手势期间零 store 写入、零 React 渲染；手势结束一次性 commit。
 * 与 RF 版共享：canvasStore 文档模型、useCanvasPersistence 持久化、
 * useCanvasGenerationPolling 生成轮询、撤销历史、NodeSelectionMenu /
 * ContextMenu / ImageViewerModal / SnapToggle 等 DOM 组件。
 *
 * v1 支持：平移/缩放/全览、拖拽（含分组带子节点、Alt 复制）、磁吸对齐参考线、
 * Shift 多选、右键/Ctrl 框选、连接桩拖拽连线（落空白弹新建菜单）、单节点
 * 右下角缩放、右键菜单（复制/粘贴/删除/文本生图）、双击看图/标签跳源/空白建节点、
 * 内部剪贴板（Ctrl+C/V）、Ctrl+A 全选、Ctrl+G 打组、WASD 平移、小地图导航。
 *
 * 尚未接入（RF 引擎下仍可用）：节点内编辑表单与功能工具栏（多角度/打光/宫格等）、
 * 系统剪贴板图片粘贴、素材文件拖入、跟随移动（磁吸仅对齐）、Alt 拖拽的偏移迭代。
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
  const clipboardRef = useRef<ClipboardSnapshot | null>(null);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [contextMenu, setContextMenu] = useState<NodeContextMenuState | null>(null);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [assetButtonRect, setAssetButtonRect] = useState<DOMRect | null>(null);

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
  const canvasWasdPanSensitivity = useSettingsStore((state) => state.canvasWasdPanSensitivity);

  /* ---------- 持久化（复用 RF 版同一套 hook，传入视口适配器） ---------- */
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

  /* ---------- 工具对话框事件总线（与 RF 版一致的订阅） ---------- */
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

  const pasteAtWorld = useCallback(
    (worldPos: { x: number; y: number } | null) => {
      const snapshot = clipboardRef.current;
      if (!snapshot || snapshot.nodes.length === 0) return;
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
      if (!Number.isFinite(minX)) return;
      const offset = worldPos ? { x: worldPos.x - minX, y: worldPos.y - minY } : { x: 32, y: 32 };
      const newIds = duplicateSnapshot(snapshot, offset, false);
      engineRef.current?.setSelection(newIds);
      lastEmittedSelectionRef.current = newIds[newIds.length - 1] ?? null;
      schedulePersistRef.current(0);
    },
    [absoluteOf, duplicateSnapshot],
  );

  /* ---------- 引擎生命周期 ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Canvas2DEngine({
      onSelect: (_ids, primary) => {
        lastEmittedSelectionRef.current = primary;
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
          flowPosition: payload.world,
          selectedText: '',
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
      setStats({ ...engine.getStats() });
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
    if (selectedNodeId === lastEmittedSelectionRef.current) return;
    lastEmittedSelectionRef.current = selectedNodeId;
    engineRef.current?.setSelection(selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId]);

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
    schedulePersistRef.current(0);
  }, [contextMenu, duplicateSnapshot, expandWithDescendants]);

  const handleContextMenuPaste = useCallback(() => {
    const state = contextMenu;
    setContextMenu(null);
    pasteAtWorld(state ? state.flowPosition : null);
  }, [contextMenu, pasteAtWorld]);

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
        copySelection();
        return;
      }
      if (mod && (key === 'v' || key === 'V')) {
        event.preventDefault();
        const local = lastPointerLocalRef.current;
        pasteAtWorld(engineRef.current ? engineRef.current.toWorld(local.x, local.y) : null);
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
  }, [closeMenus, copySelection, pasteAtWorld]);

  /* ---------- HUD ---------- */
  const hudFps = stats?.fps ?? 0;
  const fpsClass = hudFps >= 50 ? 'text-emerald-400' : hudFps >= 30 ? 'text-amber-400' : 'text-red-400';

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-bg-dark">
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
        </div>
      </div>

      {/* 预览版提示 */}
      <div className="pointer-events-none absolute left-3 top-3 max-w-[460px] rounded-lg border border-sky-500/30 bg-[rgba(12,42,61,0.88)] px-3 py-2 text-[11px] leading-4 text-sky-200 backdrop-blur-sm">
        <b className="text-sky-100">{t('canvas2d.badge')}</b>
        <span className="mx-1.5 opacity-50">|</span>
        {t('canvas2d.banner')}
      </div>

      {/* 磁吸开关（复用 RF 版组件，读同一个 snapStore） */}
      <div className="absolute bottom-3 left-3">
        <SnapToggle />
      </div>

      {/* 左侧节点工具栏（复用组件，经 flowShim 桥接引擎坐标） */}
      <CanvasSideToolbar onOpenAssets={handleOpenAssets} />

      <AssetPanel
        isOpen={assetPanelOpen}
        assets={assetItems}
        buttonRect={assetButtonRect}
        mode="browse"
        onClose={() => setAssetPanelOpen(false)}
        onActivate={handleAssetActivate}
      />

      {/* 选中节点的浮动工具栏与生成面板（复用 RF 版全套面板生态） */}
      <SelectedNodeOverlay />
      <NodeToolDialog />
      <NodeInspector />

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

/**
 * 节点检视面板：选中单个节点时，在右侧停靠渲染其【原版节点编辑组件】。
 * 原 React Flow 节点组件通过 compat/flowShim 提供的同名 API 运行：
 * Handle 渲染为空（连接桩由 canvas 绘制）、NodeToolbar 浮动定位到画布节点上方、
 * useReactFlow/useViewport 桥接到 Canvas2D 引擎。编辑能力零重写、全保留。
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
        <ShimNodeIdContext.Provider value={node.id}>
          <div className="relative mx-auto" style={{ width: nodeWidth, minHeight: 120 }}>
            <Comp {...editorProps} />
          </div>
        </ShimNodeIdContext.Provider>
      </div>
    </div>
  );
}
