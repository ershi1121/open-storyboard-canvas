import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useReactFlow, type NodeChange } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { CANVAS_BATCH_TRIGGER_TYPES } from '../constants';
import type { CanvasMarqueeGesture } from '../types';
import { rectsOverlap } from '../utils/geometry';

interface UseCanvasSelectionOptions {
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

export function useCanvasSelection({ nodesRef }: UseCanvasSelectionOptions) {
  const { flowToScreenPosition } = useReactFlow();
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

      const allNodes = nodesRef.current;
      const nodeMap = new Map(allNodes.map((node) => [node.id, node] as const));

      const nextSelectedIds = allNodes
        .filter((node) => {
          // 节点"主体"真实尺寸：不含阴影、不含溢出的悬浮 Header
          const width =
            typeof node.measured?.width === 'number'
              ? node.measured.width
              : typeof node.style?.width === 'number'
                ? node.style.width
                : DEFAULT_NODE_WIDTH;
          const height =
            typeof node.measured?.height === 'number'
              ? node.measured.height
              : typeof node.style?.height === 'number'
                ? node.style.height
                : 200;

          // 绝对 flow 坐标（正确处理 Group 嵌套的子节点）
          let flowX = node.position.x;
          let flowY = node.position.y;
          let parentId = node.parentId;
          const visited = new Set<string>();
          while (parentId && !visited.has(parentId)) {
            visited.add(parentId);
            const parent = nodeMap.get(parentId);
            if (!parent) break;
            flowX += parent.position.x;
            flowY += parent.position.y;
            parentId = parent.parentId;
          }

          // flow 坐标 → 屏幕(client)坐标，与选区矩形同坐标系比较
          const topLeft = flowToScreenPosition({ x: flowX, y: flowY });
          const bottomRight = flowToScreenPosition({ x: flowX + width, y: flowY + height });

          const nodeRect = {
            left: Math.min(topLeft.x, bottomRight.x),
            top: Math.min(topLeft.y, bottomRight.y),
            right: Math.max(topLeft.x, bottomRight.x),
            bottom: Math.max(topLeft.y, bottomRight.y),
          };

          // 关键补丁：组节点必须被选区"完全包含"才选中，
          // 避免小选区擦到大组的半透明背景就吞掉整组
          if (node.type === CANVAS_NODE_TYPES.group) {
            return (
              selectionClientRect.left <= nodeRect.left &&
              selectionClientRect.top <= nodeRect.top &&
              selectionClientRect.right >= nodeRect.right &&
              selectionClientRect.bottom >= nodeRect.bottom
            );
          }

          return rectsOverlap(selectionClientRect, nodeRect);
        })
        .map((node) => node.id);

      const nextSelectedSet = new Set(nextSelectedIds);
      const selectionChanges: NodeChange<CanvasNode>[] = allNodes.map((node) => ({
        id: node.id,
        type: 'select',
        selected: nextSelectedSet.has(node.id),
      }));
      applyNodesChange(selectionChanges);
      setSelectedNode(nextSelectedIds.length === 1 ? nextSelectedIds[0] : null);
      return nextSelectedIds;
    },
    [applyNodesChange, flowToScreenPosition, nodesRef, setSelectedNode]
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