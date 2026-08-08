import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_BATCH_TRIGGER_TYPES } from '../constants';
import type { CanvasMarqueeGesture } from '../types';
import { escapeNodeDataId, rectsOverlap } from '../utils/geometry';

interface UseCanvasSelectionOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodesRef: { current: CanvasNode[] };
}

/**
 * 字符串数组引用稳定化工具。
 * nodes 在拖拽节点时每帧变化，由此派生的数组（如 selectedNodeIds）
 * 原本每帧都会得到新引用，导致下游 useMemo / useCallback / useEffect 连锁失效。
 * 这里只在数组内容真正变化时才返回新引用，否则复用上一次的数组。
 */
function useStableStringArray(input: string[]): string[] {
  const ref = useRef<string[]>([]);
  return useMemo(() => {
    const prev = ref.current;
    if (prev.length === input.length && prev.every((id, index) => id === input[index])) {
      return prev;
    }
    ref.current = input;
    return input;
  }, [input]);
}

export function useCanvasSelection({ wrapperRef, nodesRef }: UseCanvasSelectionOptions) {
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);

  // 仅用于 useMemo 计算派生状态
  const nodes = useCanvasStore((state) => state.nodes);

  const rawSelectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedNodeIds = useStableStringArray(rawSelectedNodeIds);

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds]
  );

  const rawSelectedGroupNodeIds = useMemo(
    () =>
      selectedNodes
        .filter((node) => node.type === CANVAS_NODE_TYPES.group)
        .map((node) => node.id),
    [selectedNodes]
  );
  const selectedGroupNodeIds = useStableStringArray(rawSelectedGroupNodeIds);

  const isSingleSelectedGroup =
    selectedNodeIds.length === 1 && selectedGroupNodeIds.length === 1;

  const selectedGroupChildNodes = useMemo(() => {
    if (selectedGroupNodeIds.length === 0) {
      return [];
    }
    const groupIds = new Set(selectedGroupNodeIds);
    return nodes.filter((node) => node.parentId && groupIds.has(node.parentId));
  }, [nodes, selectedGroupNodeIds]);

  const rawSelectedBatchTriggerNodeIds = useMemo(() => {
    const ids = new Set<string>();
    [...selectedNodes, ...selectedGroupChildNodes].forEach((node) => {
      if (CANVAS_BATCH_TRIGGER_TYPES.has(node.type)) {
        ids.add(node.id);
      }
    });
    return Array.from(ids);
  }, [selectedGroupChildNodes, selectedNodes]);
  const selectedBatchTriggerNodeIds = useStableStringArray(rawSelectedBatchTriggerNodeIds);

  const batchToolbarSelectedCount = isSingleSelectedGroup
    ? Math.max(1, selectedGroupChildNodes.length)
    : selectedNodeIds.length;

  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  // 使用 nodesRef.current，避免函数引用频繁变化
  const selectSingleNode = useCallback(
    (nodeId: string | null) => {
      applyNodesChange(
        nodesRef.current.map((node) => ({
          id: node.id,
          type: 'select',
          selected: node.id === nodeId,
        }))
      );
      setSelectedNode(nodeId);
    },
    [applyNodesChange, nodesRef, setSelectedNode]
  );

  const selectNodesInMarquee = useCallback(
    (gesture: CanvasMarqueeGesture): string[] => {
      const selectionClientRect = {
        left: Math.min(gesture.startClientX, gesture.currentClientX),
        top: Math.min(gesture.startClientY, gesture.currentClientY),
        right: Math.max(gesture.startClientX, gesture.currentClientX),
        bottom: Math.max(gesture.startClientY, gesture.currentClientY),
      };

      const nextSelectedIds = nodesRef.current
        .filter((node) => {
          const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
            `.react-flow__node[data-id="${escapeNodeDataId(node.id)}"]`
          );
          if (!nodeElement) {
            return false;
          }
          const nodeRect = nodeElement.getBoundingClientRect();
          return rectsOverlap(selectionClientRect, {
            left: nodeRect.left,
            top: nodeRect.top,
            right: nodeRect.right,
            bottom: nodeRect.bottom,
          });
        })
        .map((node) => node.id);

      const nextSelectedSet = new Set(nextSelectedIds);
      const selectionChanges: NodeChange<CanvasNode>[] = nodesRef.current.map((node) => ({
        id: node.id,
        type: 'select',
        selected: nextSelectedSet.has(node.id),
      }));

      applyNodesChange(selectionChanges);
      setSelectedNode(nextSelectedIds.length === 1 ? nextSelectedIds[0] : null);
      return nextSelectedIds;
    },
    [applyNodesChange, nodesRef, setSelectedNode, wrapperRef]
  );

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }
    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  return {
    selectedNodeIds,
    selectedNodes,
    selectedGroupNodeIds,
    isSingleSelectedGroup,
    selectedGroupChildNodes,
    selectedBatchTriggerNodeIds,
    batchToolbarSelectedCount,
    selectedUploadNodeId,
    selectSingleNode,
    selectNodesInMarquee,
  };
}