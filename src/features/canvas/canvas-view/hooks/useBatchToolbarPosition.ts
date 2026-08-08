import { useEffect, useMemo, useState } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { CanvasMarqueeRect } from '../types';
// 修复：导入 node-helpers 中带 DEFAULT_NODE_WIDTH 兜底的 getNodeSize，
// 替换原本地定义的兜底为 0 的版本，避免离屏未渲染节点尺寸计算为 0
import { collectNodeIdsWithDescendants, getNodeSize } from '../utils/node-helpers';

interface UseBatchToolbarPositionOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  isSingleSelectedGroup: boolean;
}

type NodeWithParent = CanvasNode & { parentId?: string | null };

/**
 * 解析节点的画布绝对坐标。
 * 分组(Group)内的子节点 position 是相对父节点的，
 * 需要沿 parentId 链逐级累加，才能换算成绝对坐标。
 */
function resolveAbsolutePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;

  const visited = new Set<string>([node.id]);
  let current: CanvasNode = node;
  let parentId = (current as NodeWithParent).parentId ?? null;

  while (parentId && nodeMap.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodeMap.get(parentId)!;
    x += parent.position.x;
    y += parent.position.y;
    current = parent;
    parentId = (current as NodeWithParent).parentId ?? null;
  }

  return { x, y };
}

/**
 * 批量工具栏定位 Hook（性能优化版）。
 *
 * 旧版实现：useEffect + requestAnimationFrame + DOM querySelector + getBoundingClientRect。
 * 拖拽节点时 nodes 每帧变化，导致该 effect 每帧被销毁重建、DOM 测量被反复调度又取消，
 * 表现为：拖拽过程中工具栏不跟随、松手后才跳过去，同时产生无谓的 CPU 开销。
 *
 * 新版实现：直接用 nodes 数据（position + measured 尺寸）与当前视口做纯数学计算（useMemo），
 * 无 DOM 查询、无 rAF。拖拽过程中工具栏与选区高亮框平滑跟随，画布平移/缩放时也正确跟随。
 *
 * 入参与返回值结构与旧版完全一致，上游调用无需任何改动。
 */
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

  // wrapperRef.current 要在组件挂载后才可用，
  // 这里对齐旧版 useEffect「挂载后执行一次」的时机。
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  return useMemo(() => {
    // 显示条件与旧版一致：多选，或单选的是一个分组节点
    if (selectedNodeIds.length <= 1 && !isSingleSelectedGroup) {
      return { batchToolbarPosition: null, selectionBoundsRect: null };
    }

    if (!isMounted) {
      return { batchToolbarPosition: null, selectionBoundsRect: null };
    }

    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return { batchToolbarPosition: null, selectionBoundsRect: null };
    }

    const nodeMap = new Map<string, CanvasNode>(
      nodes.map((node) => [node.id, node] as [string, CanvasNode])
    );

    // 与旧版一致：选中分组时，包围盒要包含组内所有子孙节点
    const boundsNodeIds = collectNodeIdsWithDescendants(nodes, selectedNodeIds);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let hasBounds = false;

    for (const nodeId of boundsNodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        continue;
      }
      const { x, y } = resolveAbsolutePosition(node, nodeMap);
      const { width, height } = getNodeSize(node);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
      hasBounds = true;
    }

    if (!hasBounds) {
      return { batchToolbarPosition: null, selectionBoundsRect: null };
    }

    const zoom = currentViewport?.zoom || 1;
    const viewportX = currentViewport?.x ?? 0;
    const viewportY = currentViewport?.y ?? 0;

    // 流坐标 -> 容器坐标：screen = flow * zoom + viewport
    const left = minX * zoom + viewportX;
    const top = minY * zoom + viewportY;
    const width = (maxX - minX) * zoom;
    const height = (maxY - minY) * zoom;

    return {
      selectionBoundsRect: {
        left: Math.max(0, left),
        top: Math.max(0, top),
        width: Math.max(0, width),
        height: Math.max(0, height),
      },
      batchToolbarPosition: {
        left: Math.max(12, Math.min(containerRect.width - 12, left + width / 2)),
        top: Math.max(12, top - 42),
      },
    };
  }, [currentViewport, isMounted, isSingleSelectedGroup, nodes, selectedNodeIds, wrapperRef]);
}