import { useEffect, useState } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { CanvasMarqueeRect } from '../types';
import { escapeNodeDataId } from '../utils/geometry';
import { collectNodeIdsWithDescendants } from '../utils/node-helpers';

interface UseBatchToolbarPositionOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  isSingleSelectedGroup: boolean;
}

export function useBatchToolbarPosition({
  wrapperRef,
  nodes,
  selectedNodeIds,
  isSingleSelectedGroup,
}: UseBatchToolbarPositionOptions): {
  batchToolbarPosition: { left: number; top: number } | null;
  selectionBoundsRect: CanvasMarqueeRect | null;
} {
  const currentViewport = useCanvasStore((state) => state.currentViewport);
  const [batchToolbarPosition, setBatchToolbarPosition] = useState<{ left: number; top: number } | null>(null);
  const [selectionBoundsRect, setSelectionBoundsRect] = useState<CanvasMarqueeRect | null>(null);

  useEffect(() => {
    if (selectedNodeIds.length <= 1 && !isSingleSelectedGroup) {
      setBatchToolbarPosition(null);
      setSelectionBoundsRect(null);
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        setBatchToolbarPosition(null);
        setSelectionBoundsRect(null);
        return;
      }
      let minLeft = Number.POSITIVE_INFINITY;
      let minTop = Number.POSITIVE_INFINITY;
      let maxRight = Number.NEGATIVE_INFINITY;
      let maxBottom = Number.NEGATIVE_INFINITY;
      let hasRect = false;
      const boundsNodeIds = collectNodeIdsWithDescendants(nodes, selectedNodeIds);
      for (const nodeId of boundsNodeIds) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${escapeNodeDataId(nodeId)}"]`
        );
        if (!nodeElement) {
          continue;
        }
        const rect = nodeElement.getBoundingClientRect();
        minLeft = Math.min(minLeft, rect.left);
        minTop = Math.min(minTop, rect.top);
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
        hasRect = true;
      }
      if (!hasRect) {
        setBatchToolbarPosition(null);
        setSelectionBoundsRect(null);
        return;
      }
      setSelectionBoundsRect({
        left: Math.max(0, minLeft - containerRect.left),
        top: Math.max(0, minTop - containerRect.top),
        width: Math.max(0, maxRight - minLeft),
        height: Math.max(0, maxBottom - minTop),
      });
      setBatchToolbarPosition({
        left: Math.max(12, Math.min(containerRect.width - 12, (minLeft + maxRight) / 2 - containerRect.left)),
        top: Math.max(12, minTop - containerRect.top - 42),
      });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [currentViewport, isSingleSelectedGroup, nodes, selectedNodeIds, wrapperRef]);

  return { batchToolbarPosition, selectionBoundsRect };
}