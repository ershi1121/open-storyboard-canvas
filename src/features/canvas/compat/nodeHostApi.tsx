import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type {
  Connection,
  EdgeChange,
  HandleType,
  NodeChange,
  Viewport,
  XYPosition,
} from '@/features/canvas/domain/graphTypes';
import {
  clientToWorldPosition,
  worldToClientPosition,
  getCanvas2DEngine,
  liveViewport,
  useViewportSnapshotStore,
} from './engineBridge';

/**
 * 画布节点宿主 API（Canvas2D 渲染架构的节点编辑组件接入层）。
 *
 * 节点编辑组件（nodes/、SelectedNodeOverlay、NodeActionToolbar 等）从本模块
 * 导入画布接入 API，业务逻辑与渲染引擎解耦：
 * - Handle：连接桩由 Canvas2D 渲染层绘制，此处渲染为空
 * - NodeToolbar：浮动工具栏，按引擎世界坐标定位到节点上方（DOM 直写，无 React 重渲染）
 * - NodeResizeControl：完整功能实现，拖拽走 store dimensions change
 * - useCanvasApi/useViewport/useEdges/useUpdateNodeInternals：桥接到 Canvas2D 引擎与 canvasStore
 */

/* ---------------- 基础类型与枚举 ---------------- */

export const Position = {
  Left: 'left',
  Right: 'right',
  Top: 'top',
  Bottom: 'bottom',
} as const;
export type PositionValue = (typeof Position)[keyof typeof Position];

export type { Connection, EdgeChange, HandleType, NodeChange, Viewport, XYPosition };

export interface NodeProps {
  id: string;
  data: Record<string, unknown>;
  type: string;
  selected: boolean;
  dragging?: boolean;
  isConnectable?: boolean;
  zIndex?: number;
  width?: number;
  height?: number;
  positionAbsoluteX?: number;
  positionAbsoluteY?: number;
  parentId?: string;
  dragHandle?: string | null;
  sourcePosition?: PositionValue;
  targetPosition?: PositionValue;
  updateNodeData: (update: unknown, options?: unknown) => void;
  deletionInProgress?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NodeTypes = Record<string, React.ComponentType<any>>;

/** 检视面板为节点组件提供 id 上下文（NodeToolbar/NodeResizeControl 未显式传 nodeId 时使用） */
export const NodeHostIdContext = createContext<string | null>(null);

/* ---------------- 隐藏挂载宿主 ---------------- */

/**
 * 隐藏挂载宿主（批量触发等场景）中置为 true：
 * 抑制 NodeToolbar / NodeResizeControl 的可见渲染，避免浮动工具栏重复出现。
 */
export const HiddenHostContext = createContext<boolean>(false);

/* ---------------- Handle ---------------- */

export interface HandleProps {
  id?: string | null;
  type?: HandleType;
  position?: PositionValue;
  isConnectable?: boolean | number;
  className?: string;
  style?: CSSProperties;
  onClick?: (event: React.MouseEvent) => void;
  onMouseDown?: (event: React.MouseEvent) => void;
  onPointerDownCapture?: (event: React.PointerEvent) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  children?: ReactNode;
}

/** 连接桩视觉与交互由 Canvas2D 渲染层承担，这里保留 API 兼容 */
export function Handle(_props: HandleProps): null {
  return null;
}

/* ---------------- NodeToolbar ---------------- */

export interface NodeToolbarProps {
  nodeId?: string | string[];
  isVisible?: boolean;
  position?: PositionValue;
  align?: 'start' | 'center' | 'end';
  offset?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

function absoluteRectOf(nodeId: string): { x: number; y: number; w: number; h: number } | null {
  const nodes = useCanvasStore.getState().nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>([node.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  const w = node.measured?.width ?? node.width ?? 220;
  const h = node.measured?.height ?? node.height ?? 120;
  return { x, y, w, h };
}

export function NodeToolbar({
  nodeId,
  isVisible = true,
  position = Position.Top,
  align = 'center',
  offset = 4,
  className,
  style,
  children,
}: NodeToolbarProps) {
  const contextId = useContext(NodeHostIdContext);
  const inHiddenHost = useContext(HiddenHostContext);
  const effectiveVisible = isVisible && !inHiddenHost;
  const ids = useMemo(
    () => (Array.isArray(nodeId) ? nodeId : nodeId ? [nodeId] : contextId ? [contextId] : []),
    [nodeId, contextId],
  );
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const reposition = () => {
      const el = containerRef.current;
      if (!el) return;
      const engine = getCanvas2DEngine();
      if (!engine || ids.length === 0 || !effectiveVisible) {
        el.style.display = 'none';
        return;
      }
      // 多节点工具栏：取联合包围盒
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let found = false;
      for (const id of ids) {
        const rect = absoluteRectOf(id);
        if (!rect) continue;
        found = true;
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.w);
        maxY = Math.max(maxY, rect.y + rect.h);
      }
      if (!found) {
        el.style.display = 'none';
        return;
      }
      const anchor =
        position === Position.Bottom
          ? engine.toScreen((minX + maxX) / 2, maxY)
          : engine.toScreen((minX + maxX) / 2, minY);
      const alignShift = align === 'start' ? '0%' : align === 'end' ? '-100%' : '-50%';
      const yShift = position === Position.Bottom ? `${offset}px` : `calc(-100% - ${offset}px)`;
      el.style.display = '';
      el.style.left = `${anchor.x}px`;
      el.style.top = `${anchor.y}px`;
      el.style.transform = `translate(${alignShift}, ${yShift})`;
    };
    reposition();
    const engine = getCanvas2DEngine();
    const unsubscribe = engine ? engine.addCameraListener(reposition) : null;
    // store 变化（节点增删/移动提交）后也需要重定位
    const storeUnsubscribe = useCanvasStore.subscribe(reposition);
    return () => {
      unsubscribe?.();
      storeUnsubscribe();
    };
  }, [ids, effectiveVisible, position, align, offset]);

  if (inHiddenHost) return null;

  return (
    <div
      ref={containerRef}
      className={`nodrag nopan absolute z-50 ${className ?? ''}`}
      style={{ pointerEvents: 'all', ...style }}
    >
      {children}
    </div>
  );
}

/* ---------------- NodeResizeControl ---------------- */

export interface NodeResizeControlProps {
  nodeId?: string;
  position?: string;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onResize?: (event: unknown, params: { width: number; height: number }) => void;
  onResizeEnd?: (event: unknown, params: { width: number; height: number }) => void;
}

export function NodeResizeControl({
  nodeId,
  position = 'bottom-right',
  minWidth = 1,
  minHeight = 1,
  maxWidth = Number.MAX_SAFE_INTEGER,
  maxHeight = Number.MAX_SAFE_INTEGER,
  className,
  style,
  children,
  onResize,
  onResizeEnd,
}: NodeResizeControlProps) {
  const contextId = useContext(NodeHostIdContext);
  const inHiddenHost = useContext(HiddenHostContext);
  const targetId = nodeId ?? contextId;
  const stateRef = useRef<{ startX: number; startY: number; startW: number; startH: number; started: boolean } | null>(null);

  const currentSize = useCallback((): { w: number; h: number } => {
    const node = targetId ? useCanvasStore.getState().nodes.find((n) => n.id === targetId) : null;
    if (!node) return { w: 220, h: 120 };
    return {
      w: node.measured?.width ?? node.width ?? 220,
      h: node.measured?.height ?? node.height ?? 120,
    };
  }, [targetId]);

  const dispatchDims = useCallback(
    (width: number, height: number, resizing: boolean) => {
      if (!targetId) return;
      useCanvasStore.getState().onNodesChange([
        {
          type: 'dimensions',
          id: targetId,
          dimensions: { width: Math.round(width), height: Math.round(height) },
          resizing,
          setAttributes: true,
        },
      ]);
    },
    [targetId],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!targetId) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      const size = currentSize();
      stateRef.current = { startX: event.clientX, startY: event.clientY, startW: size.w, startH: size.h, started: false };
    },
    [targetId, currentSize],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = stateRef.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.started) {
        if (Math.abs(dx) + Math.abs(dy) < 2) return;
        state.started = true;
        dispatchDims(state.startW, state.startH, true); // 触发历史快照
      }
      let nextW = state.startW;
      let nextH = state.startH;
      if (position.includes('right')) nextW = Math.min(maxWidth, Math.max(minWidth, state.startW + dx));
      if (position.includes('bottom')) nextH = Math.min(maxHeight, Math.max(minHeight, state.startH + dy));
      dispatchDims(nextW, nextH, true);
      onResize?.(event, { width: nextW, height: nextH });
    },
    [position, minWidth, minHeight, maxWidth, maxHeight, dispatchDims, onResize],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = stateRef.current;
      stateRef.current = null;
      if (!state?.started) return;
      const size = currentSize();
      dispatchDims(size.w, size.h, false);
      onResizeEnd?.(event, { width: size.w, height: size.h });
    },
    [currentSize, dispatchDims, onResizeEnd],
  );

  const anchorStyle: CSSProperties =
    position === 'bottom-right'
      ? { right: -4, bottom: -4, cursor: 'nwse-resize' }
      : position === 'right'
        ? { right: -4, top: 0, bottom: 0, width: 8, cursor: 'ew-resize' }
        : position === 'bottom'
          ? { bottom: -4, left: 0, right: 0, height: 8, cursor: 'ns-resize' }
          : { right: -4, bottom: -4, cursor: 'nwse-resize' };

  if (inHiddenHost) return null;

  return (
    <div
      className={`nodrag absolute z-10 touch-none ${className ?? ''}`}
      style={{ ...anchorStyle, ...style }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {children}
    </div>
  );
}

/* ---------------- hooks ---------------- */

export function useViewport(): Viewport {
  return useViewportSnapshotStore(useShallow((s) => ({ x: s.x, y: s.y, zoom: s.zoom })));
}

export function useEdges() {
  return useCanvasStore((state) => state.edges);
}

export function useUpdateNodeInternals() {
  return useMemo(() => (_nodeId?: string) => undefined, []);
}

export interface CanvasApiInstance {
  getViewport(): Viewport;
  setViewport(viewport: Viewport): void;
  getZoom(): number;
  screenToWorldPosition(position: XYPosition): XYPosition;
  worldToScreenPosition(position: XYPosition): XYPosition;
  getNode(id: string): CanvasNode | undefined;
  getNodes(): CanvasNode[];
  getEdges(): ReturnType<typeof useCanvasStore.getState>['edges'];
  fitView(options?: { padding?: number }): void;
  zoomIn(): void;
  zoomOut(): void;
  deleteElements(options: { nodes?: Array<{ id: string }>; edges?: Array<{ id: string }> }): void;
}

export function useCanvasApi(): CanvasApiInstance {
  return useMemo(
    () => ({
      getViewport: () => liveViewport(),
      setViewport: (viewport: Viewport) => {
        const engine = getCanvas2DEngine();
        if (engine) engine.adoptViewport(viewport);
        useCanvasStore.getState().setViewportState(viewport);
      },
      getZoom: () => liveViewport().zoom,
      screenToWorldPosition: (position: XYPosition) => clientToWorldPosition(position),
      worldToScreenPosition: (position: XYPosition) => worldToClientPosition(position),
      getNode: (id: string) => useCanvasStore.getState().nodes.find((node) => node.id === id),
      getNodes: () => useCanvasStore.getState().nodes,
      getEdges: () => useCanvasStore.getState().edges,
      fitView: (options?: { padding?: number }) => {
        getCanvas2DEngine()?.fitView(options?.padding != null ? options.padding * 100 : 60);
      },
      zoomIn: () => getCanvas2DEngine()?.zoomBy(1.25),
      zoomOut: () => getCanvas2DEngine()?.zoomBy(0.8),
      deleteElements: (options) => {
        const store = useCanvasStore.getState();
        const nodeIds = (options.nodes ?? []).map((n) => n.id);
        const edgeIds = new Set((options.edges ?? []).map((e) => e.id));
        if (edgeIds.size > 0) {
          store.onEdgesChange([...edgeIds].map((id) => ({ type: 'remove' as const, id })));
        }
        if (nodeIds.length > 0) {
          store.deleteNodes(nodeIds);
        }
      },
    }),
    [],
  );
}

