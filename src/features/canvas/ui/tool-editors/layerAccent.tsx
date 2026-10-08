/**
 * 图层「身份色」——给边框层 / 文字层的每一层按序号分配一个稳定的强调色，
 * 用来一眼分清「这是第几层」。⚠️ 它和每层自己的**内容色**（边框颜色 / 文字颜色）
 * 完全无关、各显各的：内容色块照常显示，身份色只出现在序号圆牌、左侧竖条和
 * 展开区顶部的重复标记上。
 *
 * 配色：多彩柔和（400 级、暗色面板上够亮又不刺眼），序号循环取色。
 */
const LAYER_ACCENT_PALETTE = [
  '#60a5fa', // 1 蓝
  '#4ade80', // 2 绿
  '#fbbf24', // 3 琥珀
  '#c084fc', // 4 紫
  '#22d3ee', // 5 青
  '#f472b6', // 6 玫红
];

/** 按 0-based 序号取身份色（循环）。 */
export function getLayerAccentColor(index: number): string {
  const n = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return LAYER_ACCENT_PALETTE[n % LAYER_ACCENT_PALETTE.length];
}

/**
 * 颜色色块的通用描边：中性灰边 + 一圈很淡的内阴影。
 * ⚠️ 关键：暗色主题下白色色块本来就看得见，但浅色主题下面板翻白、白色色块会「隐身」——
 * 中性灰边在两种主题下都能给浅色/白色一块清楚边界。所有「代表某个颜色」的小方块都用它。
 */
export const COLOR_CHIP_CLASS =
  'rounded border border-[rgba(128,128,128,0.7)] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]';

/**
 * 给定 #RRGGBB，返回压在其上仍清晰的文字色（亮色→深字，暗色→白字）。
 * 图层整块背景用自身颜色时，标题文字/图标靠它保证可读。
 */
export function readableTextColor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return '#0b1220';
  }
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0b1220' : '#ffffff';
}
