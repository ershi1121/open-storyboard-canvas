import { describe, expect, it } from 'vitest';

import { DOM_ISLAND_DEFAULTS, selectDomIslands } from './domIslands';

function rect(id: string, x: number, y: number, w = 300, h = 200) {
  return { id, x, y, w, h };
}

const VP = { camX: 0, camY: 0, zoom: 1, viewW: 1200, viewH: 800 };
const NONE = new Set<string>();

describe('selectDomIslands（DOM 岛候选选择）', () => {
  it('极端全览（zoom < minZoom）且无选中：不挂载岛', () => {
    const ids = selectDomIslands([rect('a', 0, 0)], NONE, { ...VP, zoom: 0.02 });
    expect(ids).toEqual([]);
  });

  it('极端全览下选中节点仍然入岛（内联编辑永远可用）', () => {
    const ids = selectDomIslands([rect('a', 0, 0), rect('b', 400, 0)], new Set(['b']), {
      ...VP,
      zoom: 0.02,
    });
    expect(ids).toEqual(['b']);
  });

  it('常规缩放（zoom 0.5）视口内节点入岛', () => {
    const ids = selectDomIslands([rect('a', 0, 0)], NONE, { ...VP, zoom: 0.5 });
    expect(ids).toEqual(['a']);
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

  it('zoom 恰为阈值：启用', () => {
    const ids = selectDomIslands([rect('a', 0, 0)], NONE, { ...VP, zoom: DOM_ISLAND_DEFAULTS.minZoom });
    expect(ids).toEqual(['a']);
  });

  it('超过上限截断，但选中节点始终保留', () => {
    const nodes: ReturnType<typeof rect>[] = [];
    for (let i = 0; i < 70; i++) {
      nodes.push(rect(`n${i}`, (i % 10) * 110, Math.floor(i / 10) * 110, 100, 100));
    }
    const ids = selectDomIslands(nodes, new Set(['n69']), VP, { cap: 60 });
    expect(ids.length).toBe(60);
    expect(ids).toContain('n69');
    expect(ids[0]).toBe('n69'); // 选中排序优先
  });

  it('默认上限 200：百节点项目全视口全部入岛（不再出现卡片切换）', () => {
    const nodes: ReturnType<typeof rect>[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(rect(`n${i}`, (i % 10) * 130, Math.floor(i / 10) * 130, 120, 120));
    }
    const ids = selectDomIslands(nodes, NONE, { ...VP, viewW: 4000, viewH: 3000 });
    expect(ids.length).toBe(100);
    expect(DOM_ISLAND_DEFAULTS.cap).toBe(200);
  });
});
