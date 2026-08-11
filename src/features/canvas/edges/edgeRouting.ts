import { Position } from '@xyflow/react';
import { DEFAULT_NODE_WIDTH, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface Point { x: number; y: number; }
interface Rect { left: number; top: number; right: number; bottom: number; }
interface RouteResult { path: string; labelX: number; labelY: number; }
interface BuildOrthogonalRouteInput {
  sourceId?: string; targetId?: string;
  sourceX: number; sourceY: number; sourcePosition: Position;
  targetX: number; targetY: number; targetPosition: Position;
  nodes: CanvasNode[]; smartAvoidance: boolean;
}

const DEFAULT_NODE_HEIGHT = 200;
const EXPANDED_NODE_PADDING = 14;
const ENTRY_OFFSET = 24;
const LANE_GAP = 20;
const EPS = 0.0001;
const CORNER_RADIUS = 14; // 圆角半径

function getOutDirection(position: Position, fallbackSign: number): number {
  if (position === Position.Right) return 1;
  if (position === Position.Left) return -1;
  return fallbackSign >= 0 ? 1 : -1;
}

function getInDirection(position: Position, fallbackSign: number): number {
  if (position === Position.Left) return -1;
  if (position === Position.Right) return 1;
  return fallbackSign <= 0 ? -1 : 1;
}

function nodeToRect(node: CanvasNode): Rect {
  const width = node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : null) ?? DEFAULT_NODE_WIDTH;
  const height = node.measured?.height ?? (typeof node.style?.height === 'number' ? node.style.height : null) ?? DEFAULT_NODE_HEIGHT;
  return {
    left: node.position.x - EXPANDED_NODE_PADDING,
    top: node.position.y - EXPANDED_NODE_PADDING,
    right: node.position.x + width + EXPANDED_NODE_PADDING,
    bottom: node.position.y + height + EXPANDED_NODE_PADDING,
  };
}

function buildRectangles(nodes: CanvasNode[], sourceId?: string, targetId?: string): Rect[] {
  return nodes.filter((node) => node.id !== sourceId && node.id !== targetId).map(nodeToRect);
}

function verticalIntersectsRect(x: number, y1: number, y2: number, rect: Rect): boolean {
  if (x <= rect.left + EPS || x >= rect.right - EPS) return false;
  const top = Math.min(y1, y2); const bottom = Math.max(y1, y2);
  return bottom > rect.top + EPS && top < rect.bottom - EPS;
}

function horizontalIntersectsRect(y: number, x1: number, x2: number, rect: Rect): boolean {
  if (y <= rect.top + EPS || y >= rect.bottom - EPS) return false;
  const left = Math.min(x1, x2); const right = Math.max(x1, x2);
  return right > rect.left + EPS && left < rect.right - EPS;
}

function polylineIntersectsAnyRect(points: Point[], rects: Rect[]): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]; const to = points[index + 1];
    const isVertical = Math.abs(from.x - to.x) < EPS;
    for (const rect of rects) {
      if (isVertical) { if (verticalIntersectsRect(from.x, from.y, to.y, rect)) return true; } 
      else if (Math.abs(from.y - to.y) < EPS) { if (horizontalIntersectsRect(from.y, from.x, to.x, rect)) return true; }
    }
  }
  return false;
}

function getMidpoint(points: Point[]): Point {
  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i += 1) totalLength += Math.hypot(points[i+1].x - points[i].x, points[i+1].y - points[i].y);
  if (totalLength < EPS) return points[0] ?? { x: 0, y: 0 };
  let traversed = 0; const half = totalLength / 2;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]; const to = points[i + 1];
    const segLen = Math.hypot(to.x - from.x, to.y - from.y);
    if (traversed + segLen >= half) {
      const ratio = (half - traversed) / segLen;
      return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
    }
    traversed += segLen;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** 核心修改：折线转 SVG 路径，自动加圆角 */
function toSvgPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length < 3) {
    const [first, ...rest] = points;
    return `M ${first.x} ${first.y} ${rest.map((p) => ` L ${p.x} ${p.y}`).join('')}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]; const curr = points[i]; const next = points[i + 1];
    const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const d2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(CORNER_RADIUS, d1 / 2, d2 / 2);
    if (r < 1) { d += ` L ${curr.x} ${curr.y}`; continue; }
    const p1x = curr.x - ((curr.x - prev.x) / d1) * r;
    const p1y = curr.y - ((curr.y - prev.y) / d1) * r;
    const p2x = curr.x + ((next.x - curr.x) / d2) * r;
    const p2y = curr.y + ((next.y - curr.y) / d2) * r;
    d += ` L ${p1x} ${p1y} Q ${curr.x} ${curr.y} ${p2x} ${p2y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function buildPointsForLane(sx: number, sy: number, sox: number, tx: number, ty: number, tix: number, ly: number): Point[] {
  return [ {x:sx,y:sy}, {x:sox,y:sy}, {x:sox,y:ly}, {x:tix,y:ly}, {x:tix,y:ty}, {x:tx,y:ty} ];
}

function candidatePenalty(ly: number, sy: number, ty: number): number {
  const midY = (sy + ty) / 2;
  return Math.abs(ly - midY) * 0.45 + Math.abs(ly - sy) * 0.3 + Math.abs(ly - ty) * 0.25;
}

function pickLaneY(sx: number, sy: number, sox: number, tx: number, ty: number, tix: number, rects: Rect[]): number {
  const minX = Math.min(sox, tix, sx, tx); const maxX = Math.max(sox, tix, sx, tx);
  const candidates = new Set<number>([sy, ty, (sy + ty) / 2]);
  for (const rect of rects) {
    if (rect.right < minX || rect.left > maxX) continue;
    candidates.add(rect.top - LANE_GAP); candidates.add(rect.bottom + LANE_GAP);
  }
  const sorted = Array.from(candidates).sort((l, r) => candidatePenalty(l, sy, ty) - candidatePenalty(r, sy, ty));
  for (const ly of sorted) {
    const pts = buildPointsForLane(sx, sy, sox, tx, ty, tix, ly);
    if (!polylineIntersectsAnyRect(pts, rects)) return ly;
  }
  const ub = rects.length > 0 ? Math.min(...rects.map((r) => r.top)) - LANE_GAP : sy - 80;
  const lb = rects.length > 0 ? Math.max(...rects.map((r) => r.bottom)) + LANE_GAP : ty + 80;
  return candidatePenalty(ub, sy, ty) <= candidatePenalty(lb, sy, ty) ? ub : lb;
}

export function buildOrthogonalRoute(input: BuildOrthogonalRouteInput): RouteResult {
  const { sourceId, targetId, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, nodes, smartAvoidance } = input;
  const hSign = targetX - sourceX >= 0 ? 1 : -1;
  const sox = sourceX + getOutDirection(sourcePosition, hSign) * ENTRY_OFFSET;
  const tix = targetX + getInDirection(targetPosition, hSign) * ENTRY_OFFSET;
  let ly = (sourceY + targetY) / 2;
  if (smartAvoidance) ly = pickLaneY(sourceX, sourceY, sox, targetX, targetY, tix, buildRectangles(nodes, sourceId, targetId));
  const points = buildPointsForLane(sourceX, sourceY, sox, targetX, targetY, tix, ly);
  const mid = getMidpoint(points);
  return { path: toSvgPath(points), labelX: mid.x, labelY: mid.y };
}