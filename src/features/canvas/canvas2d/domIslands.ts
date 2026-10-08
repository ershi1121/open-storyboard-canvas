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
}

export const DOM_ISLAND_DEFAULTS = {
  /** 低于该缩放不启用 DOM 岛（LOD1 阈值，与渲染器文字档一致） */
  minZoom: 0.75,
  /** 视口外扩（世界像素），提前挂载边缘节点 */
  margin: 200,
  /** 同时挂载的 DOM 岛上限（保护交互性能） */
  cap: 24,
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

  if (viewport.zoom < minZoom || viewport.zoom <= 0) return [];

  const worldW = viewport.viewW / viewport.zoom;
  const worldH = viewport.viewH / viewport.zoom;
  const wx = viewport.camX - margin;
  const wy = viewport.camY - margin;
  const ww = worldW + margin * 2;
  const wh = worldH + margin * 2;

  const inView = nodes.filter(
    (n) => n.x + n.w > wx && n.x < wx + ww && n.y + n.h > wy && n.y < wy + wh,
  );

  const centerX = viewport.camX + worldW / 2;
  const centerY = viewport.camY + worldH / 2;
  const dist = (n: IslandRect): number => {
    const dx = n.x + n.w / 2 - centerX;
    const dy = n.y + n.h / 2 - centerY;
    return dx * dx + dy * dy;
  };

  inView.sort((a, b) => {
    const sa = selectedIds.has(a.id) ? 0 : 1;
    const sb = selectedIds.has(b.id) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return dist(a) - dist(b);
  });

  return inView.slice(0, cap).map((n) => n.id);
}
