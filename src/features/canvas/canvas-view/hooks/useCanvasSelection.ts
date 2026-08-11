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
import { escapeNodeDataId, rectsOverlap } from '../utils/geometry';

interface UseCanvasSelectionOptions {
  nodesRef: { current: CanvasNode[] };
}

type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** 标签胶囊类型集合：间接取值，避免字面量比较报错 */
const NODE_TYPE_RECORD = CANVAS_NODE_TYPES as unknown as Record<string, string>;
const TAG_CAPSULE_TYPES = new Set<string>(
  [NODE_TYPE_RECORD.tag, NODE_TYPE_RECORD.tagGroup].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  ),
);

function isFullyContainedBy(
  inner: ScreenRect,
  outer: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

/** 胶囊命中矩形：读 DOM 真实屏幕矩形，store 几何漂移也不受影响 */
function getTagCapsuleScreenRect(node: CanvasNode): ScreenRect | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(
    `.react-flow__node[data-id="${escapeNodeDataId(node.id)}"]`,
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** 普通节点命中矩形（store 几何，含父链累加） */
function getNodeScreenRect(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>,
  flowToScreenPosition: (point: { x: number; y: number }) => { x: number; y: number },
): ScreenRect {
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

  const topLeft = flowToScreenPosition({ x: flowX, y: flowY });
  const bottomRight = flowToScreenPosition({ x: flowX + width, y: flowY + height });
  return {
    left: Math.min(topLeft.x, bottomRight.x),
    top: Math.min(topLeft.y, bottomRight.y),
    right: Math.max(topLeft.x, bottomRight.x),
    bottom: Math.max(topLeft.y, bottomRight.y),
  };
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
    [nodes],
  );
  const selectedNodeIds = useStableStringArray(rawSelectedNodeIds);

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds],
  );

  const rawSelectedGroupNodeIds = useMemo(
    () =>
      selectedNodes
        .filter((node) => node.type === CANVAS_NODE_TYPES.group)
        .map((node) => node.id),
    [selectedNodes],
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
        })),
      );
      setSelectedNode(nodeId);
    },
    [applyNodesChange, nodesRef, setSelectedNode],
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
          // ===== 标签胶囊：DOM 真实矩形，碰到就选、碰不到不选 =====
          // 幽灵选中已由「DOM 矩形」+「selectable:false」双重堵死，无需额外豁免规则
          if (TAG_CAPSULE_TYPES.has(node.type)) {
            const capsuleRect = getTagCapsuleScreenRect(node);
            if (!capsuleRect) return false;
            return rectsOverlap(selectionClientRect, capsuleRect);
          }

          // ===== 普通节点 / 组节点：沿用 store 几何 =====
          const nodeRect = getNodeScreenRect(node, nodeMap, flowToScreenPosition);

          // 关键补丁：组节点必须被选区"完全包含"才选中，
          // 避免小选区擦到大组的半透明背景就吞掉整组
          if (node.type === CANVAS_NODE_TYPES.group) {
            return isFullyContainedBy(nodeRect, selectionClientRect);
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
    [applyNodesChange, flowToScreenPosition, nodesRef, setSelectedNode],
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