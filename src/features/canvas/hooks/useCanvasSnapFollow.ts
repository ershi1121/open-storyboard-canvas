import { useCallback, useRef, useState } from 'react';
import { ViewportPortal, useReactFlow, type NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { DEFAULT_NODE_WIDTH, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

const SNAP_THRESHOLD_PX = 8; // 吸附判定阈值（屏幕像素）
const FOLLOW_GAP = 12;       // 节点间距(flow单位)小于该值视为"贴在一起"

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
  const dragRef = useRef<{ nodeId: string; cluster: Set<string>; autoSelected: string[] } | null>(null);
  
  const nodes = useCanvasStore((s) => s.nodes);
  const applyNodesChange = useCanvasStore((s) => s.onNodesChange);

  /* 拖动开始：编组跟随 (避开 Alt 拖动复制) */
  const onNodeDragStart = useCallback((event: React.MouseEvent, node: CanvasNode) => {
    if (event.altKey) {
      dragRef.current = null; // Alt 键由原有的 handleNodeDragStart 接管
      return;
    }
    const cluster = collectFollowCluster(node.id, nodes);
    const autoSelected: string[] = [];
    if (cluster.size > 1) {
      const changes: NodeChange[] = [];
      for (const id of cluster) {
        const n = nodes.find((nn) => nn.id === id);
        if (n && !n.selected) {
          autoSelected.push(id);
          changes.push({ type: 'select', id, selected: true });
        }
      }
      if (changes.length) applyNodesChange(changes);
    }
    dragRef.current = { nodeId: node.id, cluster, autoSelected };
  }, [nodes, applyNodesChange]);

  /* 拖动结束：清理状态 */
  const onNodeDragStop = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.autoSelected.length) {
      applyNodesChange(drag.autoSelected.map((id) => ({ type: 'select', id, selected: false } as NodeChange)));
    }
    dragRef.current = null;
    lastGuideKeyRef.current = '';
    setGuides([]);
  }, [applyNodesChange]);

  /* 核心：拦截 changes 并注入吸附偏移量 */
  const processNodeChanges = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const drag = dragRef.current;
    if (!drag) return changes;

    const posChanges = changes.filter((c) => c.type === 'position' && (c as any).dragging && (c as any).position);
    if (posChanges.length === 0) return changes;

    const dragged = nodes.find((n) => n.id === drag.nodeId);
    const draggedChange = posChanges.find((c) => c.id === drag.nodeId) ?? posChanges[0];
    if (!dragged || !(draggedChange as any).position) return changes;

    const dRect = getNodeRect({ ...dragged, position: (draggedChange as any).position } as CanvasNode);
    const targets = nodes.filter((n) => !drag.cluster.has(n.id)).map(getNodeRect);

    const threshold = SNAP_THRESHOLD_PX / getZoom();
    let bestX: { offset: number; line: number } | null = null;
    let bestY: { offset: number; line: number } | null = null;

    for (const t of targets) {
      const xCands: Array<[number, number]> = [
        [t.left - dRect.left, t.left], [t.right - dRect.right, t.right],
        [t.left - dRect.right, t.left], [t.right - dRect.left, t.right],
        [t.cx - dRect.cx, t.cx],
      ];
      for (const [off, line] of xCands) {
        if (Math.abs(off) <= threshold && (!bestX || Math.abs(off) < Math.abs(bestX.offset))) bestX = { offset: off, line };
      }
      const yCands: Array<[number, number]> = [
        [t.top - dRect.top, t.top], [t.bottom - dRect.bottom, t.bottom],
        [t.top - dRect.bottom, t.top], [t.bottom - dRect.top, t.bottom],
        [t.cy - dRect.cy, t.cy],
      ];
      for (const [off, line] of yCands) {
        if (Math.abs(off) <= threshold && (!bestY || Math.abs(off) < Math.abs(bestY.offset))) bestY = { offset: off, line };
      }
    }

    const dx = bestX?.offset ?? 0;
    const dy = bestY?.offset ?? 0;

    const nextGuides: SnapGuide[] = [];
    if (bestX) nextGuides.push({ id: 'gx', orientation: 'vertical', position: bestX.line });
    if (bestY) nextGuides.push({ id: 'gy', orientation: 'horizontal', position: bestY.line });

    const guideKey = nextGuides.map((g) => `${g.orientation}:${Math.round(g.position)}`).join('|');
    if (guideKey !== lastGuideKeyRef.current) {
      lastGuideKeyRef.current = guideKey;
      setGuides(nextGuides);
    }

    if (dx !== 0 || dy !== 0) {
      return changes.map((c) =>
        c.type === 'position' && (c as any).dragging && (c as any).position
          ? ({ ...c, position: { x: (c as any).position.x + dx, y: (c as any).position.y + dy } } as any)
          : c
      );
    }
    return changes;
  }, [nodes, getZoom]);

  return { guides, processNodeChanges, onNodeDragStart, onNodeDragStop };
}

export function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      {guides.map((g) =>
        g.orientation === 'vertical' ? (
          <div key={g.id} className="pointer-events-none absolute z-50 w-px bg-fuchsia-500" style={{ left: g.position, top: -100000, height: 200000 }} />
        ) : (
          <div key={g.id} className="pointer-events-none absolute z-50 h-px bg-fuchsia-500" style={{ top: g.position, left: -100000, width: 200000 }} />
        )
      )}
    </ViewportPortal>
  );
}