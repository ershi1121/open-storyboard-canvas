import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from './canvasNodes';
import { resolveBatchToolbarState, type BatchToolbarNodeLike } from './batchToolbar';

function node(id: string, type: string, parentId?: string): BatchToolbarNodeLike {
  return { id, type, parentId };
}

const NODES: BatchToolbarNodeLike[] = [
  node('img1', CANVAS_NODE_TYPES.imageEdit),
  node('img2', CANVAS_NODE_TYPES.imageEdit),
  node('up1', CANVAS_NODE_TYPES.upload),
  node('txt1', CANVAS_NODE_TYPES.textAnnotation),
  node('g1', CANVAS_NODE_TYPES.group),
  node('gc1', CANVAS_NODE_TYPES.aiVideo, 'g1'),
  node('gc2', CANVAS_NODE_TYPES.upload, 'g1'),
];

describe('resolveBatchToolbarState（多选批量工具条派生）', () => {
  it('无选中 / 单选普通节点：不显示', () => {
    expect(resolveBatchToolbarState(NODES, []).visible).toBe(false);
    const single = resolveBatchToolbarState(NODES, ['img1']);
    expect(single.visible).toBe(false);
    expect(single.count).toBe(1);
  });

  it('多选：显示，计数=选中数，canGroup', () => {
    const state = resolveBatchToolbarState(NODES, ['img1', 'up1']);
    expect(state.visible).toBe(true);
    expect(state.count).toBe(2);
    expect(state.canGroup).toBe(true);
    expect(state.canUngroup).toBe(false);
  });

  it('单选分组：显示，计数=组内子节点数（至少 1），可解组', () => {
    const state = resolveBatchToolbarState(NODES, ['g1']);
    expect(state.visible).toBe(true);
    expect(state.isSingleSelectedGroup).toBe(true);
    expect(state.count).toBe(2);
    expect(state.canGroup).toBe(false);
    expect(state.canUngroup).toBe(true);
  });

  it('批量触发目标 = 选中的可触发节点 + 选中分组的子节点中的可触发者', () => {
    const mixed = resolveBatchToolbarState(NODES, ['img1', 'up1', 'txt1']);
    expect(mixed.triggerIds).toEqual(['img1']);
    expect(mixed.canTrigger).toBe(true);

    const withGroup = resolveBatchToolbarState(NODES, ['img2', 'g1']);
    expect(withGroup.triggerIds.sort()).toEqual(['gc1', 'img2'].sort());
    expect(withGroup.canUngroup).toBe(true);
  });

  it('全部不可触发时 canTrigger=false', () => {
    const state = resolveBatchToolbarState(NODES, ['up1', 'txt1']);
    expect(state.canTrigger).toBe(false);
    expect(state.triggerIds).toEqual([]);
  });

  it('选中不存在的 id 安全忽略', () => {
    const state = resolveBatchToolbarState(NODES, ['ghost1', 'ghost2']);
    expect(state.visible).toBe(true);
    expect(state.count).toBe(2);
    expect(state.triggerIds).toEqual([]);
  });
});
