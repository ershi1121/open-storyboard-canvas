import { create } from 'zustand';
import type { Canvas2DEngine } from '@/features/canvas/canvas2d/engine';
import type { Viewport, XYPosition } from '@/features/canvas/domain/graphTypes';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * Canvas2D 引擎桥接单例。
 *
 * 节点编辑组件通过 nodeHostApi 的 useCanvasApi()/useViewport()
 * 访问画布相机；引擎实例由 Canvas2DView 在挂载时注册到这里。
 * 只有检视面板中的单个（或少量隐藏挂载的）组件消费，更新频率已节流，
 * 不会重现"每帧全员重渲染"问题。
 */

interface EngineBridge {
  engine: Canvas2DEngine | null;
  canvasEl: HTMLCanvasElement | null;
}

const bridge: EngineBridge = { engine: null, canvasEl: null };

export function registerCanvas2DEngine(engine: Canvas2DEngine | null, canvasEl: HTMLCanvasElement | null): void {
  bridge.engine = engine;
  bridge.canvasEl = canvasEl;
}

export function getCanvas2DEngine(): Canvas2DEngine | null {
  return bridge.engine;
}

/** 画布 canvas 元素（容器定位 / client 坐标换算用） */
export function getCanvasElement(): HTMLCanvasElement | null {
  return bridge.canvasEl;
}

/** 客户端坐标 → 画布世界坐标 */
export function clientToWorldPosition(clientPos: XYPosition): XYPosition {
  const engine = bridge.engine;
  const rect = bridge.canvasEl?.getBoundingClientRect();
  if (!engine || !rect) {
    const vp = useCanvasStore.getState().currentViewport ?? { x: 0, y: 0, zoom: 1 };
    return { x: (clientPos.x - vp.x) / vp.zoom, y: (clientPos.y - vp.y) / vp.zoom };
  }
  return engine.toWorld(clientPos.x - rect.left, clientPos.y - rect.top);
}

/** 画布世界坐标 → 客户端坐标 */
export function worldToClientPosition(flowPos: XYPosition): XYPosition {
  const engine = bridge.engine;
  const rect = bridge.canvasEl?.getBoundingClientRect();
  if (!engine || !rect) return { ...flowPos };
  const screen = engine.toScreen(flowPos.x, flowPos.y);
  return { x: screen.x + rect.left, y: screen.y + rect.top };
}

export function liveViewport(): Viewport {
  const engine = bridge.engine;
  if (engine) {
    const vp = engine.getViewport();
    return { x: vp.x, y: vp.y, zoom: vp.zoom };
  }
  return useCanvasStore.getState().currentViewport ?? { x: 0, y: 0, zoom: 1 };
}

/** useViewport() 垫片背后的低频视口快照（Canvas2DView 节流推送） */
interface ViewportSnapshotState extends Viewport {
  set: (vp: Viewport) => void;
}

export const useViewportSnapshotStore = create<ViewportSnapshotState>()((set) => ({
  x: 0,
  y: 0,
  zoom: 1,
  set: (vp) =>
    set((state) =>
      Math.abs(state.x - vp.x) < 0.5 && Math.abs(state.y - vp.y) < 0.5 && Math.abs(state.zoom - vp.zoom) < 0.001
        ? state
        : { x: vp.x, y: vp.y, zoom: vp.zoom },
    ),
}));

/* ---------------- DOM 岛可见性查询 ---------------- */

let islandVisibilityChecker: ((id: string) => boolean) | null = null;
let islandMountedChecker: ((id: string) => boolean) | null = null;

/** DomIslands 注册：查询节点是否已作为岛挂载（触发宿主去重用） */
export function registerIslandMountedChecker(fn: ((id: string) => boolean) | null): void {
  islandMountedChecker = fn;
}

export function isIslandMounted(id: string): boolean {
  return islandMountedChecker ? islandMountedChecker(id) : false;
}

/** DomIslands 注册：已挂载但隐藏（display:none）的岛不显示浮动工具栏 */
export function registerIslandVisibilityChecker(fn: ((id: string) => boolean) | null): void {
  islandVisibilityChecker = fn;
}

export function isIslandVisible(id: string): boolean {
  return islandVisibilityChecker ? islandVisibilityChecker(id) : true;
}

const visibilityListeners = new Set<() => void>();

/** 岛可见性翻转时通知（浮动工具栏重定位） */
export function onIslandVisibilityChange(fn: () => void): () => void {
  visibilityListeners.add(fn);
  return () => {
    visibilityListeners.delete(fn);
  };
}

export function emitIslandVisibilityChange(): void {
  for (const fn of visibilityListeners) fn();
}
