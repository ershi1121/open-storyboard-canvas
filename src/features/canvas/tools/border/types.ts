import type { ToolOptionPrimitive } from '../types';

/**
 * 裁剪面板里的「边框」是裁剪的收尾步骤，不是独立工具。
 * 所有选项都以 `border` 前缀存进 ToolOptions，跟着裁剪工具一起走，
 * 这样 NodeToolDialog 的 createInitialOptions / options 透传都不用改。
 *
 * 边框支持多层（每层一个颜色），层与层同心向外叠：第 0 层贴着图片，
 * 最后一层在最外面。没有「开关」——层列表为空就是没有边框，
 * 删掉所有层即可关闭。
 */

export const DEFAULT_BORDER_COLOR = '#FFFFFF';

/** 快捷色板 —— 覆盖最常用的纯色边框需求。 */
export const BORDER_COLOR_PRESETS = [
  '#FFFFFF',
  '#F5F5F5',
  '#000000',
  '#5F5E5A',
  '#E24B4A',
  '#EF9F27',
  '#FAC775',
  '#639922',
  '#1D9E75',
  '#378ADD',
  '#534AB7',
  '#D4537E',
] as const;

/** 「按比例补边」的目标比例。none = 不补边。 */
export const BORDER_RATIO_PRESETS: Array<{ label: string; value: string }> = [
  { label: '不补边', value: 'none' },
  { label: '1:1', value: '1:1' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '2:1', value: '2:1' },
  { label: '21:9', value: '21:9' },
  { label: '自定义', value: 'custom' },
];

/** 各滑杆上限（百分比，基准是图片短边）。 */
export const BORDER_LAYER_WIDTH_MAX_PERCENT = 50;
export const BORDER_STROKE_MAX_PERCENT = 20;
export const BORDER_RADIUS_MAX_PERCENT = 50;
/** 「补边留白」滑杆上限（占图片短边百分比）。0 = 不补边。 */
export const BORDER_PAD_MAX_PERCENT = 50;

/** 层数上限。再多也不是「边框」而是画框了，而且左栏会失控。 */
export const BORDER_MAX_LAYERS = 5;

/**
 * 「按比例补边」不再靠写死的常量决定次要方向补多少 —— 那既调不了、
 * 又会把画布撑得比「刚好达到目标比例」大得多（一张 1000×500 补成 1:1，
 * 硬编码的“平衡补边”能给出 1700×1700，用户只想要 1100×1100 却没法调）。
 *
 * 现在补边的量由面板上的「补边留白」滑杆（border.padPercent）直接决定：
 * 它给出**四边各自至少留出的背景宽度**（按图片短边百分比），0 = 不补边。
 * 具体几何见 `resolveBorderGeometry`。
 */

export interface BorderLayer {
  id: string;
  /** #RRGGBB */
  color: string;
  /** 这一层向外扩出的宽度，基准是图片短边 */
  widthPercent: number;
}

let layerSequence = 0;

/** 层 id 只用于 React key 与增删定位，不参与出图。 */
export function createBorderLayerId(): string {
  layerSequence += 1;
  return `border-layer-${layerSequence}`;
}

/**
 * 默认给一层「宽度 0」的白色边框。
 * 宽度 0 意味着打开裁剪面板时画面不会有任何变化，
 * 用户拖动滑杆才开始出现边框 —— 默认不动用户的图。
 */
export const DEFAULT_BORDER_LAYERS: BorderLayer[] = [
  { id: 'border-layer-0', color: DEFAULT_BORDER_COLOR, widthPercent: 0 },
];

export const DEFAULT_BORDER_OPTIONS: Record<string, ToolOptionPrimitive> = {
  borderLayers: JSON.stringify(DEFAULT_BORDER_LAYERS),
  borderStrokePercent: 0,
  borderRadiusPercent: 0,
  borderRatioMode: 'none',
  borderCustomRatio: '',
  borderPadPercent: 0,
};

export interface BorderOptions {
  /** 从内到外，第 0 层贴着图片 */
  layers: BorderLayer[];
  /** 沿图片边缘向内的描边，画布尺寸不变 */
  strokePercent: number;
  /** 图片与边框的圆角 */
  radiusPercent: number;
  /** 'none' | '1:1' | ... | 'custom' */
  ratioMode: string;
  /** ratioMode === 'custom' 时使用，支持 "3:2" 或 "1.5" */
  customRatio: string;
  /**
   * 「补边留白」滑杆值：四边各自至少留出的背景宽度，占图片短边百分比。
   * 0 = 不补边；配合 ratioMode 时，它保证次要方向也看得见一圈、四边平衡。
   */
  padPercent: number;
}

/** 一层已经算好像素的环。 */
export interface BorderRing {
  color: string;
  /** 环自身的厚度 */
  thicknessPx: number;
  /** 该环外沿相对图片外沿扩出的距离（含内侧所有层） */
  outerOffsetPx: number;
  /** 该环的圆角半径 —— 半径随外扩距离一起变大，保证同心 */
  radiusPx: number;
}

export interface BorderGeometry {
  imageWidth: number;
  imageHeight: number;
  /** 图片到画布左边/上边的距离（含所有边框层与按比例补边） */
  padX: number;
  padY: number;
  canvasWidth: number;
  canvasHeight: number;
  /** 从内到外 */
  rings: BorderRing[];
  /** 所有层厚度之和 */
  totalThicknessPx: number;
  /** 按比例补出来的那圈用最外层颜色，画布底色同理 */
  fillColor: string;
  /** 内侧描边颜色 —— 取最内层，贴着图片的那一圈 */
  strokeColor: string;
  /** 内侧描边宽度 */
  strokePx: number;
  /** 图片本身的圆角半径 */
  radiusPx: number;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value.trim());
}

function readNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function clampPercent(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(max, Math.max(0, value));
}

function normalizeColor(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return isValidHexColor(raw) ? raw.toUpperCase() : fallback;
}

function sanitizeBorderLayer(item: unknown): BorderLayer | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const raw = item as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : createBorderLayerId();

  return {
    id,
    color: normalizeColor(raw.color, DEFAULT_BORDER_COLOR),
    widthPercent: clampPercent(
      readNumber(raw.widthPercent, 0),
      BORDER_LAYER_WIDTH_MAX_PERCENT
    ),
  };
}

/**
 * 层列表以 JSON 字符串存在 ToolOptions 里 —— 和标注工具存 items 的做法一致
 * （ToolOptionPrimitive 只允许 string | number | boolean，放不下数组）。
 * 逐项 sanitize，坏数据直接丢掉而不是让整份配置失效。
 */
export function parseBorderLayers(value: unknown): BorderLayer[] {
  let source: unknown = value;

  if (typeof value === 'string') {
    if (!value.trim()) {
      return [];
    }
    try {
      source = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((item) => sanitizeBorderLayer(item))
    .filter((item): item is BorderLayer => item !== null)
    .slice(0, BORDER_MAX_LAYERS);
}

export function stringifyBorderLayers(layers: BorderLayer[]): string {
  return JSON.stringify(
    layers.map((layer) => ({
      id: layer.id,
      color: layer.color,
      widthPercent: layer.widthPercent,
    }))
  );
}

/** 从裁剪工具的 options 里读出边框配置，缺失或非法一律回落到默认值。 */
export function readBorderOptions(options: Record<string, unknown>): BorderOptions {
  const ratioMode = readString(options.borderRatioMode, 'none');

  return {
    layers: parseBorderLayers(options.borderLayers),
    strokePercent: clampPercent(
      readNumber(options.borderStrokePercent, 0),
      BORDER_STROKE_MAX_PERCENT
    ),
    radiusPercent: clampPercent(
      readNumber(options.borderRadiusPercent, 0),
      BORDER_RADIUS_MAX_PERCENT
    ),
    ratioMode: BORDER_RATIO_PRESETS.some((item) => item.value === ratioMode) ? ratioMode : 'none',
    customRatio: typeof options.borderCustomRatio === 'string' ? options.borderCustomRatio : '',
    padPercent: clampPercent(
      readNumber(options.borderPadPercent, 0),
      BORDER_PAD_MAX_PERCENT
    ),
  };
}

/** 把 BorderOptions 摊回 ToolOptions 的 key，写回 options 时用。 */
export function toBorderToolOptions(
  border: BorderOptions
): Record<string, ToolOptionPrimitive> {
  return {
    borderLayers: stringifyBorderLayers(border.layers),
    borderStrokePercent: border.strokePercent,
    borderRadiusPercent: border.radiusPercent,
    borderRatioMode: border.ratioMode,
    borderCustomRatio: border.customRatio,
    borderPadPercent: border.padPercent,
  };
}

/**
 * 解析目标比例。支持 "16:9" 和 "1.5" 两种写法；
 * 解析不出来（含 'none'）返回 null，表示不做按比例补边。
 */
export function parseBorderRatio(mode: string, customRatio: string): number | null {
  if (!mode || mode === 'none') {
    return null;
  }

  const raw = (mode === 'custom' ? customRatio : mode).trim();
  if (!raw) {
    return null;
  }

  if (raw.includes(':')) {
    const [rawWidth, rawHeight] = raw.split(':').map((item) => Number(item));
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
      return null;
    }
    return rawWidth / rawHeight;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

/**
 * 算出最终画布几何。
 *
 * 顺序很重要：先把各层同心外扩，再按比例补边。
 * 这样「按比例补边」的基准是加完边框之后的尺寸，
 * 保证最终比例精确等于目标比例，而不是「图片比例 + 边框」的近似值。
 *
 * 层厚度一律以图片短边为基准（和切割工具的 lineThickness 口径一致），
 * 所以同一个百分比在横图和竖图上看起来一样粗。
 */
export function resolveBorderGeometry(
  imageWidth: number,
  imageHeight: number,
  border: BorderOptions
): BorderGeometry {
  const safeWidth = Math.max(1, Math.round(imageWidth));
  const safeHeight = Math.max(1, Math.round(imageHeight));
  const shortSide = Math.max(1, Math.min(safeWidth, safeHeight));

  const strokePx = Math.max(
    0,
    Math.round((shortSide * clampPercent(border.strokePercent, BORDER_STROKE_MAX_PERCENT)) / 100)
  );
  const radiusPx = Math.min(
    Math.max(
      0,
      Math.round((shortSide * clampPercent(border.radiusPercent, BORDER_RADIUS_MAX_PERCENT)) / 100)
    ),
    Math.floor(Math.min(safeWidth, safeHeight) / 2)
  );

  const rings: BorderRing[] = [];
  let offset = 0;
  for (const layer of border.layers) {
    const thicknessPx = Math.max(
      0,
      Math.round((shortSide * clampPercent(layer.widthPercent, BORDER_LAYER_WIDTH_MAX_PERCENT)) / 100)
    );
    offset += thicknessPx;
    rings.push({
      color: layer.color,
      thicknessPx,
      outerOffsetPx: offset,
      // 半径跟着外扩距离一起长，各层才是同心圆角而不是各自为政。
      radiusPx: radiusPx + offset,
    });
  }

  const totalThicknessPx = offset;
  const baseWidth = safeWidth + totalThicknessPx * 2;
  const baseHeight = safeHeight + totalThicknessPx * 2;

  const targetRatio = parseBorderRatio(border.ratioMode, border.customRatio);
  // 「补边留白」滑杆：四边**各自**至少留出的背景宽度（按图片短边百分比）。0 = 不补边。
  const minPad = Math.max(
    0,
    Math.round((shortSide * clampPercent(border.padPercent, BORDER_PAD_MAX_PERCENT)) / 100)
  );

  // 先把四边补到 minPad（对称 → 对边相等、没有哪一边贴到画布边），
  // 再只在「不够目标比例」的那一轴继续补到刚好等于目标比例 —— 这样最终比例精确、
  // 而且另一边仍稳定保持 minPad 的一圈，四边看起来是平衡的，不会「一边一大条、一边贴边」。
  let extraX = minPad;
  let extraY = minPad;

  if (targetRatio !== null) {
    const paddedWidth = baseWidth + minPad * 2;
    const paddedHeight = baseHeight + minPad * 2;
    const paddedRatio = paddedWidth / paddedHeight;
    if (paddedRatio > targetRatio) {
      // 太宽 —— 往上下补；左右停在 minPad。
      extraX = minPad;
      extraY = minPad + Math.max(0, (paddedWidth / targetRatio - paddedHeight) / 2);
    } else if (paddedRatio < targetRatio) {
      // 太高 —— 往左右补；上下停在 minPad。
      extraY = minPad;
      extraX = minPad + Math.max(0, (paddedHeight * targetRatio - paddedWidth) / 2);
    }
  }

  const padX = totalThicknessPx + Math.round(extraX);
  const padY = totalThicknessPx + Math.round(extraY);

  const outermost = rings.length > 0 ? rings[rings.length - 1].color : DEFAULT_BORDER_COLOR;
  const innermost = rings.length > 0 ? rings[0].color : DEFAULT_BORDER_COLOR;

  return {
    imageWidth: safeWidth,
    imageHeight: safeHeight,
    padX,
    padY,
    canvasWidth: safeWidth + padX * 2,
    canvasHeight: safeHeight + padY * 2,
    rings,
    totalThicknessPx,
    fillColor: outermost,
    strokeColor: innermost,
    strokePx,
    radiusPx,
  };
}

/** 几何上完全没有变化时可以直接返回原图，省一次 canvas 编码。 */
export function isBorderNoop(geometry: BorderGeometry): boolean {
  return (
    geometry.padX === 0
    && geometry.padY === 0
    && geometry.strokePx === 0
    && geometry.radiusPx === 0
  );
}

/** 预览用的比例文案：能约成常用比例就显示比例，否则显示小数。 */
export function describeAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return '—';
  }

  let x = Math.round(width);
  let y = Math.round(height);
  const gcdOf = (a: number, b: number): number => {
    let left = Math.abs(a);
    let right = Math.abs(b);
    while (right !== 0) {
      const temp = right;
      right = left % right;
      left = temp;
    }
    return left || 1;
  };

  const divisor = gcdOf(x, y);
  x = Math.round(x / divisor);
  y = Math.round(y / divisor);

  if (x <= 40 && y <= 40) {
    return `${x}:${y}`;
  }

  return `${(width / height).toFixed(3)}:1`;
}
