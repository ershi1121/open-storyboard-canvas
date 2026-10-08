import { graphlib, layout } from '@dagrejs/dagre';

/**
 * 整理/自动排列的布局。
 *
 * 两步：① 每个连通簇内部用 **dagre 分层布局**（参考图→生成→结果 从左到右、连线短）；
 *       ② 把各簇**二维铺成网格**（≈√N 列），而不是让 dagre 把不相连的簇堆成一竖列。
 *
 * ⭐ 为什么自己铺簇：dagre 对「多个互不相连的簇」会纵向堆叠成一列，簇一多就变成
 * 又细又长的一竖排。这里按簇数排成接近正方形的网格，看起来才均匀。
 */
export interface TidyNodeInput {
  id: string;
  position: { x: number; y: number };
}

export interface TidyEdgeInput {
  source: string;
  target: string;
}

export interface TidyLayoutOptions {
  sizeOf: (id: string) => { width: number; height: number };
  /** 初始排序倾向（dagre 在此基础上再降交叉）：name＝文件名自然序，position＝当前坐标。 */
  sortBy: 'name' | 'position';
  nameOf: (id: string) => string;
  originX?: number;
  originY?: number;
  /** 簇内同层节点间距（垂直于流向）。 */
  nodeGap?: number;
  /** 簇内层间距（沿流向）。 */
  rankGap?: number;
  rankdir?: 'LR' | 'TB';
  /** 簇与簇之间的水平/垂直留白。 */
  clusterGapX?: number;
  clusterGapY?: number;
  /** 网格列数；不传则按簇数取 ≈√N。 */
  cols?: number;
}

interface ComponentLayout {
  local: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** 对单个连通簇跑 dagre，返回以 (0,0) 为左上起点的相对坐标 + 包围盒尺寸。 */
function dagreLayoutComponent(
  nodes: TidyNodeInput[],
  edges: TidyEdgeInput[],
  opts: TidyLayoutOptions
): ComponentLayout {
  const idSet = new Set(nodes.map((node) => node.id));
  const initialOrder = [...nodes].sort((a, b) => {
    if (opts.sortBy === 'position') {
      const ay = Math.round(a.position.y / 40);
      const by = Math.round(b.position.y / 40);
      return ay - by || a.position.x - b.position.x;
    }
    return opts.nameOf(a.id).localeCompare(opts.nameOf(b.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });

  const g = new graphlib.Graph();
  g.setGraph({
    rankdir: opts.rankdir ?? 'LR',
    nodesep: opts.nodeGap ?? 40,
    ranksep: opts.rankGap ?? 90,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of initialOrder) {
    const size = opts.sizeOf(node.id);
    g.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of edges) {
    if (edge.source !== edge.target && idSet.has(edge.source) && idSet.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }
  layout(g);

  // 中心坐标 → 左上角，并归一到 (0,0)。
  const local = new Map<string, { x: number; y: number }>();
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = 0;
  let maxBottom = 0;
  g.nodes().forEach((id) => {
    const n = g.node(id);
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
  });
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }
  g.nodes().forEach((id) => {
    const n = g.node(id);
    const x = n.x - n.width / 2 - minX;
    const y = n.y - n.height / 2 - minY;
    local.set(id, { x, y });
    maxRight = Math.max(maxRight, x + n.width);
    maxBottom = Math.max(maxBottom, y + n.height);
  });
  return { local, width: maxRight, height: maxBottom };
}

export function layoutGraphWithDagre(
  nodes: TidyNodeInput[],
  edges: TidyEdgeInput[],
  opts: TidyLayoutOptions
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) {
    return positions;
  }
  const idSet = new Set(nodes.map((node) => node.id));

  // 连通分量（无向）。
  const undirected = new Map<string, Set<string>>();
  for (const node of nodes) {
    undirected.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (edge.source === edge.target || !idSet.has(edge.source) || !idSet.has(edge.target)) {
      continue;
    }
    undirected.get(edge.source)!.add(edge.target);
    undirected.get(edge.target)!.add(edge.source);
  }
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const components: TidyNodeInput[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const stack = [node.id];
    visited.add(node.id);
    const memberIds: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      memberIds.push(current);
      for (const neighbor of undirected.get(current)!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(memberIds.map((id) => byId.get(id)!));
  }

  // 簇之间按初始 key 排序，保证网格排布稳定（名称序 / 位置序）。
  const compKeyCompare = (a: TidyNodeInput[], b: TidyNodeInput[]): number => {
    const first = (comp: TidyNodeInput[]) =>
      [...comp].sort((x, y) => {
        if (opts.sortBy === 'position') {
          const xy = Math.round(x.position.y / 40);
          const yy = Math.round(y.position.y / 40);
          return xy - yy || x.position.x - y.position.x;
        }
        return opts.nameOf(x.id).localeCompare(opts.nameOf(y.id), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      })[0];
    const fa = first(a);
    const fb = first(b);
    if (opts.sortBy === 'position') {
      const ay = Math.round(fa.position.y / 40);
      const by = Math.round(fb.position.y / 40);
      return ay - by || fa.position.x - fb.position.x;
    }
    return opts.nameOf(fa.id).localeCompare(opts.nameOf(fb.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  };
  components.sort(compKeyCompare);

  // 每簇跑 dagre。
  const laidOut = components.map((component) => {
    const compIdSet = new Set(component.map((node) => node.id));
    const compEdges = edges.filter(
      (edge) => compIdSet.has(edge.source) && compIdSet.has(edge.target)
    );
    return dagreLayoutComponent(component, compEdges, opts);
  });

  // 二维铺簇：≈√N 列，逐行摆放，行高取该行最高簇。
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const gapX = opts.clusterGapX ?? 80;
  const gapY = opts.clusterGapY ?? 80;
  const cols =
    opts.cols && opts.cols > 0 ? opts.cols : Math.max(1, Math.ceil(Math.sqrt(components.length)));

  let cursorX = originX;
  let cursorY = originY;
  let rowMaxH = 0;
  let inRow = 0;
  for (const comp of laidOut) {
    if (inRow >= cols) {
      cursorX = originX;
      cursorY += rowMaxH + gapY;
      rowMaxH = 0;
      inRow = 0;
    }
    for (const [id, point] of comp.local) {
      positions.set(id, { x: cursorX + point.x, y: cursorY + point.y });
    }
    cursorX += comp.width + gapX;
    rowMaxH = Math.max(rowMaxH, comp.height);
    inRow += 1;
  }

  return positions;
}
