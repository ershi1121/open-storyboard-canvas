import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ToolOptions } from '../types';

/**
 * 文字参数在 options / node.data 上的字段名。
 *
 * 存的是 TextLayer[] 的 JSON 字符串（ToolOptions 只允许 primitive，数组得序列化 ——
 * 和 annotation 的 `annotations` 字段同一套路）。
 *
 * ⭐ 这是文字参数的**唯一**存档：裁剪面板里的「文字」区块读写它，
 * NodeToolDialog 的写回 effect 也只写它。cropToolState 里那份副本会被
 * createInitialOptions 主动盖掉（见 builtInTools.ts），别指望它。
 */
export const TEXT_LAYERS_KEY = 'textLayers';

/** 文字内容里的序号占位符。写在哪儿序号就出现在哪儿。 */
export const TEXT_NUMBER_TOKEN = '{n}';

/** 文字层数上限 —— 够用，也防止有人手抖加出 50 层把图糊掉。 */
export const TEXT_MAX_LAYERS = 8;

export type TextAlign = 'left' | 'center' | 'right';

/**
 * 排列方向。
 *  - horizontal：正常横排，`\n` 分行；
 *  - vertical：竖排，`\n` 分列（列从右往左，符合中文竖排习惯），列内逐字向下。
 */
export type TextDirection = 'horizontal' | 'vertical';

export interface TextLayer {
  id: string;
  /** 文字模板。含 {n} 时按占位符替换；否则 autoNumber 开启时把序号接在末尾。 */
  text: string;
  /** 自动编号：把该图在画布中的顺序号接进文字里。 */
  autoNumber: boolean;
  /** 编号起始值（默认 1，即「图像1」是画布第一张）。 */
  numberStart: number;
  /** 锚点横坐标，相对输出画幅宽度的百分比。 */
  xPercent: number;
  /** 锚点纵坐标，相对输出画幅高度的百分比。 */
  yPercent: number;
  /** 字号，相对输出画幅短边的百分比 —— 不同尺寸的图文字占比一致。 */
  fontSizePercent: number;
  /** 字体族（CSS font-family 写法，canvas 与预览共用同一串）。 */
  fontFamily: string;
  bold: boolean;
  color: string;
  /** 描边宽度，相对字号的百分比。0 = 不描边。 */
  strokePercent: number;
  strokeColor: string;
  /** 锚点相对文字块的对齐方式。 */
  align: TextAlign;
  /** 横排 / 竖排。 */
  direction: TextDirection;
  /**
   * 行距（横排）/ 字距与列距（竖排），相对字号的百分比。
   * 一个字段两用：横排调的是「行」之间的距离，竖排调的是「字」之间的距离。
   */
  lineHeightPercent: number;
  /** 关掉就只留参数、不出图，方便对照调试。 */
  visible: boolean;
}

let textLayerSequence = 0;

export function createTextLayerId(): string {
  textLayerSequence += 1;
  return `text-layer-${textLayerSequence}`;
}

export const DEFAULT_TEXT_LAYER: TextLayer = {
  id: 'text-layer-default',
  text: '图像',
  autoNumber: true,
  numberStart: 1,
  // 默认落在下方居中偏内 —— 漫画页编号最常见的落点。
  xPercent: 50,
  yPercent: 92,
  fontSizePercent: 5,
  fontFamily: 'sans-serif',
  bold: true,
  color: '#FFFFFF',
  strokePercent: 14,
  strokeColor: '#000000',
  align: 'center',
  direction: 'horizontal',
  lineHeightPercent: 125,
  visible: true,
};

export function createTextLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return {
    ...DEFAULT_TEXT_LAYER,
    id: createTextLayerId(),
    ...patch,
  };
}

export interface TextFontPreset {
  value: string;
  label: string;
}

/**
 * 字体预设。value 直接写进 canvas 的 `font` 和预览的 `fontFamily`，
 * 所以两处渲染结果一致；后面的后备字体保证缺字时不至于掉成方块。
 */
export const TEXT_FONT_PRESETS: TextFontPreset[] = [
  { value: 'sans-serif', label: '系统默认' },
  { value: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif', label: '微软雅黑' },
  { value: '"SimHei", "Heiti SC", "Noto Sans SC", sans-serif', label: '黑体' },
  { value: '"Microsoft JhengHei", "PingFang TC", sans-serif', label: '微软正黑' },
  { value: '"SimSun", "Songti SC", "Noto Serif SC", serif', label: '宋体' },
  { value: '"KaiTi", "Kaiti SC", "STKaiti", serif', label: '楷体' },
  { value: '"FangSong", "STFangsong", serif', label: '仿宋' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: '"Times New Roman", Times, serif', label: 'Times' },
  { value: 'Georgia, "Noto Serif SC", serif', label: 'Georgia' },
  { value: '"Courier New", Courier, monospace', label: 'Courier' },
  { value: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif', label: 'Impact' },
  { value: '"Comic Sans MS", "Segoe Print", cursive', label: 'Comic Sans' },
];

/** 常用色：黑白 + 高对比彩色，够覆盖漫画编号 / 水印的常见需求。 */
export const TEXT_COLOR_PRESETS = [
  '#FFFFFF',
  '#000000',
  '#FFD400',
  '#FF4D4F',
  '#22C55E',
  '#3B82F6',
  '#F97316',
  '#E5E7EB',
];

export const TEXT_ALIGN_PRESETS: Array<{ value: TextAlign; label: string }> = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
];

export const TEXT_DIRECTION_PRESETS: Array<{ value: TextDirection; label: string }> = [
  { value: 'horizontal', label: '横排' },
  { value: 'vertical', label: '竖排' },
];

/** 位置微调步进（百分比）。拖拽给粗调，箭头按钮给 0.1% 的精调。 */
export const TEXT_POSITION_NUDGE_STEP = 0.1;
export const TEXT_FONT_SIZE_MIN = 1;
export const TEXT_FONT_SIZE_MAX = 60;
export const TEXT_STROKE_MAX = 40;
export const TEXT_LINE_HEIGHT_MIN = 80;
export const TEXT_LINE_HEIGHT_MAX = 300;

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toStringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toAlign(value: unknown): TextAlign {
  return value === 'left' || value === 'right' || value === 'center'
    ? value
    : DEFAULT_TEXT_LAYER.align;
}

function toDirection(value: unknown): TextDirection {
  return value === 'vertical' || value === 'horizontal'
    ? value
    : DEFAULT_TEXT_LAYER.direction;
}

/** 6 位十六进制色（含 #），非法值回落到 fallback。 */
export function normalizeTextColor(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return fallback;
}

/**
 * 把任意来源的一份图层数据规范化成完整 TextLayer。
 *
 * 所有字段都过一遍兜底：从节点存档恢复时可能缺字段、也可能混进旧版本的脏值
 * （比如单图层时代存下的 `text` / `xPercent` 直接摊在 options 上），不能直接信。
 */
export function readTextLayerOptions(raw: unknown): TextLayer {
  const source = (raw ?? {}) as Record<string, unknown>;

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : createTextLayerId(),
    text: typeof source.text === 'string' ? source.text : DEFAULT_TEXT_LAYER.text,
    autoNumber: toBoolean(source.autoNumber, DEFAULT_TEXT_LAYER.autoNumber),
    numberStart: clamp(
      Math.round(toFiniteNumber(source.numberStart, DEFAULT_TEXT_LAYER.numberStart)),
      -9999,
      9999
    ),
    xPercent: clamp(toFiniteNumber(source.xPercent, DEFAULT_TEXT_LAYER.xPercent), -100, 200),
    yPercent: clamp(toFiniteNumber(source.yPercent, DEFAULT_TEXT_LAYER.yPercent), -100, 200),
    fontSizePercent: clamp(
      toFiniteNumber(source.fontSizePercent, DEFAULT_TEXT_LAYER.fontSizePercent),
      TEXT_FONT_SIZE_MIN,
      TEXT_FONT_SIZE_MAX
    ),
    fontFamily: toStringValue(source.fontFamily, DEFAULT_TEXT_LAYER.fontFamily),
    bold: toBoolean(source.bold, DEFAULT_TEXT_LAYER.bold),
    color: normalizeTextColor(source.color, DEFAULT_TEXT_LAYER.color),
    strokePercent: clamp(
      toFiniteNumber(source.strokePercent, DEFAULT_TEXT_LAYER.strokePercent),
      0,
      TEXT_STROKE_MAX
    ),
    strokeColor: normalizeTextColor(source.strokeColor, DEFAULT_TEXT_LAYER.strokeColor),
    align: toAlign(source.align),
    direction: toDirection(source.direction),
    lineHeightPercent: clamp(
      toFiniteNumber(source.lineHeightPercent, DEFAULT_TEXT_LAYER.lineHeightPercent),
      TEXT_LINE_HEIGHT_MIN,
      TEXT_LINE_HEIGHT_MAX
    ),
    visible: toBoolean(source.visible, DEFAULT_TEXT_LAYER.visible),
  };
}

/**
 * 从 options / node.data 上的 `textLayers` 字段读出图层数组。
 *
 * 接受三种形态（宽容读取，别让旧数据炸掉）：
 *  - JSON 字符串（正常路径）；
 *  - 已经是数组（内存里直接传）；
 *  - 其它 → 空数组（等于没有文字）。
 *
 * 空数组 ≠ 默认一层：裁剪面板打开时不该凭空多出文字 —— 没配过就是没有。
 */
export function readTextLayers(raw: unknown): TextLayer[] {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.slice(0, TEXT_MAX_LAYERS).map((item) => readTextLayerOptions(item));
}

/** 反向：把图层数组压成 JSON 字符串，写回 options / node.data。 */
export function stringifyTextLayers(layers: TextLayer[]): string {
  return JSON.stringify(layers);
}

/**
 * 该图对应的编号。index 是它在**画布图片节点顺序**中的 0-based 下标 ——
 * 不是「顶部条里第几个」。当前图会被提到条首显示，但它的编号仍然是它在画布里的
 * 真实位置，这样切换当前图不会让其它图的编号整体错位。
 */
export function resolveTextNumber(layer: Pick<TextLayer, 'numberStart'>, index: number): number {
  const start = Number.isFinite(layer.numberStart) ? Math.round(layer.numberStart) : 1;
  return start + Math.max(0, Math.floor(index));
}

/**
 * 解析出真正要画的文字。
 *  - 模板里有 {n}：只替换占位符，序号出现在用户指定的位置（如「第{n}页」）。
 *  - 模板里没有 {n} 且开了自动编号：序号接在末尾（用户只写「图像」就能得到「图像1」）。
 *  - 关掉自动编号：原样输出（所有图同一段文字）。
 */
export function resolveTextContent(layer: TextLayer, index: number): string {
  const template = layer.text ?? '';
  const number = resolveTextNumber(layer, index);

  if (template.includes(TEXT_NUMBER_TOKEN)) {
    return template.split(TEXT_NUMBER_TOKEN).join(String(number));
  }
  // 模板为空时不追加编号 —— 否则用户清空输入框会得到孤零零一个「1」，
  // 想只要数字的人写 {n} 就行。
  if (layer.autoNumber && template.trim()) {
    return `${template}${number}`;
  }
  return template;
}

/** 从节点 data 读出该图的文字图层（裁剪面板的 createInitialOptions 走这里）。 */
export function readTextLayersFromNode(node: CanvasNode | null | undefined): TextLayer[] {
  if (!node) {
    return [];
  }
  return readTextLayers((node.data as Record<string, unknown>)[TEXT_LAYERS_KEY]);
}

/** 写出节点 data patch（Zustand updateNodeData 会做浅合并）。 */
export function buildTextLayersPatch(layers: TextLayer[]): Record<string, unknown> {
  return { [TEXT_LAYERS_KEY]: stringifyTextLayers(layers) };
}

/**
 * 把 options 里的图层数组写成 ToolOptions 补丁。
 * 调用方负责 `{ ...options, ...patch }` 合并。
 */
export function toTextLayersToolOptions(layers: TextLayer[]): ToolOptions {
  return { [TEXT_LAYERS_KEY]: stringifyTextLayers(layers) };
}
