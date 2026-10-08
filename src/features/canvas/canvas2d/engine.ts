import {
  drawScene,
  RENDER_CONSTANTS,
  type Camera,
  type DrawStats,
  type MinimapLayout,
  type SnapGuideLine,
} from './renderer';
import type { RenderNode, SceneModel } from './sceneModel';
import { collectFollowCluster, SpatialGrid } from './spatialGrid';

/**
 * Canvas2D 画布引擎 v1：相机、手势状态机、磁吸、rAF 循环。
 *
 * 核心原则：手势期间零 store 写入、零 React 渲染；手势结束经 EngineHost
 * 回调一次性 commit（位置/尺寸/选区/连线/视口），由视图层写入 canvasStore。
 *
 * 手势清单：
 * - 左键拖节点：移动（Alt=复制后移动；磁吸开启时对齐参考线，贴合节点跟随移动）
 * - 左键拖空白：平移画布
 * - 右键拖 / Ctrl(⌘)+左键拖：框选（部分相交即选中）
 * - 右键单击：上下文菜单（节点/空白）
 * - 拖拽连接桩：连线（落到节点=连接；落到空白=新建节点菜单；Esc 取消）
 * - 选中单节点右下角手柄：缩放尺寸
 * - 双击节点/空白：查看图片 / 新建节点菜单
 * - 滚轮：以光标为中心缩放；WASD：平移（读取设置）
 * - 小地图：点击/拖拽导航
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

export type ConnectHandleType = 'source' | 'target';

export interface LocalPoint {
  sx: number;
  sy: number;
  world: { x: number; y: number };
}

export interface EngineHost {
  onSelect(ids: string[], primary: string | null): void;
  onDragStart(ids: string[]): void;
  onDragCommit(ids: string[], dx: number, dy: number): void;
  /** Alt+拖拽：请求复制，返回新节点 id（与入参等长、顺序一致），失败返回 null */
  onDragRequestDuplicate(ids: string[]): string[] | null;
  onResizeStart(id: string): void;
  onResizeCommit(id: string, width: number, height: number): void;
  onViewportCommit(viewport: ViewportLike): void;
  onCursor(cursor: string): void;
  onConnect(sourceId: string, targetId: string): void;
  onConnectEndEmpty(payload: { nodeId: string; handleType: ConnectHandleType } & LocalPoint): void;
  onContextMenu(payload: { nodeId: string | null } & LocalPoint): void;
  onNodeDoubleClick(nodeId: string): void;
  onCanvasDoubleClick(p: LocalPoint): void;
}

export type ConnectionValidator = (sourceId: string, targetId: string) => boolean;

interface AxisLock {
  edge: 'left' | 'top' | 'right' | 'bottom';
  line: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startSx: number; startSy: number; startCamX: number; startCamY: number; moved: boolean }
  | {
      kind: 'drag';
      ids: string[];
      renderIds: Set<string>;
      /** 磁吸跟随簇：与被拖集合贴合的节点随动（不含被拖集合自身） */
      followIds: Set<string>;
      baseRect: Rect;
      startWorldX: number;
      startWorldY: number;
      rawDx: number;
      rawDy: number;
      dx: number;
      dy: number;
      moved: boolean;
      duplicated: boolean;
      xLock: AxisLock | null;
      yLock: AxisLock | null;
    }
  | { kind: 'marquee'; startWorldX: number; startWorldY: number; curWorldX: number; curWorldY: number }
  | {
      kind: 'connect';
      nodeId: string;
      handleType: ConnectHandleType;
      anchorX: number;
      anchorY: number;
      cursorX: number;
      cursorY: number;
      targetId: string | null;
      targetValid: boolean;
      moved: boolean;
    }
  | {
      kind: 'resize';
      id: string;
      startWorldX: number;
      startWorldY: number;
      origW: number;
      origH: number;
      curW: number;
      curH: number;
      moved: boolean;
    }
  | { kind: 'minimap'; moved: boolean }
  | { kind: 'rightPending'; startSx: number; startSy: number; hitId: string | null; moved: boolean };

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 5;
const DRAG_THRESHOLD_PX = 3;
const CONNECT_THRESHOLD_PX = 5;
const VIEWPORT_COMMIT_DEBOUNCE = 200;
const DBLCLICK_MS = 350;
const DBLCLICK_PX = 6;
const HANDLE_RADIUS_PX = 9;
const RESIZE_HANDLE_PX = 9;
const MIN_NODE_W = 60;
const MIN_NODE_H = 40;
const MINIMAP_W = 190;
const MINIMAP_H = 120;
const MINIMAP_MARGIN = 12;
/** 相机静止多久后才允许切换原图层级（毫秒）：运动期只用 preview，防解码风暴 */
const CAMERA_SETTLE_MS = 300;
const SNAP_ENTER_PX = 14;
const SNAP_RELEASE_PX = 40;
const CROSS_PROXIMITY_PX = 6;

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/* ---------------- 磁吸（对齐参考线 + 滞回锁定的纯计算部分） ---------------- */

function resolveAxisSnap(
  axis: 'x' | 'y',
  dragged: Rect,
  targets: Rect[],
  currentLock: AxisLock | null,
  zoom: number,
): { offset: number; lock: AxisLock | null } {
  const nearKey = axis === 'x' ? 'left' : 'top';
  const farKey = axis === 'x' ? 'right' : 'bottom';
  const enterTh = SNAP_ENTER_PX / zoom;
  const releaseTh = SNAP_RELEASE_PX / zoom;
  const crossTh = CROSS_PROXIMITY_PX / zoom;

  if (currentLock) {
    const draggedEdgeCoord = currentLock.edge === nearKey ? dragged[nearKey] : dragged[farKey];
    const dist = currentLock.line - draggedEdgeCoord;
    if (Math.abs(dist) <= releaseTh) {
      return { offset: dist, lock: currentLock };
    }
  }

  let best: { offset: number; line: number; edge: AxisLock['edge']; abs: number } | null = null;
  const dNear = dragged[nearKey];
  const dFar = dragged[farKey];

  for (const t of targets) {
    const crossGap =
      axis === 'x'
        ? Math.max(dragged.top - t.bottom, t.top - dragged.bottom, 0)
        : Math.max(dragged.left - t.right, t.left - dragged.right, 0);
    if (crossGap > crossTh) continue;

    const candidates: Array<{ offset: number; line: number; edge: AxisLock['edge'] }> = [
      { offset: t[nearKey] - dNear, line: t[nearKey], edge: nearKey },
      { offset: t[farKey] - dFar, line: t[farKey], edge: farKey },
      { offset: t[nearKey] - dFar, line: t[nearKey], edge: farKey },
      { offset: t[farKey] - dNear, line: t[farKey], edge: nearKey },
    ];
    for (const c of candidates) {
      const abs = Math.abs(c.offset);
      if (abs <= enterTh && (!best || abs < best.abs)) {
        best = { ...c, abs };
      }
    }
  }

  if (best) {
    return { offset: best.offset, lock: { edge: best.edge, line: best.line } };
  }
  return { offset: 0, lock: null };
}

/* ---------------- 引擎 ---------------- */

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
  private hoverHandle: { nodeId: string; handle: ConnectHandleType } | null = null;
  private selectedIds = new Set<string>();
  private gesture: Gesture = { kind: 'none' };
  private rafId = 0;
  private running = false;
  private cursor = 'grab';
  private viewportCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private validator: ConnectionValidator | null = null;
  /** 当前以 DOM 岛形式渲染的节点（画布跳过其卡片/手柄绘制） */
  private domIslands: ReadonlySet<string> = new Set<string>();
  private snapEnabled = false;
  private guides: SnapGuideLine[] = [];
  private wasd = { enabled: false, sensitivity: 60 };
  private wasdKeys = new Set<string>();
  private wasdActive = false;
  private lastFrameT = 0;
  private lastUpTime = 0;
  private lastUpSx = 0;
  private lastUpSy = 0;
  private lastUpHit: string | null = null;
  private minimapLayout: MinimapLayout | null = null;
  private resizeOverride: { id: string; w: number; h: number } | null = null;
  private cameraListeners = new Set<() => void>();
  private lastCamKey = '';
  private lastCameraMoveT = 0;

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

  setSelection(ids: Iterable<string>): void {
    this.selectedIds = new Set(ids);
  }

  getSelectedIds(): ReadonlySet<string> {
    return this.selectedIds;
  }

  setConnectionValidator(fn: ConnectionValidator | null): void {
    this.validator = fn;
  }

  /** 标记以 DOM 岛渲染的节点集合（渲染层跳过这些节点的卡片与手柄） */
  setDomIslands(ids: ReadonlySet<string>): void {
    this.domIslands = ids;
  }

  getDomIslands(): ReadonlySet<string> {
    return this.domIslands;
  }

  /** 视口像素尺寸（DOM 岛覆盖判定用） */
  getViewSize(): { w: number; h: number } {
    return { w: this.vw, h: this.vh };
  }

  /** 拖拽手势实时偏移（DOM 岛跟随用）；非拖拽返回 null */
  getDragOffset(): { ids: ReadonlySet<string>; dx: number; dy: number } | null {
    const g = this.gesture;
    if (g.kind !== 'drag' || !g.moved) return null;
    return { ids: g.renderIds, dx: g.dx, dy: g.dy };
  }

  /** 从 DOM 连接桩发起连线手势（screen 局部坐标） */
  beginConnect(nodeId: string, handleType: ConnectHandleType, sx: number, sy: number): void {
    if (!this.model) return;
    const n = this.model.byId.get(nodeId);
    if (!n) return;
    const w = this.toWorld(sx, sy);
    const anchor =
      handleType === 'source'
        ? { x: n.x + n.w, y: n.y + n.h / 2 }
        : { x: n.x, y: n.y + n.h / 2 };
    this.gesture = {
      kind: 'connect',
      nodeId,
      handleType,
      anchorX: anchor.x,
      anchorY: anchor.y,
      cursorX: w.x,
      cursorY: w.y,
      targetId: null,
      targetValid: false,
      moved: true,
    };
    this.setCursor('crosshair');
  }

  setSnapEnabled(enabled: boolean): void {
    this.snapEnabled = enabled;
    if (!enabled) this.guides = [];
  }

  setWasdConfig(enabled: boolean, sensitivity: number): void {
    this.wasd = { enabled, sensitivity };
    if (!enabled) this.wasdKeys.clear();
  }

  setWasdKey(key: string, down: boolean): void {
    if (down) this.wasdKeys.add(key);
    else this.wasdKeys.delete(key);
  }

  /* ---------- 相机 ---------- */

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.cam.x) * this.cam.zoom, y: (wy - this.cam.y) * this.cam.zoom };
  }

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

  centerOnWorld(wx: number, wy: number): void {
    this.cam.x = wx - this.vw / 2 / this.cam.zoom;
    this.cam.y = wy - this.vh / 2 / this.cam.zoom;
    this.scheduleViewportCommit();
  }

  zoomBy(factor: number, centerSx = this.vw / 2, centerSy = this.vh / 2): void {
    const w0 = this.toWorld(centerSx, centerSy);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.cam = { x: w0.x - centerSx / zoom, y: w0.y - centerSy / zoom, zoom };
  }

  selectAll(): void {
    if (!this.model) return;
    const ids = this.model.nodes.filter((n) => !n.isGroup).map((n) => n.id);
    this.selectedIds = new Set(ids);
    this.host.onSelect(ids, ids.length > 0 ? ids[ids.length - 1] : null);
  }

  clearSelection(): void {
    if (this.selectedIds.size === 0) return;
    this.selectedIds = new Set();
    this.host.onSelect([], null);
  }

  cancelGesture(): void {
    const g = this.gesture;
    if (g.kind === 'connect') {
      this.gesture = { kind: 'none' };
      this.setCursor('grab');
    }
  }

  private scheduleViewportCommit(): void {
    if (this.viewportCommitTimer) clearTimeout(this.viewportCommitTimer);
    this.viewportCommitTimer = setTimeout(() => {
      this.viewportCommitTimer = null;
      this.host.onViewportCommit(this.getViewport());
    }, VIEWPORT_COMMIT_DEBOUNCE);
  }

  /* ---------- 命中辅助 ---------- */

  private nodeRect(n: RenderNode): Rect {
    return { left: n.x, top: n.y, right: n.x + n.w, bottom: n.y + n.h };
  }

  private findHandleAt(wx: number, wy: number): { nodeId: string; handle: ConnectHandleType } | null {
    if (!this.model || this.cam.zoom < RENDER_CONSTANTS.LOD0_ZOOM) return null;
    const r = HANDLE_RADIUS_PX / this.cam.zoom;
    const candidates = this.grid.queryRect({ x: wx - r, y: wy - r, w: r * 2, h: r * 2 });
    let best: { nodeId: string; handle: ConnectHandleType; dist: number } | null = null;
    for (const idx of candidates) {
      const n = this.model.nodes[idx];
      if (!n || n.isGroup || n.kind === 'tag' || n.kind === 'tagGroup') continue;
      const points: Array<{ handle: ConnectHandleType; x: number; y: number; ok: boolean }> = [
        { handle: 'source', x: n.x + n.w, y: n.y + n.h / 2, ok: n.canSource },
        { handle: 'target', x: n.x, y: n.y + n.h / 2, ok: n.canTarget },
      ];
      for (const p of points) {
        if (!p.ok) continue;
        const d = Math.hypot(p.x - wx, p.y - wy);
        if (d <= r && (!best || d < best.dist)) {
          best = { nodeId: n.id, handle: p.handle, dist: d };
        }
      }
    }
    return best ? { nodeId: best.nodeId, handle: best.handle } : null;
  }

  private findResizeHandleAt(wx: number, wy: number): string | null {
    if (this.selectedIds.size !== 1) return null;
    const id = [...this.selectedIds][0];
    const n = this.model?.byId.get(id);
    if (!n || n.isGroup || n.kind === 'tag' || n.kind === 'tagGroup') return null;
    const r = RESIZE_HANDLE_PX / this.cam.zoom;
    const hx = n.x + n.w;
    const hy = n.y + n.h;
    return Math.abs(wx - hx) <= r && Math.abs(wy - hy) <= r ? id : null;
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

  private unionRect(ids: Iterable<string>): Rect | null {
    if (!this.model) return null;
    let rect: Rect | null = null;
    for (const id of ids) {
      const n = this.model.byId.get(id);
      if (!n) continue;
      const r = this.nodeRect(n);
      if (!rect) rect = { ...r };
      else {
        rect.left = Math.min(rect.left, r.left);
        rect.top = Math.min(rect.top, r.top);
        rect.right = Math.max(rect.right, r.right);
        rect.bottom = Math.max(rect.bottom, r.bottom);
      }
    }
    return rect;
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.host.onCursor(cursor);
  }

  getCursor(): string {
    return this.cursor;
  }

  getStats(): EngineStats {
    return this.stats;
  }

  /** 相机变化监听（浮动 DOM 工具栏定位用；DOM 直写、不触发 React 渲染） */
  addCameraListener(cb: () => void): () => void {
    this.cameraListeners.add(cb);
    return () => {
      this.cameraListeners.delete(cb);
    };
  }

  private notifyCameraIfMoved(): void {
    if (this.cameraListeners.size === 0) return;
    const key = `${this.cam.x.toFixed(1)}|${this.cam.y.toFixed(1)}|${this.cam.zoom.toFixed(4)}`;
    if (key === this.lastCamKey) return;
    this.lastCamKey = key;
    this.lastCameraMoveT = performance.now();
    for (const cb of this.cameraListeners) cb();
  }

  isGestureActive(): boolean {
    return this.gesture.kind !== 'none';
  }

  /** 当前选区的世界包围盒（含分组后代展开；拖拽手势期间叠加实时偏移） */
  getSelectionWorldRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.model || this.selectedIds.size === 0) return null;
    const g = this.gesture;
    const dragging = g.kind === 'drag' && g.moved;
    const ids = dragging ? g.renderIds : this.expandWithDescendants([...this.selectedIds]);
    const rect = this.unionRect(ids);
    if (!rect) return null;
    const dx = dragging ? g.dx : 0;
    const dy = dragging ? g.dy : 0;
    return {
      x: rect.left + dx,
      y: rect.top + dy,
      w: rect.right - rect.left,
      h: rect.bottom - rect.top,
    };
  }

  /* ---------- 小地图 ---------- */

  private computeMinimapLayout(): MinimapLayout | null {
    if (!this.model || this.model.total === 0) return null;
    const view = { x: this.cam.x, y: this.cam.y, w: this.vw / this.cam.zoom, h: this.vh / this.cam.zoom };
    const b = this.model.bounds;
    const wx = Math.min(b.x, view.x);
    const wy = Math.min(b.y, view.y);
    const wx2 = Math.max(b.x + b.w, view.x + view.w);
    const wy2 = Math.max(b.y + b.h, view.y + view.h);
    const worldW = Math.max(1, wx2 - wx);
    const worldH = Math.max(1, wy2 - wy);
    const x = this.vw - MINIMAP_W - MINIMAP_MARGIN;
    const y = this.vh - MINIMAP_H - MINIMAP_MARGIN;
    const scale = Math.min((MINIMAP_W - 12) / worldW, (MINIMAP_H - 12) / worldH);
    return { x, y, w: MINIMAP_W, h: MINIMAP_H, worldX: wx, worldY: wy, worldW, worldH, scale };
  }

  private inMinimap(sx: number, sy: number): boolean {
    const m = this.minimapLayout;
    return !!m && sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h;
  }

  private minimapNavigate(sx: number, sy: number): void {
    const m = this.minimapLayout;
    if (!m) return;
    const wx = m.worldX + (sx - m.x - 6) / m.scale;
    const wy = m.worldY + (sy - m.y - 6) / m.scale;
    this.cam.x = wx - this.vw / 2 / this.cam.zoom;
    this.cam.y = wy - this.vh / 2 / this.cam.zoom;
  }

  /* ---------- 手势入口 ---------- */

  pointerDown(sx: number, sy: number, opts: { button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
    if (!this.model) return;

    if (this.inMinimap(sx, sy)) {
      this.minimapNavigate(sx, sy);
      this.gesture = { kind: 'minimap', moved: true };
      this.setCursor('grabbing');
      return;
    }

    const w = this.toWorld(sx, sy);

    // 右键：菜单或框选（与旧版右键框选行为一致）
    if (opts.button === 2) {
      const hit = this.grid.hitTest(w.x, w.y);
      if (hit && !this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set([hit.id]);
        this.host.onSelect([hit.id], hit.id);
      }
      this.gesture = { kind: 'rightPending', startSx: sx, startSy: sy, hitId: hit ? hit.id : null, moved: false };
      return;
    }

    // Ctrl/⌘ + 左键拖空白：框选（与旧版自定义选框行为一致）
    const wantMarquee = opts.ctrlKey || opts.metaKey;

    const handle = this.findHandleAt(w.x, w.y);
    if (handle && !wantMarquee) {
      const n = this.model.byId.get(handle.nodeId);
      if (n) {
        const anchor =
          handle.handle === 'source'
            ? { x: n.x + n.w, y: n.y + n.h / 2 }
            : { x: n.x, y: n.y + n.h / 2 };
        this.gesture = {
          kind: 'connect',
          nodeId: handle.nodeId,
          handleType: handle.handle,
          anchorX: anchor.x,
          anchorY: anchor.y,
          cursorX: w.x,
          cursorY: w.y,
          targetId: null,
          targetValid: false,
          moved: false,
        };
        this.setCursor('crosshair');
        return;
      }
    }

    const resizeId = !wantMarquee ? this.findResizeHandleAt(w.x, w.y) : null;
    if (resizeId) {
      const n = this.model.byId.get(resizeId);
      if (n) {
        this.gesture = {
          kind: 'resize',
          id: resizeId,
          startWorldX: w.x,
          startWorldY: w.y,
          origW: n.w,
          origH: n.h,
          curW: n.w,
          curH: n.h,
          moved: false,
        };
        this.setCursor('nwse-resize');
        return;
      }
    }

    const hit = this.grid.hitTest(w.x, w.y);
    if (hit && !wantMarquee) {
      if (opts.shiftKey) {
        if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
        else this.selectedIds.add(hit.id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set([hit.id]);
      }
      const ids = [...this.selectedIds];
      this.host.onSelect(ids, ids.length > 0 ? ids[ids.length - 1] : null);
      const dragRender = this.expandWithDescendants(ids);
      const baseRect = this.unionRect(dragRender);
      // 跟随簇：磁吸开启且非 Shift（临时单选）/ Alt（复制）拖拽时，贴合节点随动
      const followIds =
        this.snapEnabled && !opts.shiftKey && !opts.altKey
          ? collectFollowCluster(dragRender, this.model.nodes)
          : new Set<string>();
      const renderIds =
        followIds.size > 0 ? this.expandWithDescendants([...ids, ...followIds]) : dragRender;
      this.gesture = {
        kind: 'drag',
        ids,
        renderIds,
        followIds,
        baseRect: baseRect ?? { left: w.x, top: w.y, right: w.x, bottom: w.y },
        startWorldX: w.x,
        startWorldY: w.y,
        rawDx: 0,
        rawDy: 0,
        dx: 0,
        dy: 0,
        moved: false,
        duplicated: false,
        xLock: null,
        yLock: null,
      };
      this.setCursor('move');
      return;
    }

    if (wantMarquee) {
      this.gesture = { kind: 'marquee', startWorldX: w.x, startWorldY: w.y, curWorldX: w.x, curWorldY: w.y };
      this.setCursor('crosshair');
      return;
    }

    if (!opts.shiftKey && this.selectedIds.size > 0) {
      this.selectedIds = new Set();
      this.host.onSelect([], null);
    }
    this.gesture = { kind: 'pan', startSx: sx, startSy: sy, startCamX: this.cam.x, startCamY: this.cam.y, moved: false };
    this.setCursor('grabbing');
  }

  pointerMove(sx: number, sy: number, opts: { altKey: boolean }): void {
    const g = this.gesture;

    if (g.kind === 'minimap') {
      this.minimapNavigate(sx, sy);
      return;
    }
    if (g.kind === 'rightPending') {
      if (Math.hypot(sx - g.startSx, sy - g.startSy) > 4) {
        const w0 = this.toWorld(g.startSx, g.startSy);
        this.gesture = { kind: 'marquee', startWorldX: w0.x, startWorldY: w0.y, curWorldX: w0.x, curWorldY: w0.y };
        this.setCursor('crosshair');
      } else {
        return;
      }
    }

    const g2 = this.gesture;
    if (g2.kind === 'drag') {
      const w = this.toWorld(sx, sy);
      g2.rawDx = w.x - g2.startWorldX;
      g2.rawDy = w.y - g2.startWorldY;
      if (!g2.moved && Math.hypot(g2.rawDx * this.cam.zoom, g2.rawDy * this.cam.zoom) > DRAG_THRESHOLD_PX) {
        g2.moved = true;
        if (opts.altKey && !g2.duplicated) {
          const newIds = this.host.onDragRequestDuplicate(g2.ids);
          if (newIds && newIds.length > 0) {
            g2.duplicated = true;
            g2.ids = newIds;
            // 复制拖拽不带动跟随簇（跟随属于"排版保持"，副本脱离原排版）
            g2.followIds = new Set<string>();
            g2.renderIds = this.expandWithDescendants(newIds);
            this.selectedIds = new Set(newIds);
            this.host.onSelect(newIds, newIds[newIds.length - 1]);
          }
        }
        if (!g2.duplicated) {
          this.host.onDragStart(
            g2.followIds.size > 0 ? [...g2.ids, ...g2.followIds] : g2.ids,
          );
        }
      }
      // 磁吸对齐
      g2.dx = g2.rawDx;
      g2.dy = g2.rawDy;
      this.guides = [];
      if (g2.moved && this.snapEnabled && this.model) {
        const dragged: Rect = {
          left: g2.baseRect.left + g2.rawDx,
          top: g2.baseRect.top + g2.rawDy,
          right: g2.baseRect.right + g2.rawDx,
          bottom: g2.baseRect.bottom + g2.rawDy,
        };
        const targets: Rect[] = [];
        for (const n of this.model.nodes) {
          if (g2.renderIds.has(n.id)) continue;
          targets.push(this.nodeRect(n));
        }
        const sx2 = resolveAxisSnap('x', dragged, targets, g2.xLock, this.cam.zoom);
        const sy2 = resolveAxisSnap('y', dragged, targets, g2.yLock, this.cam.zoom);
        g2.xLock = sx2.lock;
        g2.yLock = sy2.lock;
        g2.dx = g2.rawDx + sx2.offset;
        g2.dy = g2.rawDy + sy2.offset;
        if (sx2.lock) this.guides.push({ orientation: 'vertical', position: sx2.lock.line });
        if (sy2.lock) this.guides.push({ orientation: 'horizontal', position: sy2.lock.line });
      } else if (g2.moved && !this.snapEnabled && this.guides.length) {
        this.guides = [];
      }
      return;
    }

    if (g2.kind === 'pan') {
      if (Math.abs(sx - g2.startSx) + Math.abs(sy - g2.startSy) > 1) g2.moved = true;
      this.cam.x = g2.startCamX - (sx - g2.startSx) / this.cam.zoom;
      this.cam.y = g2.startCamY - (sy - g2.startSy) / this.cam.zoom;
      return;
    }

    if (g2.kind === 'marquee') {
      const w = this.toWorld(sx, sy);
      g2.curWorldX = w.x;
      g2.curWorldY = w.y;
      this.updateMarqueeSelection();
      return;
    }

    if (g2.kind === 'connect') {
      const w = this.toWorld(sx, sy);
      g2.cursorX = w.x;
      g2.cursorY = w.y;
      if (Math.hypot((w.x - g2.anchorX) * this.cam.zoom, (w.y - g2.anchorY) * this.cam.zoom) > CONNECT_THRESHOLD_PX) {
        g2.moved = true;
      }
      const hit = this.grid.hitTest(w.x, w.y);
      if (hit && hit.id !== g2.nodeId && !hit.isGroup) {
        const wantTarget = g2.handleType === 'source';
        const okHandle = wantTarget ? hit.canTarget : hit.canSource;
        const okRule = this.validator
          ? wantTarget
            ? this.validator(g2.nodeId, hit.id)
            : this.validator(hit.id, g2.nodeId)
          : true;
        g2.targetId = hit.id;
        g2.targetValid = okHandle && okRule;
      } else {
        g2.targetId = null;
        g2.targetValid = false;
      }
      return;
    }

    if (g2.kind === 'resize') {
      const w = this.toWorld(sx, sy);
      g2.curW = Math.max(MIN_NODE_W, g2.origW + (w.x - g2.startWorldX));
      g2.curH = Math.max(MIN_NODE_H, g2.origH + (w.y - g2.startWorldY));
      if (!g2.moved && (Math.abs(g2.curW - g2.origW) > 1 || Math.abs(g2.curH - g2.origH) > 1)) {
        g2.moved = true;
        this.host.onResizeStart(g2.id);
      }
      this.resizeOverride = { id: g2.id, w: g2.curW, h: g2.curH };
      return;
    }

    // hover
    const w = this.toWorld(sx, sy);
    const handle = this.findHandleAt(w.x, w.y);
    this.hoverHandle = handle;
    if (handle) {
      this.setCursor('crosshair');
      this.hoverId = null;
      return;
    }
    if (this.inMinimap(sx, sy)) {
      this.hoverId = null;
      this.setCursor('pointer');
      return;
    }
    const resizeId = this.findResizeHandleAt(w.x, w.y);
    if (resizeId) {
      this.hoverId = null;
      this.setCursor('nwse-resize');
      return;
    }
    const hit = this.grid.hitTest(w.x, w.y);
    const nextHover = hit ? hit.id : null;
    if (nextHover !== this.hoverId) {
      this.hoverId = nextHover;
      this.setCursor(nextHover ? 'move' : 'grab');
    }
  }

  private updateMarqueeSelection(): void {
    const g = this.gesture;
    if (g.kind !== 'marquee' || !this.model) return;
    const x = Math.min(g.startWorldX, g.curWorldX);
    const y = Math.min(g.startWorldY, g.curWorldY);
    const w = Math.abs(g.curWorldX - g.startWorldX);
    const h = Math.abs(g.curWorldY - g.startWorldY);
    const candidates = this.grid.queryRect({ x, y, w, h });
    const ids = new Set<string>();
    for (const idx of candidates) {
      const n = this.model.nodes[idx];
      if (!n || n.isGroup) continue;
      if (n.x < x + w && n.x + n.w > x && n.y < y + h && n.y + n.h > y) ids.add(n.id);
    }
    this.selectedIds = ids;
  }

  pointerUp(sx: number, sy: number): void {
    const g = this.gesture;
    const w = this.toWorld(sx, sy);

    if (g.kind === 'drag') {
      this.guides = [];
      if (g.moved) {
        if (g.duplicated) this.host.onSelect(g.ids, g.ids[g.ids.length - 1]);
        this.host.onDragCommit(
          g.followIds.size > 0 ? [...g.ids, ...g.followIds] : g.ids,
          g.dx,
          g.dy,
        );
      }
    } else if (g.kind === 'pan') {
      if (g.moved) this.scheduleViewportCommit();
    } else if (g.kind === 'marquee') {
      const ids = [...this.selectedIds];
      this.host.onSelect(ids, ids.length > 0 ? ids[ids.length - 1] : null);
    } else if (g.kind === 'connect') {
      if (g.moved) {
        if (g.targetId && g.targetValid) {
          if (g.handleType === 'source') this.host.onConnect(g.nodeId, g.targetId);
          else this.host.onConnect(g.targetId, g.nodeId);
        } else if (!g.targetId) {
          this.host.onConnectEndEmpty({ nodeId: g.nodeId, handleType: g.handleType, sx, sy, world: { x: w.x, y: w.y } });
        }
      }
    } else if (g.kind === 'resize') {
      this.resizeOverride = null;
      if (g.moved) this.host.onResizeCommit(g.id, g.curW, g.curH);
    } else if (g.kind === 'minimap') {
      this.scheduleViewportCommit();
    } else if (g.kind === 'rightPending') {
      if (!g.moved) {
        this.host.onContextMenu({ nodeId: g.hitId, sx, sy, world: { x: w.x, y: w.y } });
      } else {
        const ids = [...this.selectedIds];
        this.host.onSelect(ids, ids.length > 0 ? ids[ids.length - 1] : null);
      }
    }

    // 双击检测
    const now = performance.now();
    const hit = this.grid.hitTest(w.x, w.y);
    const hitId = hit ? hit.id : null;
    if (
      g.kind !== 'connect' &&
      now - this.lastUpTime < DBLCLICK_MS &&
      Math.hypot(sx - this.lastUpSx, sy - this.lastUpSy) < DBLCLICK_PX &&
      hitId === this.lastUpHit &&
      !(this.gesture.kind === 'drag' && (this.gesture as { moved?: boolean }).moved)
    ) {
      if (hitId) this.host.onNodeDoubleClick(hitId);
      else this.host.onCanvasDoubleClick({ sx, sy, world: { x: w.x, y: w.y } });
      this.lastUpTime = 0;
    } else {
      this.lastUpTime = now;
    }
    this.lastUpSx = sx;
    this.lastUpSy = sy;
    this.lastUpHit = hitId;

    this.gesture = { kind: 'none' };
    this.setCursor(this.hoverHandle ? 'crosshair' : this.hoverId ? 'move' : 'grab');
  }

  wheel(sx: number, sy: number, deltaY: number): void {
    const factor = Math.exp(-deltaY * 0.0015);
    const w0 = this.toWorld(sx, sy);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.cam = { x: w0.x - sx / zoom, y: w0.y - sy / zoom, zoom };
    this.scheduleViewportCommit();
  }

  /* ---------- 帧循环 ---------- */

  frameOnce(t: number): void {
    const t0 = performance.now();

    // WASD 平移
    if (this.wasd.enabled && this.wasdKeys.size > 0) {
      const dt = this.lastFrameT ? Math.min(0.05, (t - this.lastFrameT) / 1000) : 0.016;
      let mx = 0;
      let my = 0;
      if (this.wasdKeys.has('a')) mx -= 1;
      if (this.wasdKeys.has('d')) mx += 1;
      if (this.wasdKeys.has('w')) my -= 1;
      if (this.wasdKeys.has('s')) my += 1;
      if (mx !== 0 || my !== 0) {
        const speed = (this.wasd.sensitivity * dt) / this.cam.zoom;
        this.cam.x += mx * speed;
        this.cam.y += my * speed;
        if (!this.wasdActive) this.wasdActive = true;
      }
    } else if (this.wasdActive) {
      this.wasdActive = false;
      this.scheduleViewportCommit();
    }
    this.lastFrameT = t;

    if (this.ctx && this.model) {
      const g = this.gesture;
      const dragging = g.kind === 'drag' && g.moved;
      this.minimapLayout = this.computeMinimapLayout();
      const marquee =
        g.kind === 'marquee'
          ? {
              x: Math.min(g.startWorldX, g.curWorldX),
              y: Math.min(g.startWorldY, g.curWorldY),
              w: Math.abs(g.curWorldX - g.startWorldX),
              h: Math.abs(g.curWorldY - g.startWorldY),
            }
          : null;
      const connect =
        g.kind === 'connect' && g.moved
          ? {
              fromX: g.anchorX,
              fromY: g.anchorY,
              toX: g.cursorX,
              toY: g.cursorY,
              valid: g.targetValid,
              hasTarget: !!g.targetId,
            }
          : null;
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
        hoverHandle: this.hoverHandle,
        selectedIds: this.selectedIds,
        dragIds: dragging ? g.renderIds : EMPTY_SET,
        dragDx: dragging ? g.dx : 0,
        dragDy: dragging ? g.dy : 0,
        guides: this.guides,
        marqueeRect: marquee,
        selectionBounds: this.selectedIds.size > 1 ? this.getSelectionWorldRect() : null,
        domIslands: this.domIslands,
        connectPreview: connect,
        resizeOverride: this.resizeOverride,
        minimap: this.minimapLayout,
        showHandles: this.cam.zoom >= RENDER_CONSTANTS.LOD0_ZOOM,
        preferOriginal:
          this.cam.zoom >= RENDER_CONSTANTS.ORIGINAL_ZOOM &&
          t - this.lastCameraMoveT > CAMERA_SETTLE_MS,
        onImageReady: () => {
          /* 连续 rAF 循环下无需显式 invalidate */
        },
      });
      this.stats.visible = drawn.visible;
      this.stats.edgesDrawn = drawn.edgesDrawn;
      this.stats.calls = drawn.calls;
    }
    this.notifyCameraIfMoved();
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
