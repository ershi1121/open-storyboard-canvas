import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ToolOptions } from '../types';

/**
 * 字段名：每张图片节点独立存一份「上次调好的裁剪参数」。
 *
 * 嵌在 node.data 上而不是单独 map，理由：
 *  1. 跟随节点生命周期 —— 删除节点时存档也一起没了，避免脏数据；
 *  2. 跟着 nodes 一起序列化（如果有持久化），不用单独维护映射；
 *  3. CanvasNodeData 已有 `[key: string]: unknown` 索引签名，零接口改动。
 *
 * 存的字段是当时 CropToolEditor 持有的整份 ToolOptions：
 * - cropX/Y/W/H、customAspectRatio 来自裁剪区；
 * - borderLayers / borderStrokePercent / borderRadiusPercent / borderRatioMode /
 *   borderCustomRatio 来自边框 / 描边 / 圆角 / 按比例补边；
 * - aspectRatio 也会包含。
 *
 * 读时把它覆盖到默认 options 之上：缺什么补什么（DEFAULT_BORDER_OPTIONS 的好处），
 * 有多余字段（陈旧版本遗留下来的）忽略，safe by default。
 */
export const CROP_TOOL_STATE_KEY = 'cropToolState';

/**
 * ⚠️ 这里曾经有个 `cropBaseImageUrl`（批量套用前记下的「底图」）。
 *
 * 它是为「批量套用会原地改图」准备的：把边框 / 文字画进 imageUrl 再替换掉，
 * 没有底图的话第二次套用就会在上一次的成品上再叠一层 —— 边框越套越粗、文字越叠越糊。
 *
 * 现在批量套用**只分发参数、不落图**（用户点右下角「应用」才落），
 * 底图这个概念就没有存在意义了，字段和读取函数一并删掉。
 */

export interface CropToolStatePatch {
  /** 真实字段；其它 unknown 字段透传自上游（比如 displayName） */
  cropToolState?: ToolOptions;
  [key: string]: unknown;
}

/**
 * 从节点 data 读出之前保存的裁剪参数。
 *
 * 故意宽松：
 * - 节点没有 cropToolState 字段 → 返回 null（让调用方走默认路径）；
 * - cropToolState 不是对象 → 返回 null；
 * - cropToolState 是空对象 → 返回 null（没东西可恢复）。
 *
 * 不做字段级白名单校验：上层 createInitialOptions 已经会用 readBorderOptions /
 * parseBorderLayers 之类 sanitize，坏字段会被自然丢成默认值。
 */
export function readCropToolState(node: CanvasNode | null | undefined): ToolOptions | null {
  if (!node) {
    return null;
  }

  const raw = (node.data as Record<string, unknown>)[CROP_TOOL_STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  // ToolOptions = Record<string, string | number | boolean>。
  // 旧数据万一混进别的类型，逐项过滤一次，避免把脏值喂给下游。
  const sanitized: ToolOptions = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      sanitized[key] = value;
      hasAny = true;
    }
  }

  return hasAny ? sanitized : null;
}

/**
 * 把当前 ToolOptions 写入节点 data 的 cropToolState 字段。
 *
 * 调用方负责传入"已去重 / 已规范化"的 options：这里不做字段裁剪，
 * 整份对象原样写，避免遗漏新加的字段（比如以后加 cropRotation）。
 *
 * 返回新一份 nodes 用的 data patch（不直接改原对象，
 * Zustand 的 updateNodeData 会自己做浅合并）。
 */
export function buildCropToolStatePatch(options: ToolOptions): CropToolStatePatch {
  return { [CROP_TOOL_STATE_KEY]: { ...options } };
}

/**
 * 「批量套用」把参数分成两摞，合并规则就是这一行：
 *
 *  - **共享规则**（shared）：边框 / 描边 / 圆角 / 按比例补边（含留白）/ 文字图层 /
 *    自动裁剪规则（开关·识别色·参与边·保留边距）—— 当前这张图调好、要推给所有目标图的东西。
 *  - **各自独立**（existing）：每张图自己的目标比例、自定义比例、手动裁剪框 cropX/Y/W/H。
 *    自动裁剪的「结果」本来就不存在这里 —— 每张图打开面板 / 出图时按自己的像素现场重算，
 *    所以推了规则，边界仍旧「各自匹配」。
 *
 * 合并顺序 = **existing 打底、shared 覆盖**：shared 里没提到的键（裁剪框那几个）原样保留，
 * 于是目标图自己微调好的裁剪框不会被批量抹掉；shared 提到的键（外观规则）以当前图为准。
 */
export function mergeToolOptions(
  existing: ToolOptions | null | undefined,
  shared: ToolOptions
): ToolOptions {
  return { ...(existing ?? {}), ...shared };
}