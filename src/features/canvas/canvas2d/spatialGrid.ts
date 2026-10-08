import type { RenderNode } from './sceneModel';

/**
 * 均匀网格空间索引：视口裁剪与命中测试。
 * 千级节点下 O(1)~O(可见数) 查询；后续可平滑替换为 rbush/flatbush。
 */
const CELL = 512;

function key(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export class SpatialGrid {
  private map = new Map<string, number[]>();
  private items: RenderNode[] = [];

  constructor(items: RenderNode[] = []) {
    this.rebuild(items);
  }

  rebuild(items: RenderNode[]): void {
    this.items = items;
    this.map.clear();
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      const x0 = Math.floor(n.x / CELL);
      const x1 = Math.floor((n.x + n.w) / CELL);
      const y0 = Math.floor(n.y / CELL);
      const y1 = Math.floor((n.y + n.h) / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = key(gx, gy);
          let bucket = this.map.get(k);
          if (!bucket) this.map.set(k, (bucket = []));
          bucket.push(i);
        }
      }
    }
  }

  /** 返回与矩形可能相交的候选下标（可能重复，调用方按需去重） */
  queryRect(r: { x: number; y: number; w: number; h: number }, out: number[] = []): number[] {
    out.length = 0;
    const x0 = Math.floor(r.x / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL);
    const y0 = Math.floor(r.y / CELL);
    const y1 = Math.floor((r.y + r.h) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const bucket = this.map.get(key(gx, gy));
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
        }
      }
    }
    return out;
  }

  /** 命中测试：普通节点优先于分组；同类取绘制顺序最靠上的 */
  hitTest(x: number, y: number): RenderNode | null {
    const candidates = this.queryRect({ x: x - 1, y: y - 1, w: 2, h: 2 });
    let bestNormal: RenderNode | null = null;
    let bestGroup: RenderNode | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const n = this.items[candidates[i]];
      if (!n) continue;
      if (x < n.x || x > n.x + n.w || y < n.y || y > n.y + n.h) continue;
      if (n.isGroup) {
        if (!bestGroup || n.z > bestGroup.z) bestGroup = n;
      } else if (!bestNormal || n.z > bestNormal.z) {
        bestNormal = n;
      }
    }
    return bestNormal ?? bestGroup;
  }
}

/** 收集拖动某节点时需要一起移动的 id 集合：过滤掉集合内其他节点的后代（避免父子双重位移） */
export function filterDragDescendants(ids: string[], parentOf: Map<string, string | undefined>): string[] {
  const idSet = new Set(ids);
  return ids.filter((id) => {
    let parent = parentOf.get(id);
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      if (idSet.has(parent)) return false;
      parent = parentOf.get(parent);
    }
    return true;
  });
}

/* ---------------- 磁吸跟随簇 ---------------- */

/** 跟随判定间隙（世界像素）：几乎贴着的节点才互相跟随 */
const FOLLOW_GAP = 1;

export interface FollowRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function followRectGap(
  a: FollowRect,
  b: FollowRect,
): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.max(dx, dy);
}

function followRectsOverlap(a: FollowRect, b: FollowRect): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > 0.5 && overlapY > 0.5;
}

/**
 * 收集"跟随簇"：与被拖拽集合几乎贴合（间隙 ≤ 1 世界像素、互不重叠）的节点，
 * 拖拽时随动，保持拼贴排版不散架。BFS 传播：A 贴 B、B 贴 C ⇒ 拖 A 时 B、C 都跟随。
 * 语义与旧版 useCanvasSnapFollow.collectFollowCluster 一致。
 *
 * @param seeds 被拖拽的节点集合（含其后代展开），不会出现在返回值中
 * @param nodes 全量渲染节点
 * @returns 需要跟随移动的节点 id 集合（不含 seeds）
 */
export function collectFollowCluster(
  seeds: ReadonlySet<string>,
  nodes: FollowRect[],
): Set<string> {
  const byId = new Map<string, FollowRect>();
  for (const n of nodes) byId.set(n.id, n);
  const cluster = new Set<string>(seeds);
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const curId = queue.pop() as string;
    const cur = byId.get(curId);
    if (!cur) continue;
    for (const other of nodes) {
      if (cluster.has(other.id)) continue;
      if (followRectsOverlap(cur, other)) continue;
      if (followRectGap(cur, other) <= FOLLOW_GAP) {
        cluster.add(other.id);
        queue.push(other.id);
      }
    }
  }
  for (const id of seeds) cluster.delete(id);
  return cluster;
}
