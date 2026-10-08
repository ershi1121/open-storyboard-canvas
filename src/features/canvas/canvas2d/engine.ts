import { drawScene, RENDER_CONSTANTS, type Camera, type DrawStats } from './renderer';
import type { SceneModel } from './sceneModel';
import { SpatialGrid } from './spatialGrid';

/**
 * Canvas2D 画布引擎：相机、手势状态机、rAF 循环。
 *
 * 核心原则（架构文档 §3）：
 * - 手势期间（平移/缩放/拖拽）只改引擎内部状态，**零 store 写入、零 React 渲染**；
 * - 手势结束通过 EngineHost 回调一次性 commit（位置/选区/视口），
 *   由视图层写入 canvasStore（含撤销历史与持久化）。
 */

export interface ViewportLike {
  x: number;
  y: number;
  zoom: number;
}

export interface EngineStats extends DrawStats {
  fps: number;
  frameMs: number;
  zoom: number;
  total: number;
}

export interface EngineHost {
  /** 选区变化（引擎 → store） */
  onSelect(ids: string[], primary: string | null): void;
  /** 拖拽真正开始（越过阈值），宿主据此打历史快照 */
  onDragStart(ids: string[]): void;
  /** 拖拽结束提交位移（世界坐标 delta） */
  onDragCommit(ids: string[], dx: number, dy: number): void;
  /** 视口手势结束（平移/缩放/全览） */
  onViewportCommit(viewport: ViewportLike): void;
  /** 光标样式变化 */
  onCursor(cursor: string): void;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startSx: number; startSy: number; startCamX: number; startCamY: number; moved: boolean }
  | {
      kind: 'drag';
      /** 需要提交位置变更的节点（选中集合，已含父子去重的由视图层处理） */
      ids: string[];
      /** 渲染时整体位移的集合（选中集合 + 其全部后代，子节点随父移动） */
      renderIds: Set<string>;
      startWorldX: number;
      startWorldY: number;
      dx: number;
      dy: number;
      moved: boolean;
    };

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 5;
const DRAG_THRESHOLD_PX = 3;
const VIEWPORT_COMMIT_DEBOUNCE = 200;

export class Canvas2DEngine {
  private ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private model: SceneModel | null = null;
  private grid = new SpatialGrid();
  private cam: Camera = { x: 0, y: 0, zoom: 1 };
  private vw = 800;
  private vh = 600;
  private dpr = 1;
  private theme: 'dark' | 'light' = 'dark';
  private hoverId: string | null = null;
  private selectedIds = new Set<string>();
  private gesture: Gesture = { kind: 'none' };
  private rafId = 0;
  private running = false;
  private cursor = 'grab';
  private viewportCommitTimer: ReturnType<typeof setTimeout> | null = null;

  private stats: EngineStats = { fps: 0, frameMs: 0, visible: 0, edgesDrawn: 0, calls: 0, zoom: 1, total: 0 };
  private fpsFrames = 0;
  private fpsT0 = 0;
  private ema = 16;

  constructor(private host: EngineHost) {}

  /* ---------- 生命周期 ---------- */

  attach(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
  }

  resize(w: number, h: number, dpr: number): void {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
    this.dpr = dpr;
    if (this.canvas) {
      this.canvas.width = Math.round(this.vw * dpr);
      this.canvas.height = Math.round(this.vh * dpr);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (t: number) => {
      if (!this.running) return;
      this.frameOnce(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.viewportCommitTimer) clearTimeout(this.viewportCommitTimer);
    this.viewportCommitTimer = null;
  }

  /* ---------- 数据同步 ---------- */

  setModel(model: SceneModel | null): void {
    this.model = model;
    this.grid.rebuild(model ? model.nodes : []);
    // 清理已消失节点的选中/悬停态
    if (model) {
      for (const id of [...this.selectedIds]) {
        if (!model.byId.has(id)) this.selectedIds.delete(id);
      }
      if (this.hoverId && !model.byId.has(this.hoverId)) this.hoverId = null;
    }
    this.stats.total = model ? model.total : 0;
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.theme = theme;
  }

  /** 外部（store）驱动选区变化时调用 */
  setSelection(ids: Iterable<string>): void {
    this.selectedIds = new Set(ids);
  }

  getSelectedIds(): ReadonlySet<string> {
    return this.selectedIds;
  }

  /* ---------- 相机 ---------- */

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom };
  }

  /** 输出与 React Flow Viewport 兼容的值：screen = world * zoom + (x, y) */
  getViewport(): ViewportLike {
    return { x: -this.cam.x * this.cam.zoom, y: -this.cam.y * this.cam.zoom, zoom: this.cam.zoom };
  }

  adoptViewport(vp: ViewportLike): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom || 1));
    this.cam = { x: -vp.x / zoom, y: -vp.y / zoom, zoom };
  }

  fitView(pad = 60): void {
    if (!this.model || this.model.total === 0) return;
    const b = this.model.bounds;
    if (b.w <= 0 && b.h <= 0) return;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((this.vw - pad * 2) / b.w, (this.vh - pad * 2) / b.h)));
    this.cam = { x: b.x + b.w / 2 - this.vw / 2 / zoom, y: b.y + b.h / 2 - this.vh / 2 / zoom, zoom };
    this.scheduleViewportCommit();
  }

  zoomBy(factor: number, centerSx = this.vw / 2, centerSy = this.vh / 2): void {
    const w0 = this.toWorld(centerSx, centerSy);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.cam = { x: w0.x - centerSx / zoom, y: w0.y - centerSy / zoom, zoom };
  }

  private scheduleViewportCommit(): void {
    if (this.viewportCommitTimer) clearTimeout(this.viewportCommitTimer);
    this.viewportCommitTimer = setTimeout(() => {
      this.viewportCommitTimer = null;
      this.host.onViewportCommit(this.getViewport());
    }, VIEWPORT_COMMIT_DEBOUNCE);
  }

  /* ---------- 手势 ---------- */

  pointerDown(sx: number, sy: number, shiftKey: boolean): void {
    if (!this.model) return;
    const w = this.toWorld(sx, sy);
    const hit = this.grid.hitTest(w.x, w.y);
    if (hit) {
      if (shiftKey) {
        if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
        else this.selectedIds.add(hit.id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set([hit.id]);
      }
      const ids = [...this.selectedIds];
      this.host.onSelect(ids, ids.length > 0 ? ids[ids.length - 1] : null);
      this.gesture = {
        kind: 'drag',
        ids,
        renderIds: this.expandWithDescendants(ids),
        startWorldX: w.x,
        startWorldY: w.y,
        dx: 0,
        dy: 0,
        moved: false,
      };
      this.setCursor('move');
    } else {
      if (!shiftKey && this.selectedIds.size > 0) {
        this.selectedIds = new Set();
        this.host.onSelect([], null);
      }
      this.gesture = { kind: 'pan', startSx: sx, startSy: sy, startCamX: this.cam.x, startCamY: this.cam.y, moved: false };
      this.setCursor('grabbing');
    }
  }

  pointerMove(sx: number, sy: number): void {
    const g = this.gesture;
    if (g.kind === 'drag') {
      const w = this.toWorld(sx, sy);
      g.dx = w.x - g.startWorldX;
      g.dy = w.y - g.startWorldY;
      if (!g.moved && Math.hypot(g.dx * this.cam.zoom, g.dy * this.cam.zoom) > DRAG_THRESHOLD_PX) {
        g.moved = true;
        this.host.onDragStart(g.ids);
      }
      return;
    }
    if (g.kind === 'pan') {
      g.moved = true;
      this.cam.x = g.startCamX - (sx - g.startSx) / this.cam.zoom;
      this.cam.y = g.startCamY - (sy - g.startSy) / this.cam.zoom;
      return;
    }
    // hover
    if (!this.model) return;
    const w = this.toWorld(sx, sy);
    const hit = this.grid.hitTest(w.x, w.y);
    const nextHover = hit ? hit.id : null;
    if (nextHover !== this.hoverId) {
      this.hoverId = nextHover;
      this.setCursor(nextHover ? 'move' : 'grab');
    }
  }

  pointerUp(): void {
    const g = this.gesture;
    if (g.kind === 'drag' && g.moved) {
      this.host.onDragCommit(g.ids, g.dx, g.dy);
    } else if (g.kind === 'pan' && g.moved) {
      this.scheduleViewportCommit();
    }
    this.gesture = { kind: 'none' };
    this.setCursor(this.hoverId ? 'move' : 'grab');
  }

  wheel(sx: number, sy: number, deltaY: number): void {
    const factor = Math.exp(-deltaY * 0.0015);
    const w0 = this.toWorld(sx, sy);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.cam = { x: w0.x - sx / zoom, y: w0.y - sy / zoom, zoom };
    this.scheduleViewportCommit();
  }

  clearSelection(): void {
    if (this.selectedIds.size === 0) return;
    this.selectedIds = new Set();
    this.host.onSelect([], null);
  }

  private expandWithDescendants(ids: string[]): Set<string> {
    const set = new Set(ids);
    if (!this.model || this.model.parentOf.size === 0) return set;
    const childrenOf = new Map<string, string[]>();
    for (const [id, parent] of this.model.parentOf) {
      if (!parent) continue;
      let list = childrenOf.get(parent);
      if (!list) childrenOf.set(parent, (list = []));
      list.push(id);
    }
    const stack = [...ids];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      const kids = childrenOf.get(cur);
      if (!kids) continue;
      for (const kid of kids) {
        if (!set.has(kid)) {
          set.add(kid);
          stack.push(kid);
        }
      }
    }
    return set;
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.host.onCursor(cursor);
  }

  getStats(): EngineStats {
    return this.stats;
  }

  /* ---------- 帧循环 ---------- */

  frameOnce(t: number): void {
    const t0 = performance.now();
    if (this.ctx && this.model) {
      const g = this.gesture;
      const dragging = g.kind === 'drag' && g.moved;
      const drawn = drawScene({
        ctx: this.ctx,
        model: this.model,
        grid: this.grid,
        cam: this.cam,
        vw: this.vw,
        vh: this.vh,
        dpr: this.dpr,
        theme: this.theme,
        time: t,
        hoverId: this.hoverId,
        selectedIds: this.selectedIds,
        dragIds: dragging ? g.renderIds : EMPTY_SET,
        dragDx: dragging ? g.dx : 0,
        dragDy: dragging ? g.dy : 0,
        preferOriginal: this.cam.zoom >= RENDER_CONSTANTS.ORIGINAL_ZOOM,
        onImageReady: () => {
          /* 连续 rAF 循环下无需显式 invalidate；保留钩子供未来脏标记模式使用 */
        },
      });
      this.stats.visible = drawn.visible;
      this.stats.edgesDrawn = drawn.edgesDrawn;
      this.stats.calls = drawn.calls;
    }
    const t1 = performance.now();
    this.ema = this.ema * 0.9 + (t1 - t0) * 0.1;
    this.stats.frameMs = this.ema;
    this.stats.zoom = this.cam.zoom;
    this.fpsFrames++;
    if (!this.fpsT0) this.fpsT0 = t0;
    if (t0 - this.fpsT0 >= 500) {
      this.stats.fps = Math.round((this.fpsFrames * 1000) / (t0 - this.fpsT0));
      this.fpsFrames = 0;
      this.fpsT0 = t0;
    }
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
