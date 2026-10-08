import { describe, expect, it } from 'vitest';

import { collectFollowCluster, filterDragDescendants } from './spatialGrid';

function rect(id: string, x: number, y: number, w: number, h: number) {
  return { id, x, y, w, h };
}

describe('collectFollowCluster（磁吸跟随簇）', () => {
  it('间隙 ≤ 1 世界像素的贴合节点加入跟随簇', () => {
    const nodes = [rect('a', 0, 0, 100, 100), rect('b', 100.5, 0, 100, 100)];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect([...follow]).toEqual(['b']);
  });

  it('间隙 > 1 的节点不跟随', () => {
    const nodes = [rect('a', 0, 0, 100, 100), rect('b', 103, 0, 100, 100)];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.size).toBe(0);
  });

  it('重叠节点不加入跟随簇（如分组与其子节点）', () => {
    const nodes = [rect('a', 0, 0, 100, 100), rect('b', 50, 50, 100, 100)];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.size).toBe(0);
  });

  it('BFS 传播：A 贴 B、B 贴 C ⇒ 拖 A 时 B、C 都跟随', () => {
    const nodes = [
      rect('a', 0, 0, 100, 100),
      rect('b', 100, 0, 100, 100),
      rect('c', 200, 0, 100, 100),
    ];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.has('b')).toBe(true);
    expect(follow.has('c')).toBe(true);
  });

  it('链断裂处停止传播', () => {
    const nodes = [
      rect('a', 0, 0, 100, 100),
      rect('b', 100, 0, 100, 100),
      rect('c', 300, 0, 100, 100), // 与 b 间隙 100
    ];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.has('b')).toBe(true);
    expect(follow.has('c')).toBe(false);
  });

  it('seeds 自身不出现在返回值中（多选拖拽整体作为种子）', () => {
    const nodes = [
      rect('a', 0, 0, 100, 100),
      rect('b', 100, 0, 100, 100),
      rect('c', 200, 0, 100, 100),
    ];
    const follow = collectFollowCluster(new Set(['a', 'b']), nodes);
    expect(follow.has('a')).toBe(false);
    expect(follow.has('b')).toBe(false);
    expect(follow.has('c')).toBe(true);
  });

  it('垂直方向贴合同样触发跟随', () => {
    const nodes = [rect('a', 0, 0, 100, 100), rect('b', 0, 101, 100, 100)];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.has('b')).toBe(true);
  });

  it('对角间隙取 max(dx, dy)：斜向错开 3px 不跟随', () => {
    const nodes = [rect('a', 0, 0, 100, 100), rect('b', 103, 103, 100, 100)];
    const follow = collectFollowCluster(new Set(['a']), nodes);
    expect(follow.size).toBe(0);
  });

  it('空场景 / 未知种子安全返回空集', () => {
    expect(collectFollowCluster(new Set(['x']), []).size).toBe(0);
    expect(collectFollowCluster(new Set(), [rect('a', 0, 0, 10, 10)]).size).toBe(0);
  });
});

describe('filterDragDescendants（回归）', () => {
  it('父在集合内时过滤子节点，避免双重位移', () => {
    const parentOf = new Map<string, string | undefined>([
      ['g', undefined],
      ['c1', 'g'],
      ['c2', 'g'],
      ['free', undefined],
    ]);
    expect(filterDragDescendants(['g', 'c1', 'free'], parentOf)).toEqual(['g', 'free']);
  });
});
