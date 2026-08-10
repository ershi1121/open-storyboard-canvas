import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { ALT_DRAG_COPY_Z_INDEX } from '../constants';
import type { DuplicateOptions, DuplicateResult } from '../types';

interface AltDragCopyState {
  sourceNodeIds: string[];
  startPositions: Map<string, { x: number; y: number }>;
  copiedNodeIds: string[];
  sourceToCopyIdMap: Map<string, string>;
}

interface UseAltDragCopyOptions {
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  duplicateNodes: (sourceNodeIds: string[], options?: DuplicateOptions) => DuplicateResult | null;
  scheduleCanvasPersist: (delay?: number) => void;
}

export function useAltDragCopy({
  nodes,
  selectedNodeIds,
  duplicateNodes,
  scheduleCanvasPersist,
}: UseAltDragCopyOptions) {
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const altDragCopyRef = useRef<AltDragCopyState | null>(null);

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }
      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }
      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));
      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }
      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;
      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));
      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));
      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;
      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }
      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };
      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));
      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));
      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }

      // ============================================================
      // 修复：拖拽结束后清除复制节点上的临时高层级（zIndex 污染修复）
      // ============================================================
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!altCopyState.copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          // 移除临时注入的 zIndex
          const { zIndex: _removedZIndex, style, ...rest } = currentNode;
          const nextStyle = { ...(style ?? {}) };
          delete nextStyle.zIndex;
          return {
            ...rest,
            style: nextStyle,
          };
        }),
      }));
      // ============================================================

      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  return { handleNodeDragStart, handleNodeDrag, handleNodeDragStop };
}