import { describe, expect, it } from 'vitest';

import { layoutGraphWithDagre } from './arrangeOrder';

const SIZE = () => ({ width: 220, height: 200 });

function boxesOverlap(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w = 220,
  h = 200
): boolean {
  return a.x < b.x + w && a.x + w > b.x && a.y < b.y + h && a.y + h > b.y;
}

describe('layoutGraphWithDagre', () => {
  it('参考图→生成→结果 按层从左到右排（父列在子列左边）', () => {
    const nodes = [
      { id: 'ref', position: { x: 0, y: 0 } },
      { id: 'g1', position: { x: 0, y: 0 } },
      { id: 'g2', position: { x: 0, y: 0 } },
      { id: 'r1', position: { x: 0, y: 0 } },
      { id: 'r2', position: { x: 0, y: 0 } },
      { id: 'r3', position: { x: 0, y: 0 } },
    ];
    const edges = [
      { source: 'ref', target: 'g1' },
      { source: 'ref', target: 'g2' },
      { source: 'g1', target: 'r1' },
      { source: 'g1', target: 'r2' },
      { source: 'g2', target: 'r3' },
    ];
    const pos = layoutGraphWithDagre(nodes, edges, {
      sortBy: 'name',
      nameOf: (id) => id,
      sizeOf: SIZE,
    });
    // 每个节点都有位置
    expect(pos.size).toBe(nodes.length);
    // 分层：参考图最左，生成节点次之，结果最右
    expect(pos.get('ref')!.x).toBeLessThan(pos.get('g1')!.x);
    expect(pos.get('g1')!.x).toBeLessThan(pos.get('r1')!.x);
    expect(pos.get('g2')!.x).toBeLessThan(pos.get('r3')!.x);
    // 同层（rank）的节点 x 对齐：两个生成节点同列，三个结果同列
    expect(pos.get('g1')!.x).toBe(pos.get('g2')!.x);
    expect(pos.get('r1')!.x).toBe(pos.get('r2')!.x);
    expect(pos.get('r2')!.x).toBe(pos.get('r3')!.x);
  });

  it('不相连的两簇互不重叠（dagre 自动堆开，连线不跨簇）', () => {
    const nodes = [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 0, y: 0 } },
      { id: 'c', position: { x: 0, y: 0 } },
      { id: 'd', position: { x: 0, y: 0 } },
    ];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ];
    const pos = layoutGraphWithDagre(nodes, edges, {
      sortBy: 'name',
      nameOf: (id) => id,
      sizeOf: SIZE,
    });
    // 簇1(a,b) 与 簇2(c,d) 的任意节点都不应重叠
    for (const x of ['a', 'b']) {
      for (const y of ['c', 'd']) {
        expect(boxesOverlap(pos.get(x)!, pos.get(y)!)).toBe(false);
      }
    }
  });

  it('空输入返回空', () => {
    const pos = layoutGraphWithDagre([], [], {
      sortBy: 'name',
      nameOf: () => '',
      sizeOf: SIZE,
    });
    expect(pos.size).toBe(0);
  });

  it('多个不相连簇铺成二维网格，而不是挤成一竖列', () => {
    const nodes: { id: string; position: { x: number; y: number } }[] = [];
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < 9; i += 1) {
      nodes.push({ id: `a${i}`, position: { x: 0, y: 0 } });
      nodes.push({ id: `b${i}`, position: { x: 0, y: 0 } });
      edges.push({ source: `a${i}`, target: `b${i}` });
    }
    const pos = layoutGraphWithDagre(nodes, edges, {
      sortBy: 'name',
      nameOf: (id) => id,
      sizeOf: SIZE,
    });
    const distinctX = new Set([...pos.values()].map((p) => Math.round(p.x)));
    const distinctY = new Set([...pos.values()].map((p) => Math.round(p.y)));
    // 9 簇 → ≈3×3 网格：横向、纵向都应有多个不同位置（不是 1 竖列）
    expect(distinctX.size).toBeGreaterThanOrEqual(3);
    expect(distinctY.size).toBeGreaterThanOrEqual(3);
  });
});
