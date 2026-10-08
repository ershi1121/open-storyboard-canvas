import {
  buildAvoidRects,
  polylineMidpoint,
  sampleOrthogonal,
  sampleSpline,
  type EdgeRoutingMode,
  type Pt,
} from './edgeGeometry';
import type { SceneModel } from './sceneModel';
import type { SpatialGrid } from './spatialGrid';

/**
 * Canvas2D 渲染器：纯绘制，无状态、无 React。
 *
 * 每帧流程：清屏 → 点阵背景 → 边 → 节点（网格裁剪 + 三级 LOD）。
 * LOD 策略：
 *   L0 (zoom < 0.28)  缩略图 + 边框 + 状态点（全览模式，千级节点的主力档位）
 *   L1 (zoom < 0.75)  + 标题栏 / 徽标 / 文本预览
 *   L2 (zoom >= 0.75) + 阴影 / 进度脉冲 / 选中手柄 / 悬停高亮
 * 文字采用"屏幕恒定"策略：zoom <= 1 时字号补偿 1/zoom（始终可读），
 * zoom > 1 时回归世界固定尺寸（与 DOM 节点视觉一致）。
 */

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface DrawStats {
  visible: number;
  edgesDrawn: number;
  calls: number;
}

export interface SnapGuideLine {
  orientation: 'vertical' | 'horizontal';
  position: number;
}

export interface MinimapLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  worldX: number;
  worldY: number;
  worldW: number;
  worldH: number;
  scale: number;
}

export interface DrawSceneOptions {
  ctx: CanvasRenderingContext2D;
  model: SceneModel;
  grid: SpatialGrid;
  cam: Camera;
  vw: number;
  vh: number;
  dpr: number;
  theme: 'dark' | 'light';
  time: number;
  selectedIds: ReadonlySet<string>;
  dragIds: ReadonlySet<string>;
  dragDx: number;
  dragDy: number;
  guides: SnapGuideLine[];
  marqueeRect: { x: number; y: number; w: number; h: number } | null;
  /** 多选联合包围盒（世界坐标），选中 ≥2 个节点时绘制浅色虚线框 */
  selectionBounds: { x: number; y: number; w: number; h: number } | null;
  selectedEdgeId: string | null;
  hoverEdgeId: string | null;
  edgeRoutingMode: EdgeRoutingMode;
  connectPreview: { fromX: number; fromY: number; toX: number; toY: number; valid: boolean; hasTarget: boolean } | null;
  minimap: MinimapLayout | null;
}

interface Palette {
  theme: 'dark' | 'light';
  bg: string;
  cardBg: string;
  cardBorder: string;
  headerBg: string;
  titleText: string;
  mutedText: string;
  dot: string;
  edgeIdle: string;
  shadow: string;
  placeholderText: string;
}

const DARK: Palette = {
  theme: 'dark',
  bg: '#0f131c',
  cardBg: '#1c2333',
  cardBorder: 'rgba(255,255,255,0.14)',
  headerBg: 'rgba(255,255,255,0.055)',
  titleText: '#e5eaf3',
  mutedText: '#93a0b8',
  dot: 'rgba(148,163,184,0.16)',
  edgeIdle: 'rgba(148,163,184,0.32)',
  shadow: 'rgba(0,0,0,0.35)',
  placeholderText: 'rgba(226,232,240,0.5)',
};

const LIGHT: Palette = {
  theme: 'light',
  bg: '#f4f6fa',
  cardBg: '#ffffff',
  cardBorder: 'rgba(15,23,42,0.14)',
  headerBg: 'rgba(15,23,42,0.04)',
  titleText: '#0f172a',
  mutedText: '#64748b',
  dot: 'rgba(100,116,139,0.28)',
  edgeIdle: 'rgba(71,85,105,0.38)',
  shadow: 'rgba(15,23,42,0.16)',
  placeholderText: 'rgba(51,65,85,0.45)',
};

const GEN_COLOR = '#34d399';
const FAIL_COLOR = '#f87171';
const SELECT_COLOR = '#38bdf8';


function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 屏幕恒定字号：zoom<=1 补偿，zoom>1 世界固定 */



/** CJK 感知换行，返回最多 maxLines 行 */

function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ------------------------------------------------------------------ */

function drawDotGrid(ctx: CanvasRenderingContext2D, cam: Camera, vw: number, vh: number, dpr: number, P: Palette, calls: { n: number }): void {
  const spacings = [100, 250, 500, 1000, 2500, 5000];
  let spacing = 0;
  for (const s of spacings) {
    if (s * cam.zoom >= 26) {
      spacing = s;
      break;
    }
  }
  if (!spacing) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.dot;
  const startX = Math.floor(cam.x / spacing) * spacing;
  const startY = Math.floor(cam.y / spacing) * spacing;
  const endX = cam.x + vw / cam.zoom;
  const endY = cam.y + vh / cam.zoom;
  for (let wx = startX; wx <= endX; wx += spacing) {
    for (let wy = startY; wy <= endY; wy += spacing) {
      const sx = (wx - cam.x) * cam.zoom;
      const sy = (wy - cam.y) * cam.zoom;
      ctx.fillRect(sx, sy, 1.4, 1.4);
      calls.n++;
    }
  }
}

/* ---------- 边路由点列缓存（model 身份 + 端点位置为 key） ---------- */
interface RouteCacheEntry {
  pts: Pt[];
  ax: number;
  ay: number;
  bx: number;
  by: number;
}
let routeCache = new Map<string, RouteCacheEntry>();
let routeCacheModel: unknown = null;

function edgePoints(
  edgeId: string,
  model: SceneModel,
  ax: number, ay: number, bx: number, by: number,
  mode: EdgeRoutingMode,
  avoidRects: ReturnType<typeof buildAvoidRects> | null,
): Pt[] {
  if (routeCacheModel !== model) {
    routeCacheModel = model;
    routeCache = new Map();
  }
  const hit = routeCache.get(edgeId);
  if (
    hit &&
    Math.abs(hit.ax - ax) < 0.5 && Math.abs(hit.ay - ay) < 0.5 &&
    Math.abs(hit.bx - bx) < 0.5 && Math.abs(hit.by - by) < 0.5
  ) {
    return hit.pts;
  }
  const pts =
    mode === 'spline'
      ? sampleSpline(ax, ay, bx, by)
      : sampleOrthogonal(
          ax, ay, 'right', bx, by, 'left',
          mode === 'smartOrthogonal' ? (avoidRects ?? []) : [],
        );
  routeCache.set(edgeId, { pts, ax, ay, bx, by });
  return pts;
}

/** 三股拧麻花流光（画布版）：沿点列正弦偏移三股，粗细/透明度分层 */
function drawFlowStrands(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  color: string,
  time: number,
  zoom: number,
  speed: number,
): number {
  if (pts.length < 2) return 0;
  const amp = 3.2 / zoom;
  const strands: Array<{ w: number; a: number; ph: number }> = [
    { w: 2.2 / zoom, a: 0.85, ph: 0 },
    { w: 1.5 / zoom, a: 0.5, ph: 2.09 },
    { w: 1.0 / zoom, a: 0.32, ph: 4.19 },
  ];
  let calls = 0;
  for (const strand of strands) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(i + 1, pts.length - 1)];
      const o = pts[Math.max(i - 1, 0)];
      const dx = q.x - o.x;
      const dy = q.y - o.y;
      const len = Math.hypot(dx, dy) || 1;
      const wave = Math.sin(time * 0.006 * speed + i * 0.55 + strand.ph);
      const x = p.x + (-dy / len) * wave * amp;
      const y = p.y + (dx / len) * wave * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = strand.a;
    ctx.lineWidth = strand.w;
    ctx.stroke();
    ctx.globalAlpha = 1;
    calls++;
  }
  return calls;
}

function drawEdges(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions, P: Palette, view: { x: number; y: number; w: number; h: number }): number {
  const { model, cam, time, dragIds, dragDx, dragDy } = opts;
  let drawn = 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const smart = opts.edgeRoutingMode === 'smartOrthogonal';
  let avoidRects: ReturnType<typeof buildAvoidRects> | null = null;
  for (const edge of model.edges) {
    const a = model.byId.get(edge.sourceId);
    const b = model.byId.get(edge.targetId);
    if (!a || !b) continue;
    const adx = dragIds.has(a.id) ? dragDx : 0;
    const ady = dragIds.has(a.id) ? dragDy : 0;
    const bdx = dragIds.has(b.id) ? dragDx : 0;
    const bdy = dragIds.has(b.id) ? dragDy : 0;
    const ax = a.x + a.w + adx;
    const ay = a.y + a.h / 2 + ady;
    const bx = b.x + bdx;
    const by = b.y + b.h / 2 + bdy;
    const pad = 160;
    if (
      Math.max(ax, bx) + pad < view.x ||
      Math.min(ax, bx) - pad > view.x + view.w ||
      Math.max(ay, by) + pad < view.y ||
      Math.min(ay, by) - pad > view.y + view.h
    ) {
      continue;
    }
    if (smart && avoidRects === null) {
      avoidRects = buildAvoidRects(model.nodes, '', '__none__');
    }
    const pts = edgePoints(edge.id, model, ax, ay, bx, by, opts.edgeRoutingMode, avoidRects);
    const selected = opts.selectedEdgeId === edge.id;
    const hovered = opts.hoverEdgeId === edge.id;
    const showFlow = edge.state !== 'idle' || selected;

    // 底线
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (edge.state === 'gen') {
      ctx.strokeStyle = GEN_COLOR;
      ctx.lineWidth = 2 / cam.zoom;
    } else if (edge.state === 'fail') {
      ctx.strokeStyle = hexToRgba(FAIL_COLOR, 0.65);
      ctx.lineWidth = 1.6 / cam.zoom;
    } else if (selected) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 2.4 / cam.zoom;
    } else if (hovered) {
      ctx.strokeStyle = 'rgba(148,197,255,0.8)';
      ctx.lineWidth = 1.8 / cam.zoom;
    } else {
      ctx.strokeStyle = P.edgeIdle;
      ctx.lineWidth = 1.4 / cam.zoom;
    }
    ctx.stroke();
    drawn++;

    // 流光：生成中加速 / 失败常显 / 选中显示（旧版触发规则）
    if (showFlow) {
      const color = edge.state === 'gen' ? GEN_COLOR : edge.state === 'fail' ? FAIL_COLOR : SELECT_COLOR;
      const speed = edge.state === 'gen' ? 2.2 : edge.state === 'fail' ? 0.6 : 1;
      drawn += drawFlowStrands(ctx, pts, color, time, cam.zoom, speed);
    }

    // 选中边中点：断开按钮
    if (selected) {
      const mid = polylineMidpoint(pts);
      const r = 10 / cam.zoom;
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, r, 0, Math.PI * 2);
      ctx.fillStyle = P.cardBg;
      ctx.fill();
      ctx.strokeStyle = P.cardBorder;
      ctx.lineWidth = 1.2 / cam.zoom;
      ctx.stroke();
      const c = 3.6 / cam.zoom;
      ctx.beginPath();
      ctx.moveTo(mid.x - c, mid.y - c);
      ctx.lineTo(mid.x + c, mid.y + c);
      ctx.moveTo(mid.x + c, mid.y - c);
      ctx.lineTo(mid.x - c, mid.y + c);
      ctx.strokeStyle = P.mutedText;
      ctx.lineWidth = 1.6 / cam.zoom;
      ctx.stroke();
      drawn += 3;
    }
  }
  ctx.setLineDash([]);
  return drawn;
}






/* ---------- v1 叠加层 ---------- */


function drawConnectPreview(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const c = opts.connectPreview;
  if (!c) return 0;
  const zoom = opts.cam.zoom;
  const gap = Math.max(48, Math.abs(c.toX - c.fromX) * 0.4);
  ctx.beginPath();
  ctx.moveTo(c.fromX, c.fromY);
  ctx.bezierCurveTo(c.fromX + gap, c.fromY, c.toX - gap, c.toY, c.toX, c.toY);
  ctx.strokeStyle = c.hasTarget ? (c.valid ? GEN_COLOR : FAIL_COLOR) : SELECT_COLOR;
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  ctx.lineDashOffset = (-opts.time * 0.05) / zoom;
  ctx.stroke();
  ctx.setLineDash([]);
  return 1;
}

function drawMarquee(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const m = opts.marqueeRect;
  if (!m || m.w < 1 || m.h < 1) return 0;
  const zoom = opts.cam.zoom;
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(m.x, m.y, m.w, m.h);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([4 / zoom, 3 / zoom]);
  ctx.strokeRect(m.x, m.y, m.w, m.h);
  ctx.setLineDash([]);
  return 2;
}

function drawSelectionBounds(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const b = opts.selectionBounds;
  if (!b) return 0;
  const zoom = opts.cam.zoom;
  const pad = 6 / zoom;
  ctx.fillStyle = 'rgba(56,189,248,0.05)';
  ctx.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.strokeStyle = 'rgba(56,189,248,0.55)';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  return 2;
}

function drawGuides(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions, view: { x: number; y: number; w: number; h: number }): number {
  if (opts.guides.length === 0) return 0;
  const zoom = opts.cam.zoom;
  const blue = 'rgba(59, 130, 246, 0.9)';
  ctx.strokeStyle = blue;
  ctx.lineWidth = Math.max(0.5, 1 / zoom);
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  let calls = 0;
  for (const g of opts.guides) {
    ctx.beginPath();
    if (g.orientation === 'vertical') {
      ctx.moveTo(g.position, view.y - view.h);
      ctx.lineTo(g.position, view.y + view.h * 2);
    } else {
      ctx.moveTo(view.x - view.w, g.position);
      ctx.lineTo(view.x + view.w * 2, g.position);
    }
    ctx.stroke();
    calls++;
  }
  ctx.setLineDash([]);
  return calls;
}


function drawMinimap(ctx: CanvasRenderingContext2D, model: SceneModel, opts: DrawSceneOptions, P: Palette): number {
  const m = opts.minimap;
  if (!m) return 0;
  let calls = 0;
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = opts.theme === 'dark' ? 'rgba(26,26,26,0.92)' : 'rgba(255,255,255,0.92)';
  rr(ctx, m.x, m.y, m.w, m.h, 12);
  ctx.fill();
  ctx.strokeStyle = opts.theme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(15,23,42,0.16)';
  ctx.lineWidth = 1;
  rr(ctx, m.x, m.y, m.w, m.h, 12);
  ctx.stroke();
  calls += 2;
  ctx.save();
  rr(ctx, m.x, m.y, m.w, m.h, 8);
  ctx.clip();
  const mx = (wx: number) => m.x + 6 + (wx - m.worldX) * m.scale;
  const my = (wy: number) => m.y + 6 + (wy - m.worldY) * m.scale;
  for (const n of model.nodes) {
    const x = mx(n.x);
    const y = my(n.y);
    const w = Math.max(1, n.w * m.scale);
    const h = Math.max(1, n.h * m.scale);
    if (x + w < m.x || x > m.x + m.w || y + h < m.y || y > m.y + m.h) continue;
    ctx.fillStyle = opts.selectedIds.has(n.id)
      ? SELECT_COLOR
      : n.isGroup
        ? 'rgba(100,116,139,0.35)'
        : opts.theme === 'dark'
          ? 'rgba(148,163,184,0.55)'
          : 'rgba(71,85,105,0.5)';
    ctx.fillRect(x, y, w, h);
    calls++;
  }
  // 视口框
  const vx = mx(opts.cam.x);
  const vy = my(opts.cam.y);
  const vw2 = (opts.vw / opts.cam.zoom) * m.scale;
  const vh2 = (opts.vh / opts.cam.zoom) * m.scale;
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(vx, vy, vw2, vh2);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(vx, vy, vw2, vh2);
  calls += 2;
  ctx.restore();
  void P;
  return calls;
}

export function drawScene(opts: DrawSceneOptions): DrawStats {
  const { ctx, model, grid, cam, vw, vh, dpr } = opts;
  const P: Palette = opts.theme === 'light' ? LIGHT : DARK;
  const zoom = cam.zoom;
  const calls = { n: 0 };

  // 清屏
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, vw, vh);
  calls.n++;

  drawDotGrid(ctx, cam, vw, vh, dpr, P, calls);

  const view = { x: cam.x, y: cam.y, w: vw / zoom, h: vh / zoom };

  // 世界变换
  ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, -cam.x * zoom * dpr, -cam.y * zoom * dpr);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 边
  const edgesDrawn = drawEdges(ctx, opts, P, view);
  calls.n += edgesDrawn;

  // 节点视觉 100% 由 DOM 岛承担：画布仅统计可见数供 HUD/诊断
  const pad = 8 / zoom;
  const padded = { x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 };
  const candidates = grid.queryRect(padded);
  const seen = new Set<number>();
  let visible = 0;
  for (const idx of candidates) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    const n = model.nodes[idx];
    if (!n) continue;
    if (n.x + n.w < view.x || n.x > view.x + view.w || n.y + n.h < view.y || n.y > view.y + view.h) continue;
    visible++;
  }

  // 叠加层：连线预览 / 框选 / 磁吸参考线 / 选区包围盒
  calls.n += drawSelectionBounds(ctx, opts);
  calls.n += drawConnectPreview(ctx, opts);
  calls.n += drawMarquee(ctx, opts);
  calls.n += drawGuides(ctx, opts, view);

  // 小地图（直绘：O(N) 点阵 <1ms，无需缓存）
  calls.n += drawMinimap(ctx, model, opts, P);

  return { visible, edgesDrawn, calls: calls.n };
}

export const RENDER_CONSTANTS = {};
