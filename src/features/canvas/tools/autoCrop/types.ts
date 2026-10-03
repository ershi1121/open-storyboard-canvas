import { isValidHexColor } from '../border/types';
import type { ToolOptionPrimitive } from '../types';

/**
 * 「自动裁剪」= 按颜色去边。
 *
 * 用户指定一个「背景色」（默认白），工具从**原图**的四条边向内逐行扫，
 * 把整行/整列都是该颜色的部分裁掉，剩下的就是内容边界。
 *
 * ⚠️ 它在整条裁剪链路里排在**最底层**：
 *
 *     自动裁剪（只动底图边界）
 *       → 手动裁剪框（在内容边界内微调）
 *         → 边框 / 描边 / 圆角 / 按比例补边
 *           → 文字
 *
 * 这就是用户说的「像 PS 一样的层级」：自动裁剪作用在底图上，
 * 边框是后来才叠上去的，所以**边框永远不会被自动裁剪吃掉**。
 * 有效裁剪框 = 手动裁剪框 ∩ 内容边界，而不是「先裁边框再裁内容」。
 *
 * 所有选项都以 `autoCrop` 前缀存进 ToolOptions，跟裁剪工具一起走 ——
 * 和 border / text 两套参数同样的做法，NodeToolDialog 的透传不用改。
 */

export const DEFAULT_AUTO_CROP_COLOR = '#FFFFFF';

/**
 * 快捷色板：白 / 黑 / 两级灰，外加绿幕、蓝幕。
 * 漫画分镜最常见的「去边」需求就是白底、黑底，以及抠像用的纯色幕。
 */
export const AUTO_CROP_COLOR_PRESETS = [
  '#FFFFFF',
  '#000000',
  '#F5F5F5',
  '#E0E0E0',
  '#8A8A8A',
  '#00B140',
  '#0047BB',
] as const;

/** 保留边距上限（占图片短边百分比）。 */
export const AUTO_CROP_PADDING_MAX_PERCENT = 20;
export const AUTO_CROP_PADDING_DEFAULT = 0;

export type AutoCropEdge = 't' | 'r' | 'b' | 'l';

/** 四边开关的展示顺序：上 → 下 → 左 → 右（面板上按这个顺序排）。 */
export const AUTO_CROP_EDGE_ITEMS: Array<{ key: AutoCropEdge; label: string }> = [
  { key: 't', label: '上' },
  { key: 'b', label: '下' },
  { key: 'l', label: '左' },
  { key: 'r', label: '右' },
];

/** 规范顺序，用来把边集合存成稳定的字符串（'tblr' 而不是随点击顺序漂移）。 */
const EDGE_ORDER = 'tblr';

/**
 * 把任意输入规范成边集合字符串。
 * 认不出来的字符直接丢掉 —— 默认值给的是全选 'tblr'，
 * 传进来的坏数据最多让某几边不生效，不会让整份配置失效。
 */
export function normalizeAutoCropEdges(value: unknown): string {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  return EDGE_ORDER.split('')
    .filter((edge) => raw.includes(edge))
    .join('');
}

export function hasAutoCropEdge(edges: string, edge: AutoCropEdge): boolean {
  return normalizeAutoCropEdges(edges).includes(edge);
}

export function toggleAutoCropEdge(edges: string, edge: AutoCropEdge): string {
  const current = normalizeAutoCropEdges(edges);
  const next = current.includes(edge)
    ? current.split('').filter((item) => item !== edge)
    : [...current.split(''), edge];
  return EDGE_ORDER.split('')
    .filter((item) => next.includes(item))
    .join('');
}

export interface AutoCropOptions {
  /** 关掉就完全不参与计算（有效裁剪框 = 手动裁剪框） */
  enabled: boolean;
  /** #RRGGBB，要裁掉的背景色 */
  color: string;
  /** 'tblr' 的子集，控制哪几边参与扫描 */
  edges: string;
  /** 0–20，往回留一点背景，避免内容贴边太紧 */
  paddingPercent: number;
}

/**
 * ⚠️ 这里曾经有个 `autoCropTolerance`（颜色容差滑杆）。
 *
 * 用户的反馈：「识别到不同颜色的停止就可以了呀」——
 * 判据就是「是不是这个颜色」，一个「差多少还算这个颜色」的滑杆既没人想调，
 * 也把一件本来一句话能说清的事变成了需要试参数的事。
 * 已连同 UI 一起删掉，比色改成**精确匹配**。
 *
 * 代价（写在这里，免得以后当 bug 查）：JPEG 这类有损压缩的白底，
 * 像素值会漂到 (253,252,254) 这种，严格匹配纯白会一个像素都不裁。
 * 真遇到再给一个**固定的小 epsilon**（不加滑杆），而不是把旋钮还回去。
 */
export const DEFAULT_AUTO_CROP_OPTIONS: Record<string, ToolOptionPrimitive> = {
  autoCropEnabled: false,
  autoCropColor: DEFAULT_AUTO_CROP_COLOR,
  autoCropEdges: EDGE_ORDER,
  autoCropPaddingPercent: AUTO_CROP_PADDING_DEFAULT,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function normalizeColor(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return isValidHexColor(raw) ? raw.toUpperCase() : fallback;
}

/** 从裁剪工具的 options 里读出自动裁剪配置，缺失或非法一律回落到默认值。 */
export function readAutoCropOptions(options: Record<string, unknown>): AutoCropOptions {
  return {
    // 严格 === true：存档里可能躺着 undefined / 字符串，一律当「没开」，
    // 免得升级后用户的图莫名其妙被裁掉一块。
    enabled: options.autoCropEnabled === true,
    color: normalizeColor(options.autoCropColor, DEFAULT_AUTO_CROP_COLOR),
    edges: normalizeAutoCropEdges(options.autoCropEdges) || EDGE_ORDER,
    paddingPercent: clampNumber(
      options.autoCropPaddingPercent,
      0,
      AUTO_CROP_PADDING_MAX_PERCENT,
      AUTO_CROP_PADDING_DEFAULT
    ),
  };
}

/** 把 AutoCropOptions 摊回 ToolOptions 的 key，写回 options 时用。 */
export function toAutoCropToolOptions(
  autoCrop: AutoCropOptions
): Record<string, ToolOptionPrimitive> {
  return {
    autoCropEnabled: autoCrop.enabled,
    autoCropColor: autoCrop.color,
    autoCropEdges: normalizeAutoCropEdges(autoCrop.edges),
    autoCropPaddingPercent: autoCrop.paddingPercent,
  };
}
