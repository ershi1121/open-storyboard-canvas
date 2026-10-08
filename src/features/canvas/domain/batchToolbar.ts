import { CANVAS_NODE_TYPES } from './canvasNodes';
import { CANVAS_BATCH_TRIGGER_TYPES } from './nodeRegistry';

/**
 * 多选批量工具条的派生状态（纯函数，可单测）。
 * 语义与旧版 useCanvasSelection 的批量派生一致：
 * - 显示条件：多选，或单选的是一个分组节点
 * - 计数：单选分组时显示组内子节点数
 * - 批量触发目标：选中节点 + 选中分组的直接子节点中属于可触发类型的
 */

export interface BatchToolbarNodeLike {
  id: string;
  type?: string;
  parentId?: string | null;
}

export interface BatchToolbarState {
  visible: boolean;
  count: number;
  canGroup: boolean;
  canUngroup: boolean;
  canTrigger: boolean;
  triggerIds: string[];
  groupIds: string[];
  isSingleSelectedGroup: boolean;
}

const EMPTY_STATE: BatchToolbarState = {
  visible: false,
  count: 0,
  canGroup: false,
  canUngroup: false,
  canTrigger: false,
  triggerIds: [],
  groupIds: [],
  isSingleSelectedGroup: false,
};

export function resolveBatchToolbarState(
  nodes: BatchToolbarNodeLike[],
  selectedIds: readonly string[],
): BatchToolbarState {
  if (selectedIds.length === 0) return EMPTY_STATE;

  const selectedSet = new Set(selectedIds);
  const selectedNodes = nodes.filter((node) => selectedSet.has(node.id));

  const groupIds = selectedNodes
    .filter((node) => node.type === CANVAS_NODE_TYPES.group)
    .map((node) => node.id);

  const isSingleSelectedGroup = selectedIds.length === 1 && groupIds.length === 1;

  const groupIdSet = new Set(groupIds);
  const selectedGroupChildNodes =
    groupIds.length > 0 ? nodes.filter((node) => node.parentId && groupIdSet.has(node.parentId)) : [];

  const triggerSet = new Set<string>();
  for (const node of [...selectedNodes, ...selectedGroupChildNodes]) {
    if (node.type && CANVAS_BATCH_TRIGGER_TYPES.has(node.type as never)) {
      triggerSet.add(node.id);
    }
  }
  const triggerIds = Array.from(triggerSet);

  return {
    visible: selectedIds.length > 1 || isSingleSelectedGroup,
    count: isSingleSelectedGroup
      ? Math.max(1, selectedGroupChildNodes.length)
      : selectedIds.length,
    canGroup: selectedIds.length >= 2,
    canUngroup: groupIds.length > 0,
    canTrigger: triggerIds.length > 0,
    triggerIds,
    groupIds,
    isSingleSelectedGroup,
  };
}
