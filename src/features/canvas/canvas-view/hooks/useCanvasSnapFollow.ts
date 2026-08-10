import { useCallback, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useReactFlow, type NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { DEFAULT_NODE_WIDTH, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

const SNAP_ENTER_PX = 14;
const SNAP_RELEASE_PX = 40;
const CROSS_PROXIMITY_PX = 8;   // ← 从 60 改为 8：只有几乎贴着才触发，消除同水平线远距离拖拽感
const FOLLOW_GAP = 1;

export interface SnapGuide {
  id: string;
  orientation: 'vertical' | 'horizontal';
  position: number;
}

interface Rect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
}

type AxisName = 'x' | 'y';
type SnapEdge = 'left' | 'right' | 'top' | 'bottom';

interface AxisLock {
  edge: SnapEdge;
  line: number;
}

function getNodeRect(node: CanvasNode): Rect {
  const width =
    node.measured?.width ??
    (typeof node.style?.width === 'number' ? node.style.width : DEFAULT_NODE_WIDTH);
  const height =
    node.measured?.height ??
    (typeof node.style?.height === 'number' ? node.style.height : 200);
  const left = node.position.x;
  const top = node.position.y;
  return {
    id: node.id,
    left,
    top,
    right: left + width,
    bottom: top + height,
    cx: left + width / 2,
    cy: top + height / 2,
  };
}

function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return Math.max(dx, dy);
}

function rectsOverlapArea(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlapX > 0.5 && overlapY > 0.5;
}

function collectFollowCluster(startId: string, nodes: CanvasNode[]): Set<string> {
  const rects = nodes.map(getNodeRect);
  const byId = new Map(rects.map((r) => [r.id, r] as const));
  const cluster = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length) {
    const cur = byId.get(queue.pop()!);
    if (!cur) continue;
    for (const other of rects) {
      if (
        !cluster.has(other.id)
        && !rectsOverlapArea(cur, other)
        && rectGap(cur, other) <= FOLLOW_GAP
      ) {
        cluster.add(other.id);
        queue.push(other.id);
      }
    }
  }

  return cluster;
}

function resolveAxisSnap(
  axis: AxisName,
  draggedRect: Rect,
  targets: Rect[],
  currentLock: AxisLock | null,
  zoom: number
): { offset: number; lock: AxisLock | null } {
  const nearKey: 'left' | 'top' = axis === 'x' ? 'left' : 'top';
  const farKey: 'right' | 'bottom' = axis === 'x' ? 'right' : 'bottom';

  const enterTh = SNAP_ENTER_PX / zoom;
  const releaseTh = SNAP_RELEASE_PX / zoom;
  const crossTh = CROSS_PROXIMITY_PX / zoom;

  if (currentLock) {
    const draggedEdgeCoord =
      currentLock.edge === nearKey ? draggedRect[nearKey] : draggedRect[farKey];
    const dist = currentLock.line - draggedEdgeCoord;

    if (Math.abs(dist) <= releaseTh) {
      return { offset: dist, lock: currentLock };
    }
  }

  let best: { offset: number; line: number; edge: SnapEdge; abs: number } | null = null;
  const dNear = draggedRect[nearKey];
  const dFar = draggedRect[farKey];

  for (const t of targets) {
    const crossGap =
      axis === 'x'
        ? Math.max(draggedRect.top - t.bottom, t.top - draggedRect.bottom, 0)
        : Math.max(draggedRect.left - t.right, t.left - draggedRect.right, 0);

    if (crossGap > crossTh) continue;

    const tNear = t[nearKey];
    const tFar = t[farKey];

    const candidates: Array<{ offset: number; line: number; edge: SnapEdge }> = [
      { offset: tNear - dNear, line: tNear, edge: nearKey },
      { offset: tFar - dFar, line: tFar, edge: farKey },
      { offset: tNear - dFar, line: tNear, edge: farKey },
      { offset: tFar - dNear, line: tFar, edge: nearKey },
    ];

    for (const c of candidates) {
      const abs = Math.abs(c.offset);
      if (abs <= enterTh && (!best || abs < best.abs)) {
        best = { ...c, abs };
      }
    }
  }

  if (best) {
    return {
      offset: best.offset,
      lock: { edge: best.edge, line: best.line },
    };
  }

  return { offset: 0, lock: null };
}

export function useCanvasSnapFollow() {
  const { getZoom } = useReactFlow();
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const lastGuideKeyRef = useRef('');
  const lockRef = useRef<{ x: AxisLock | null; y: AxisLock | null }>({ x: null, y: null });

  const dragRef = useRef<{
    nodeId: string;
    cluster: Set<string>;
    snapEnabled: boolean;
  } | null>(null);

  const nodes = useCanvasStore((s) => s.nodes);

  const onNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (event.altKey) {
        dragRef.current = null;
        return;
      }

      lockRef.current = { x: null, y: null };

      const cluster = event.shiftKey
        ? new Set<string>([node.id])
        : collectFollowCluster(node.id, nodes);

      dragRef.current = {
        nodeId: node.id,
        cluster,
        snapEnabled: !event.shiftKey,
      };
    },
    [nodes]
  );

  const onNodeDragStop = useCallback(() => {
    dragRef.current = null;
    lockRef.current = { x: null, y: null };
    lastGuideKeyRef.current = '';
    setGuides([]);
  }, []);

  const processNodeChanges = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const drag = dragRef.current;
      if (!drag) return changes;

      const posChanges = changes.filter(
        (c): c is Extract<NodeChange<CanvasNode>, { type: 'position' }> =>
          c.type === 'position' && (c as any).position !== undefined
      );
      if (posChanges.length === 0) return changes;

      const dragged = nodes.find((n) => n.id === drag.nodeId);
      const draggedChange =
        posChanges.find((c) => c.id === drag.nodeId) ?? posChanges[0];

      if (!dragged || !draggedChange.position) return changes;

      const proposedPos = draggedChange.position;

      let dx = 0;
      let dy = 0;

      if (drag.snapEnabled) {
        const targets = nodes
          .filter((n) => !drag.cluster.has(n.id))
          .map(getNodeRect);

        const proposedRect = getNodeRect(
          { ...dragged, position: proposedPos } as CanvasNode
        );

        const zoom = getZoom();

        const resultX = resolveAxisSnap('x', proposedRect, targets, lockRef.current.x, zoom);
        const resultY = resolveAxisSnap('y', proposedRect, targets, lockRef.current.y, zoom);

        lockRef.current.x = resultX.lock;
        lockRef.current.y = resultY.lock;

        dx = resultX.offset;
        dy = resultY.offset;

        const nextGuides: SnapGuide[] = [];

        if (resultX.lock) {
          nextGuides.push({
            id: 'gx',
            orientation: 'vertical',
            position: resultX.lock.line,
          });
        }

        if (resultY.lock) {
          nextGuides.push({
            id: 'gy',
            orientation: 'horizontal',
            position: resultY.lock.line,
          });
        }

        const guideKey = nextGuides
          .map((g) => `${g.orientation}:${Math.round(g.position)}`)
          .join('|');

        if (guideKey !== lastGuideKeyRef.current) {
          lastGuideKeyRef.current = guideKey;
          setGuides(nextGuides);
        }
      }

      const modified = changes.map((c) =>
        c.type === 'position' && (c as any).position !== undefined
          ? ({
              ...c,
              position: {
                x: (c as any).position.x + dx,
                y: (c as any).position.y + dy,
              },
            } as any)
          : c
      );

      const deltaX = proposedPos.x + dx - dragged.position.x;
      const deltaY = proposedPos.y + dy - dragged.position.y;

      if (deltaX === 0 && deltaY === 0) return modified;

      const existingPosIds = new Set(posChanges.map((c) => c.id));

      const followChanges: any[] = [];

      for (const id of drag.cluster) {
        if (id === drag.nodeId || existingPosIds.has(id)) continue;

        const n = nodes.find((nn) => nn.id === id);
        if (!n) continue;

        followChanges.push({
          id,
          type: 'position',
          position: {
            x: n.position.x + deltaX,
            y: n.position.y + deltaY,
          },
          dragging: (draggedChange as any).dragging ?? false,
        });
      }

      return followChanges.length ? [...modified, ...followChanges] : modified;
    },
    [nodes, getZoom]
  );

  return {
    guides,
    processNodeChanges,
    onNodeDragStart,
    onNodeDragStop,
  };
}