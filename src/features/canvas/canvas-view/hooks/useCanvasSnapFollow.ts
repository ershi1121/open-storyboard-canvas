import { useCallback, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useReactFlow, type NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { DEFAULT_NODE_WIDTH, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

const SNAP_THRESHOLD_PX = 14; // 进入吸附的阈值（屏幕像素）
const SNAP_RELEASE_PX = 30;   // 脱离吸附的阈值（滞回 → "吸住"手感）
const FOLLOW_GAP = 12;        // 间距小于该值视为"贴在一起"，拖动时跟随

export interface SnapGuide {
  id: string;
  orientation: 'vertical' | 'horizontal';
  position: number;
}

interface Rect { id: string; left: number; top: number; right: number; bottom: number; cx: number; cy: number; }

function getNodeRect(node: CanvasNode): Rect {
  const width = node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : DEFAULT_NODE_WIDTH);
  const height = node.measured?.height ?? (typeof node.style?.height === 'number' ? node.style.height : 200);
  const left = node.position.x;
  const top = node.position.y;
  return { id: node.id, left, top, right: left + width, bottom: top + height, cx: left + width / 2, cy: top + height / 2 };
}

function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return Math.max(dx, dy);
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
      if (!cluster.has(other.id) && rectGap(cur, other) <= FOLLOW_GAP) {
        cluster.add(other.id);
        queue.push(other.id);
      }
    }
  }
  return cluster;
}

export function useCanvasSnapFollow() {
  const { getZoom } = useReactFlow();
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const lastGuideKeyRef = useRef('');
  const snappedRef = useRef({ x: false, y: false });
  const dragRef = useRef<{ nodeId: string; cluster: Set<string>; snapEnabled: boolean } | null>(null);

  const nodes = useCanvasStore((s) => s.nodes);

  /* 拖动开始：
     - Alt + 拖动 → 让位给原有复制逻辑
     - Shift + 拖动 → 完全自由移动（无吸附、无跟随）
     - 普通拖动 → 边缘吸附 + 跟随 */
  const onNodeDragStart = useCallback((event: ReactMouseEvent, node: CanvasNode) => {
    if (event.altKey) {
      dragRef.current = null;
      return;
    }
    snappedRef.current = { x: false, y: false };
    const cluster = event.shiftKey
      ? new Set<string>([node.id])
      : collectFollowCluster(node.id, nodes);
    dragRef.current = { nodeId: node.id, cluster, snapEnabled: !event.shiftKey };
  }, [nodes]);

  const onNodeDragStop = useCallback(() => {
    dragRef.current = null;
    snappedRef.current = { x: false, y: false };
    lastGuideKeyRef.current = '';
    setGuides([]);
  }, []);

  /* 核心：仅边缘吸附 + 跟随注入（不改动选中态） */
  const processNodeChanges = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const drag = dragRef.current;
    if (!drag) return changes;

    const posChanges = changes.filter((c) => c.type === 'position' && (c as any).dragging && (c as any).position);
    if (posChanges.length === 0) return changes;

    const dragged = nodes.find((n) => n.id === drag.nodeId);
    const draggedChange = posChanges.find((c) => c.id === drag.nodeId) ?? posChanges[0];
    if (!dragged || !(draggedChange as any).position) return changes;

    const dRect = getNodeRect({ ...dragged, position: (draggedChange as any).position } as CanvasNode);

    // ===== 边缘吸附（不含中心吸附） =====
    let dx = 0;
    let dy = 0;
    if (drag.snapEnabled) {
      const targets = nodes.filter((n) => !drag.cluster.has(n.id)).map(getNodeRect);
      const zoom = getZoom();
      const thX = (snappedRef.current.x ? SNAP_RELEASE_PX : SNAP_THRESHOLD_PX) / zoom;
      const thY = (snappedRef.current.y ? SNAP_RELEASE_PX : SNAP_THRESHOLD_PX) / zoom;

      let bestX: { offset: number; line: number } | null = null;
      let bestY: { offset: number; line: number } | null = null;

      for (const t of targets) {
        // 只比对边缘：左/右对齐、左右互相贴合
        const xCands: Array<[number, number]> = [
          [t.left - dRect.left, t.left],
          [t.right - dRect.right, t.right],
          [t.left - dRect.right, t.left],
          [t.right - dRect.left, t.right],
        ];
        for (const [off, line] of xCands) {
          if (Math.abs(off) <= thX && (!bestX || Math.abs(off) < Math.abs(bestX.offset))) bestX = { offset: off, line };
        }
        // 只比对边缘：上/下对齐、上下互相贴合
        const yCands: Array<[number, number]> = [
          [t.top - dRect.top, t.top],
          [t.bottom - dRect.bottom, t.bottom],
          [t.top - dRect.bottom, t.top],
          [t.bottom - dRect.top, t.bottom],
        ];
        for (const [off, line] of yCands) {
          if (Math.abs(off) <= thY && (!bestY || Math.abs(off) < Math.abs(bestY.offset))) bestY = { offset: off, line };
        }
      }

      snappedRef.current.x = !!bestX;
      snappedRef.current.y = !!bestY;
      dx = bestX?.offset ?? 0;
      dy = bestY?.offset ?? 0;

      const nextGuides: SnapGuide[] = [];
      if (bestX) nextGuides.push({ id: 'gx', orientation: 'vertical', position: bestX.line });
      if (bestY) nextGuides.push({ id: 'gy', orientation: 'horizontal', position: bestY.line });

      const guideKey = nextGuides.map((g) => `${g.orientation}:${Math.round(g.position)}`).join('|');
      if (guideKey !== lastGuideKeyRef.current) {
        lastGuideKeyRef.current = guideKey;
        setGuides(nextGuides);
      }
    }

    // ===== 跟随移动 =====
    const basePos = (draggedChange as any).position;
    const deltaX = basePos.x + dx - dragged.position.x;
    const deltaY = basePos.y + dy - dragged.position.y;
    if (deltaX === 0 && deltaY === 0) return changes;

    const modified = changes.map((c) =>
      c.type === 'position' && (c as any).dragging && (c as any).position
        ? ({ ...c, position: { x: (c as any).position.x + dx, y: (c as any).position.y + dy } } as any)
        : c
    );

    const existingPosIds = new Set(changes.filter((c) => c.type === 'position').map((c) => c.id));
    const followChanges: any[] = [];
    for (const id of drag.cluster) {
      if (id === drag.nodeId || existingPosIds.has(id)) continue;
      const n = nodes.find((nn) => nn.id === id);
      if (!n) continue;
      followChanges.push({
        id,
        type: 'position',
        position: { x: n.position.x + deltaX, y: n.position.y + deltaY },
        dragging: true,
      });
    }

    return followChanges.length ? [...modified, ...followChanges] : modified;
  }, [nodes, getZoom]);

  return { guides, processNodeChanges, onNodeDragStart, onNodeDragStop };
}