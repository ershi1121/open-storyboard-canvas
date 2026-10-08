/**
 * 选择条的顺序工具。
 *
 * 单独放一个模块是为了能直接单测 —— 这段索引计算最容易写错：
 * 条里只是全局顺序的一个**子集**（当前图 ∪ 队列），槽位映射错一格，
 * 没显示在条里的图编号就会跟着乱。
 *
 * ⭐ 条里有两套「顺序」，别混：
 *  1. **全局顺序**（`orderIndex`）—— 图片在整张画布所有图片节点里的位置。
 *     它决定条里怎么排（`orderStripItems`），也决定拖动时往哪个槽位写回全局（`applyStripReorder`）。
 *  2. **条内位置**（`buildStripIndexById`）—— 该图在「当前图 ∪ 队列」这一小撮里排第几（0-based）。
 *     **文字的 {n} 编号读的是它**，条上的编号徽章也读它。
 *     所以拖一下条，编号就跟着变；不点「应用」，画布上的图不会动。
 */

/** 条里的一项至少要有 id 和用于排序的 orderIndex。 */
export interface StripOrderItem {
  id: string;
  orderIndex?: number;
}

/**
 * 条里的渲染顺序 = 按全局 `orderIndex` 升序。
 *
 * `orderIndex` 缺失（理论上不会发生）时兜到最后，保证排序稳定。
 */
export function orderStripItems<T extends StripOrderItem>(current: T, queued: T[]): T[] {
  return [current, ...queued].sort(
    (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * 条内 0-based 位置表：id → 它在条里排第几。
 *
 * ⚠️ 这是**文字编号的唯一依据**（`编号 = 起始编号 + 条内位置`）。
 * 条里没有的图不会出现在表里 —— 调用方读到 undefined 时自己兜底。
 */
export function buildStripIndexById(items: StripOrderItem[]): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item, index) => map.set(item.id, index));
  return map;
}

export interface ResolveStripTextIndexParams {
  /** 条里是不是在编排**一批**图（当前图之外还有人）。 */
  hasBatch: boolean;
  /** 当前编辑图的 id。 */
  currentId?: string;
  /** 条内 0-based 位置表。 */
  stripIndexById: Map<string, number>;
  /** 这张图**存下来的**编号（批量套用时落盘的那份）。 */
  storedIndex: number;
}

/**
 * 决定当前图最终用哪个编号（0-based）—— 文字编号 = 起始编号 + 它。
 *
 * ⭐ 两条分支，别合并：
 *  - **条里有一批图** → 用条内位置。用户正在编排，所见即所得，拖一下就变。
 *  - **条里只剩当前图** → 用这张图存下来的编号。
 *    因为「应用」是确认落图、会关掉面板，条就没了；用户逐张切过去点「应用」时，
 *    每张图必须还记得自己在那一批里排第几，否则会全部退回 1。
 */
export function resolveStripTextIndex({
  hasBatch,
  currentId,
  stripIndexById,
  storedIndex,
}: ResolveStripTextIndexParams): number {
  if (!hasBatch) {
    return storedIndex;
  }
  if (!currentId) {
    return 0;
  }
  return stripIndexById.get(currentId) ?? 0;
}

/**
 * 把条里的新顺序写回全局顺序。
 *
 * 做法：先找出 `stripOrder` 里这些图在 `globalOrder` 中占据的位置槽（升序），
 * 再把新顺序依次填进这些槽 —— **没显示在条里的图原地不动**。
 *
 * 例：全局 [A,B,C,D,E]，条里显示 [A,C,E]，用户拖成 [E,A,C]
 *     → 槽位 [0,2,4] → 结果 [E,B,A,D,C]
 *
 * 入参不合法（有重复 id、有 id 不在全局里、数量对不上）时原样返回，绝不部分应用。
 */
export function applyStripReorder(globalOrder: string[], stripOrder: string[]): string[] {
  if (stripOrder.length === 0) {
    return globalOrder;
  }
  if (new Set(stripOrder).size !== stripOrder.length) {
    return globalOrder;
  }

  const stripSet = new Set(stripOrder);
  const slots: number[] = [];
  globalOrder.forEach((id, index) => {
    if (stripSet.has(id)) {
      slots.push(index);
    }
  });

  if (slots.length !== stripOrder.length) {
    return globalOrder;
  }

  const next = [...globalOrder];
  slots.forEach((slot, index) => {
    next[slot] = stripOrder[index];
  });
  return next;
}
