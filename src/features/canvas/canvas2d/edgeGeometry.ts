/**
 * 边几何统一表示：所有边化为稠密采样点列。
 * 绘制（polyline/流光）、命中测试（点-段距离）、中点（断开按钮）、
 * 悬停高亮全部复用同一份点列，保证"看到的=点得到的"。
 *
 * 路由模式（与设置页 canvasEdgeRoutingMode 对齐）：
 * - spline：水平三次贝塞尔（与旧版 getBezierPath 控制点一致）
 * - smartOrthogonal：旧版 edgeRouting.ts 的正交圆角路由（含智能避让 lane 选择）
 */

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type EdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';

const ENTRY_OFFSET = 24;
const LANE_GAP = 20;
const CORNER_RADIUS = 14;
const EXPANDED_NODE_PADDING = 14;
const SPLINE_SAMPLES = 24;

/* ---------------- spline ---------------- */

export function sampleSpline(ax: number, ay: number, bx: number, by: number): Pt[] {
  const gap = Math.max(48, Math.abs(bx - ax) * 0.4);
  const c1x = ax + gap;
  const c2x = bx - gap;
  const pts: Pt[] = [];
  for (let i = 0; i <= SPLINE_SAMPLES; i++) {
    const t = i / SPLINE_SAMPLES;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * ax + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * bx,
      y: mt * mt * mt * ay + 3 * mt * mt * t * ay + 3 * mt * t * t * by + t * t * t * by,
    });
  }
  return pts;
}

/* ---------------- smartOrthogonal（移植自旧版 edgeRouting.ts） ---------------- */

interface RouteRect extends EdgeRect {}

function getOutDirection(position: 'left' | 'right', fallbackSign: number): number {
  if (position === 'right') return 1;
  if (position === 'left') return -1;
  return fallbackSign >= 0 ? 1 : -1;
}

function getInDirection(position: 'left' | 'right', fallbackSign: number): number {
  if (position === 'left') return -1;
  if (position === 'right') return 1;
  return fallbackSign <= 0 ? -1 : 1;
}

function segmentIntersectsRect(a: Pt, b: Pt, r: RouteRect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (maxX < r.left || minX > r.right || maxY < r.top || minY > r.bottom) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return a.x >= r.left && a.x <= r.right && a.y >= r.top && a.y <= r.bottom;
  }
  // 参数化裁剪（Liang-Barsky）
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.left, r.right - a.x, a.y - r.top, r.bottom - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

function polylineIntersectsAnyRect(pts: Pt[], rects: RouteRect[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    for (const r of rects) {
      if (segmentIntersectsRect(pts[i], pts[i + 1], r)) return true;
    }
  }
  return false;
}

function buildPointsForLane(
  sx: number, sy: number, sox: number, tx: number, ty: number, tix: number, ly: number,
): Pt[] {
  return [
    { x: sx, y: sy },
    { x: sox, y: sy },
    { x: sox, y: ly },
    { x: tix, y: ly },
    { x: tix, y: ty },
    { x: tx, y: ty },
  ];
}

function candidatePenalty(ly: number, sy: number, ty: number): number {
  const midY = (sy + ty) / 2;
  return Math.abs(ly - midY) * 0.45 + Math.abs(ly - sy) * 0.3 + Math.abs(ly - ty) * 0.25;
}

function pickLaneY(
  sx: number, sy: number, sox: number, tx: number, ty: number, tix: number, rects: RouteRect[],
): number {
  const minX = Math.min(sox, tix, sx, tx);
  const maxX = Math.max(sox, tix, sx, tx);
  const candidates = new Set<number>([sy, ty, (sy + ty) / 2]);
  for (const rect of rects) {
    if (rect.right < minX || rect.left > maxX) continue;
    candidates.add(rect.top - LANE_GAP);
    candidates.add(rect.bottom + LANE_GAP);
  }
  const sorted = Array.from(candidates).sort(
    (l, r) => candidatePenalty(l, sy, ty) - candidatePenalty(r, sy, ty),
  );
  for (const ly of sorted) {
    const pts = buildPointsForLane(sx, sy, sox, tx, ty, tix, ly);
    if (!polylineIntersectsAnyRect(pts, rects)) return ly;
  }
  const ub = rects.length > 0 ? Math.min(...rects.map((r) => r.top)) - LANE_GAP : sy - 80;
  const lb = rects.length > 0 ? Math.max(...rects.map((r) => r.bottom)) + LANE_GAP : ty + 80;
  return candidatePenalty(ub, sy, ty) <= candidatePenalty(lb, sy, ty) ? ub : lb;
}

/** 圆角折线采样：拐角处二次贝塞尔圆角，输出稠密点列 */
function roundedPolylinePoints(points: Pt[], radius: number): Pt[] {
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const d2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (d1 < 1e-6 || d2 < 1e-6) continue;
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 1) {
      out.push(curr);
      continue;
    }
    const p1 = { x: curr.x - ((curr.x - prev.x) / d1) * r, y: curr.y - ((curr.y - prev.y) / d1) * r };
    const p2 = { x: curr.x + ((next.x - curr.x) / d2) * r, y: curr.y + ((next.y - curr.y) / d2) * r };
    out.push(p1);
    for (let s = 1; s < 6; s++) {
      const t = s / 6;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * curr.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * curr.y + t * t * p2.y,
      });
    }
    out.push(p2);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function sampleOrthogonal(
  sx: number, sy: number, sPos: 'left' | 'right',
  tx: number, ty: number, tPos: 'left' | 'right',
  avoidRects: RouteRect[],
): Pt[] {
  const hSign = tx - sx >= 0 ? 1 : -1;
  const sox = sx + getOutDirection(sPos, hSign) * ENTRY_OFFSET;
  const tix = tx + getInDirection(tPos, hSign) * ENTRY_OFFSET;
  const ly = avoidRects.length > 0
    ? pickLaneY(sx, sy, sox, tx, ty, tix, avoidRects)
    : (sy + ty) / 2;
  const points = buildPointsForLane(sx, sy, sox, tx, ty, tix, ly);
  return roundedPolylinePoints(points, CORNER_RADIUS);
}

export function buildAvoidRects(
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  skipA: string,
  skipB: string,
): RouteRect[] {
  const rects: RouteRect[] = [];
  for (const n of nodes) {
    if (n.id === skipA || n.id === skipB) continue;
    rects.push({
      id: n.id,
      left: n.x - EXPANDED_NODE_PADDING,
      top: n.y - EXPANDED_NODE_PADDING,
      right: n.x + n.w + EXPANDED_NODE_PADDING,
      bottom: n.y + n.h + EXPANDED_NODE_PADDING,
    });
  }
  return rects;
}

/* ---------------- 通用查询 ---------------- */

export function distToPolyline(px: number, py: number, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

export function polylineMidpoint(pts: Pt[]): Pt {
  if (pts.length === 0) return { x: 0, y: 0 };
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push(d);
    total += d;
  }
  let half = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (half <= segs[i]) {
      const t = segs[i] > 0 ? half / segs[i] : 0;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    half -= segs[i];
  }
  return pts[pts.length - 1];
}
