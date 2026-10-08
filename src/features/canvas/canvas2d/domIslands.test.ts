import { describe, expect, it } from 'vitest';

import { DOM_ISLAND_DEFAULTS, selectDomIslands } from './domIslands';

function rect(id: string, x: number, y: number, w = 300, h = 200) {
  return { id, x, y, w, h };
}

const VP = { camX: 0, camY: 0, zoom: 1, viewW: 1200, viewH: 800 };
const NONE = new Set<string>();

describe('selectDomIslands（DOM 岛候选选择）', () => {
  it('zoom 低于阈值：全部回退画布卡片', () => {
    const ids = selectDomIslands([rect('a', 0, 0)], NONE, { ...VP, zoom: 0.5 });
    expect(ids).toEqual([]);
  });

  it('zoom 达标且视口内：入选', () => {
    const ids = selectDomIslands([rect('a', 100, 100)], NONE, VP);
    expect(ids).toEqual(['a']);
  });

  it('视口外（含 margin 外扩仍够不到）：不入选', () => {
    const ids = selectDomIslands([rect('far', 5000, 5000)], NONE, VP);
    expect(ids).toEqual([]);
  });

  it('margin 内扩：视口边缘外的节点提前挂载', () => {
    const m = DOM_ISLAND_DEFAULTS.margin;
    const near = rect('near', 1200 + m - 50, 100); // 右边缘外 50（< margin）
    const ids = selectDomIslands([near], NONE, VP);
    expect(ids).toEqual(['near']);
  });

  it('选中节点优先入岛，其余按距中心排序', () => {
    const nodes = [rect('a', 900, 600), rect('b', 100, 100), rect('c', 500, 300)];
    const ids = selectDomIslands(nodes, new Set(['a']), VP);
    expect(ids[0]).toBe('a');
    expect(ids).toContain('c');
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('b'));
  });

  it('超过上限截断，但选中节点始终保留', () => {
    const nodes: ReturnType<typeof rect>[] = [];
    for (let i = 0; i < 40; i++) nodes.push(rect(`n${i}`, (i % 8) * 140, Math.floor(i / 8) * 160, 100, 100));
    const ids = selectDomIslands(nodes, new Set(['n39']), VP);
    expect(ids.length).toBeLessThanOrEqual(DOM_ISLAND_DEFAULTS.cap);
    expect(ids).toContain('n39');
  });

  it('zoom 恰为阈值：启用', () => {
    const ids = selectDomIslands([rect('a', 0, 0)], NONE, { ...VP, zoom: DOM_ISLAND_DEFAULTS.minZoom });
    expect(ids).toEqual(['a']);
  });
});
