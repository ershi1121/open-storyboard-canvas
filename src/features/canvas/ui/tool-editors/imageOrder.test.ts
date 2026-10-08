import { describe, expect, it } from 'vitest';

import { applyStripReorder, buildStripIndexById, orderStripItems, resolveStripTextIndex } from './imageOrder';

const item = (id: string, orderIndex?: number) => ({ id, orderIndex });

describe('applyStripReorder', () => {
  it('条里是全局的子集时，只在这些图占的位置槽里重排，其余原地不动', () => {
    // 全局 A B C D E；条里显示 A / C / E；用户拖成 E A C
    expect(applyStripReorder(['A', 'B', 'C', 'D', 'E'], ['E', 'A', 'C'])).toEqual([
      'E',
      'B',
      'A',
      'D',
      'C',
    ]);
  });

  it('条里就是全局全部时，结果等于条里的顺序', () => {
    expect(applyStripReorder(['A', 'B', 'C'], ['C', 'A', 'B'])).toEqual(['C', 'A', 'B']);
  });

  it('只拖动相邻两格 —— 槽位相邻，交换后不影响别人', () => {
    expect(applyStripReorder(['A', 'B', 'C', 'D'], ['A', 'C', 'B', 'D'])).toEqual([
      'A',
      'C',
      'B',
      'D',
    ]);
  });

  it('条里只有一张图时不产生任何变化', () => {
    expect(applyStripReorder(['A', 'B', 'C'], ['B'])).toEqual(['A', 'B', 'C']);
  });

  it('空顺序原样返回', () => {
    const global = ['A', 'B', 'C'];
    expect(applyStripReorder(global, [])).toBe(global);
  });

  it('有重复 id 时拒绝应用（原样返回）', () => {
    const global = ['A', 'B', 'C'];
    expect(applyStripReorder(global, ['B', 'B'])).toBe(global);
  });

  it('有条里出现全局没有的 id 时拒绝应用（数量对不上）', () => {
    const global = ['A', 'B', 'C'];
    expect(applyStripReorder(global, ['C', 'X'])).toBe(global);
  });

  it('不修改传入的数组', () => {
    const global = ['A', 'B', 'C'];
    const strip = ['C', 'A'];
    applyStripReorder(global, strip);
    expect(global).toEqual(['A', 'B', 'C']);
    expect(strip).toEqual(['C', 'A']);
  });
});

describe('orderStripItems', () => {
  it('当前图和队列混在一起按 orderIndex 排，当前图不占第一格', () => {
    const current = item('cur', 7);
    const queued = [item('b', 3), item('a', 5)];
    expect(orderStripItems(current, queued).map((entry) => entry.id)).toEqual(['b', 'a', 'cur']);
  });

  it('队列为空时只剩当前图', () => {
    expect(orderStripItems(item('cur', 9), []).map((entry) => entry.id)).toEqual(['cur']);
  });

  it('orderIndex 缺失的项兜到最后，保证排序稳定', () => {
    const current = item('cur');
    const queued = [item('b', 1), item('a', 2)];
    expect(orderStripItems(current, queued).map((entry) => entry.id)).toEqual(['b', 'a', 'cur']);
  });

  it('不修改传入的数组', () => {
    const queued = [item('b', 2), item('a', 1)];
    orderStripItems(item('cur', 3), queued);
    expect(queued.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('buildStripIndexById', () => {
  it('位置就是它在条里排第几（0-based）', () => {
    const map = buildStripIndexById([item('b', 3), item('a', 5), item('cur', 7)]);
    expect(map.get('b')).toBe(0);
    expect(map.get('a')).toBe(1);
    expect(map.get('cur')).toBe(2);
  });

  it('条里没有的图查不到（调用方自己兜底）', () => {
    expect(buildStripIndexById([item('a', 0)]).get('x')).toBeUndefined();
  });

  it('空条返回空表', () => {
    expect(buildStripIndexById([]).size).toBe(0);
  });
});

describe('resolveStripTextIndex', () => {
  const stripIndexById = buildStripIndexById([item('A', 0), item('B', 1), item('C', 2)]);

  it('条里有一批图时用条内位置 —— 拖动就变', () => {
    expect(
      resolveStripTextIndex({ hasBatch: true, currentId: 'B', stripIndexById, storedIndex: 9 })
    ).toBe(1);
  });

  it('拖动之后条内位置变了，编号跟着变（同一个 storedIndex）', () => {
    const reordered = buildStripIndexById([item('B', 0), item('A', 1), item('C', 2)]);
    expect(
      resolveStripTextIndex({ hasBatch: true, currentId: 'B', stripIndexById: reordered, storedIndex: 9 })
    ).toBe(0);
  });

  it('条里只剩当前图时，保留这张图存下来的编号（逐张点应用的关键）', () => {
    expect(
      resolveStripTextIndex({
        hasBatch: false,
        currentId: 'B',
        stripIndexById: new Map([['B', 0]]),
        storedIndex: 1,
      })
    ).toBe(1);
  });

  it('条里只剩当前图、也没存过编号时兜底 0', () => {
    expect(
      resolveStripTextIndex({
        hasBatch: false,
        currentId: 'B',
        stripIndexById: new Map([['B', 0]]),
        storedIndex: 0,
      })
    ).toBe(0);
  });

  it('有条但当前图不在表里时兜底 0', () => {
    expect(
      resolveStripTextIndex({ hasBatch: true, currentId: 'X', stripIndexById, storedIndex: 5 })
    ).toBe(0);
  });

  it('没有当前图时兜底 0', () => {
    expect(
      resolveStripTextIndex({ hasBatch: true, currentId: undefined, stripIndexById, storedIndex: 5 })
    ).toBe(0);
  });
});
