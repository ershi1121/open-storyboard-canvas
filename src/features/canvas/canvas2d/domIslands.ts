/**
 * DOM 岛（混合渲染）候选选择：纯函数，可单测。
 *
 * 规则：
 * - zoom < minZoom：全部走画布卡片（全览性能优先），返回空
 * - 仅考虑与视口（含 margin 外扩）相交的节点
 * - 选中节点优先，其次按距视口中心距离排序；总数不超过 cap
 */

export interface IslandRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IslandViewport {
  /** 相机世界坐标左上角 */
  camX: number;
  camY: number;
  zoom: number;
  /** 视口像素尺寸 */
  viewW: number;
  viewH: number;
}

export interface DomIslandOptions {
  minZoom?: number;
  margin?: number;
  cap?: number;
  minScreenW?: number;
  minScreenH?: number;
}

export const DOM_ISLAND_DEFAULTS = {
  /** 低于该缩放仅挂载选中节点（极端全览保护） */
  minZoom: 0.05,
  /** 视口外扩（世界像素），提前挂载边缘节点 */
  margin: 200,
  /** 同时挂载的 DOM 岛上限（极端规模保护）；选中节点不受上限约束 */
  cap: 200,
  /** 屏幕空间 LOD：节点在屏幕上的宽/高低于该值时不挂岛（画布卡片代替）。
   *  屏幕上读不懂的编辑器不值得挂载——174 节点项目在全览缩放曾因此
   *  挂载 161 个重型组件把主线程压到 4fps（诊断面板实测）。 */
  minScreenW: 90,
  minScreenH: 24,
};

export function selectDomIslands(
  nodes: IslandRect[],
  selectedIds: ReadonlySet<string>,
  viewport: IslandViewport,
  options: DomIslandOptions = {},
): string[] {
  const minZoom = options.minZoom ?? DOM_ISLAND_DEFAULTS.minZoom;
  const margin = options.margin ?? DOM_ISLAND_DEFAULTS.margin;
  const cap = options.cap ?? DOM_ISLAND_DEFAULTS.cap;
  const minScreenW = options.minScreenW ?? DOM_ISLAND_DEFAULTS.minScreenW;
  const minScreenH = options.minScreenH ?? DOM_ISLAND_DEFAULTS.minScreenH;

  const worldW = viewport.viewW / viewport.zoom;
  const worldH = viewport.viewH / viewport.zoom;
  const wx = viewport.camX - margin;
  const wy = viewport.camY - margin;
  const ww = worldW + margin * 2;
  const wh = worldH + margin * 2;

  const inView = nodes.filter(
    (n) => n.x + n.w > wx && n.x < wx + ww && n.y + n.h > wy && n.y < wy + wh,
  );

  // 极端全览（zoom < minZoom）：仅挂载选中节点，保证随时可内联编辑
  if (viewport.zoom < minZoom || viewport.zoom <= 0) {
    return inView.filter((n) => selectedIds.has(n.id)).map((n) => n.id);
  }

  // 屏幕空间 LOD：屏幕上不够大、读不懂的节点用画布卡片，不挂 DOM 岛；
  // 选中节点豁免（保证点中即可内联编辑）
  const candidates = inView.filter(
    (n) =>
      selectedIds.has(n.id) ||
      (n.w * viewport.zoom >= minScreenW && n.h * viewport.zoom >= minScreenH),
  );

  const centerX = viewport.camX + worldW / 2;
  const centerY = viewport.camY + worldH / 2;
  const dist = (n: IslandRect): number => {
    const dx = n.x + n.w / 2 - centerX;
    const dy = n.y + n.h / 2 - centerY;
    return dx * dx + dy * dy;
  };

  candidates.sort((a, b) => {
    const sa = selectedIds.has(a.id) ? 0 : 1;
    const sb = selectedIds.has(b.id) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return dist(a) - dist(b);
  });

  const picked = candidates.slice(0, cap).map((n) => n.id);
  // 选中节点始终入岛（不受上限约束）：内联编辑永远可用
  const pickedSet = new Set(picked);
  for (const n of candidates) {
    if (selectedIds.has(n.id) && !pickedSet.has(n.id)) {
      picked.push(n.id);
      pickedSet.add(n.id);
    }
  }
  return picked;
}
