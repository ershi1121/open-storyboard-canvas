import { describe, expect, it } from 'vitest';

import {
  addEdgeInternal,
  applyEdgeChangesInternal,
  applyNodeChangesInternal,
  getEdgeIdInternal,
  type GraphElementChange,
} from './graphMutations';

interface TestNode {
  id: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  selected?: boolean;
  dragging?: boolean;
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  resizing?: boolean;
}

interface TestEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  selected?: boolean;
}

const node = (id: string, x = 0, y = 0): TestNode => ({ id, position: { x, y }, data: {} });

describe('applyNodeChangesInternal（历史数据层 applyChanges 语义对齐）', () => {
  it('position 变更写入 position 与 dragging', () => {
    const nodes = [node('a'), node('b')];
    const changes: Array<GraphElementChange<TestNode>> = [
      { type: 'position', id: 'a', position: { x: 10, y: 20 }, dragging: true },
    ];
    const next = applyNodeChangesInternal(changes, nodes);
    expect(next[0].position).toEqual({ x: 10, y: 20 });
    expect(next[0].dragging).toBe(true);
    // 未变更元素保持原引用（避免无谓重渲染）
    expect(next[1]).toBe(nodes[1]);
    expect(next[0]).not.toBe(nodes[0]);
  });

  it('dimensions + setAttributes 同步 measured 与 width/height，resizing 落盘', () => {
    const nodes = [node('a')];
    const changes: Array<GraphElementChange<TestNode>> = [
      { type: 'dimensions', id: 'a', dimensions: { width: 300, height: 200 }, setAttributes: true, resizing: false },
    ];
    const next = applyNodeChangesInternal(changes, nodes);
    expect(next[0].measured).toEqual({ width: 300, height: 200 });
    expect(next[0].width).toBe(300);
    expect(next[0].height).toBe(200);
    expect(next[0].resizing).toBe(false);
  });

  it('setAttributes=width 只写宽度', () => {
    const next = applyNodeChangesInternal(
      [{ type: 'dimensions', id: 'a', dimensions: { width: 111, height: 222 }, setAttributes: 'width' }],
      [node('a')],
    );
    expect(next[0].width).toBe(111);
    expect(next[0].height).toBeUndefined();
    expect(next[0].measured).toEqual({ width: 111, height: 222 });
  });

  it('remove 移除节点且吞掉同 id 的其他变更', () => {
    const nodes = [node('a'), node('b')];
    const changes: Array<GraphElementChange<TestNode>> = [
      { type: 'position', id: 'a', position: { x: 5, y: 5 }, dragging: false },
      { type: 'remove', id: 'a' },
    ];
    const next = applyNodeChangesInternal(changes, nodes);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('b');
  });

  it('replace 以浅拷贝替换', () => {
    const replacement = node('a', 99, 99);
    const next = applyNodeChangesInternal(
      [{ type: 'replace', id: 'a', item: replacement }],
      [node('a'), node('b')],
    );
    expect(next[0].position).toEqual({ x: 99, y: 99 });
    expect(next[0]).not.toBe(replacement);
  });

  it('add 默认追加、带 index 插入', () => {
    const nodes = [node('a'), node('b')];
    const appended = applyNodeChangesInternal([{ type: 'add', item: node('c') }], nodes);
    expect(appended.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    const inserted = applyNodeChangesInternal([{ type: 'add', item: node('x'), index: 1 }], nodes);
    expect(inserted.map((n) => n.id)).toEqual(['a', 'x', 'b']);
  });

  it('select 变更写入 selected；同元素多变更合并到同一份拷贝', () => {
    const nodes = [node('a')];
    const changes: Array<GraphElementChange<TestNode>> = [
      { type: 'select', id: 'a', selected: true },
      { type: 'position', id: 'a', position: { x: 1, y: 2 }, dragging: false },
    ];
    const next = applyNodeChangesInternal(changes, nodes);
    expect(next[0].selected).toBe(true);
    expect(next[0].position).toEqual({ x: 1, y: 2 });
  });
});

describe('applyEdgeChangesInternal', () => {
  it('select/remove 对边生效', () => {
    const edges: TestEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const next = applyEdgeChangesInternal(
      [
        { type: 'select', id: 'e1', selected: true },
        { type: 'remove', id: 'e2' },
      ],
      edges,
    );
    expect(next).toHaveLength(1);
    expect(next[0].selected).toBe(true);
  });
});

describe('addEdgeInternal（历史数据层 addEdge 语义对齐）', () => {
  const edges: TestEdge[] = [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'source', targetHandle: 'target' }];

  it('无 id 时按 xy-edge__ 约定生成', () => {
    const next = addEdgeInternal<TestEdge>({ source: 'b', target: 'c' }, edges);
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe(getEdgeIdInternal({ source: 'b', target: 'c' }));
    expect(next[1].id).toBe('xy-edge__b-c');
  });

  it('显式 id 原样保留', () => {
    const next = addEdgeInternal<TestEdge>({ id: 'custom-1', source: 'b', target: 'c' }, edges);
    expect(next[1].id).toBe('custom-1');
  });

  it('相同 source/target/handle 去重（handle 空值等价）', () => {
    const same = addEdgeInternal<TestEdge>(
      { id: 'other', source: 'a', target: 'b', sourceHandle: 'source', targetHandle: 'target' },
      edges,
    );
    expect(same).toBe(edges);
    const nullVsUndefined = addEdgeInternal<TestEdge>(
      { id: 'other2', source: 'x', target: 'y', sourceHandle: null },
      [{ id: 'e0', source: 'x', target: 'y' }],
    );
    expect(nullVsUndefined).toHaveLength(1);
  });

  it('缺 source/target 时原样返回', () => {
    const next = addEdgeInternal<TestEdge>({ source: '', target: 'b' }, edges);
    expect(next).toBe(edges);
  });

  it('null handle 在入列前被删除', () => {
    const next = addEdgeInternal<TestEdge>({ source: 'p', target: 'q', targetHandle: null }, edges);
    expect('targetHandle' in next[1]).toBe(false);
  });
});
