import { hasAutoCropEdge, normalizeAutoCropEdges } from './types';

/**
 * 纯计算层：给一块 RGBA 像素，算出「上下左右各该向内裁掉多少」。
 *
 * 刻意不碰 DOM —— 这样算法可以在 node 环境里用构造出来的像素直接测，
 * 预览（CropToolEditor）和出图（toolProcessor）读的是同一份实现，
 * 两边不可能算出不同的结果。
 */

/**
 * 一条线上允许多大比例的像素「不是这个颜色」仍然算作背景线。
 *
 * 判据本身是**精确比色**（就是用户说的「识别到不同颜色的停止」），
 * 这条规则只是把它抬到「一整条线」的粒度：一条线上有零星脏点，
 * 整条线仍然算背景 —— 不然扫描会在第一个噪点上停住，用户会觉得「时灵时不灵」。
 *
 * 2% 只吃得下零星的噪点 / 灰尘，真正的内容元素远大于这个比例，
 * 所以「内容压在边上」的那一行不会被误判成背景。
 */
const LINE_MISMATCH_RATIO = 0.02;

/**
 * 兜底：任何方向最多裁到只剩 10%。
 *
 * 整张图恰好就是识别色时（纯白底 + 白色识别色），四边会一路扫到中间，
 * 结果是 0×0 的裁剪框 —— 图直接没了。留一条底线，最多裁成一小块，
 * 用户能立刻看出「颜色选错了」，而不是拿到一张空图。
 */
const MIN_KEEP_RATIO = 0.1;

/**
 * 比色时允许的通道误差（0–255）。**固定值，不给用户调。**
 *
 * 为什么不能是「严格相等」：实测（PNG 白底 + 识别色纯白 #FFFFFF）——
 *   背景 #FEFEFE（差 1 阶）→ 一个像素都不裁
 *   背景叠 ±2 噪声        → 一个像素都不裁
 * 真实图片的「白底」几乎不可能是逐位 255,255,255：JPEG 压缩、AI 生成图的
 * 细微纹理、截图缩放都会让它漂个几阶。严格相等 = 功能在真实图上直接失效。
 *
 * 12（≈4.7%）的取舍：
 *   ✅ 吸收压缩噪点（±10 以内）与「肉眼看着就是白」的 #F8F8F8 / #F5F5F5
 *   ✅ 任何**看得出来的**不同颜色（#F0F0F0 差 15、深色内容差几百）都会让扫描停下
 *   ❌ 代价：#F5F5F5 这种浅灰会被「白色」一起吃掉 —— 但它本来就该被当成白底裁掉
 *
 * ⚠️ 这条不是「容差旋钮」的复活：它不可调、不出现在 UI 上，
 * 判据仍然是用户那句「识别到不同颜色的停止」，只是把「不同」定义成
 * 「人眼看得出来不同」而不是「二进制不相等」。
 */
export const COLOR_MATCH_EPSILON = 12;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ColorTrimParams {
  /** #RRGGBB，要裁掉的那个颜色（精确匹配，没有容差） */
  color: string;
  /** 'tblr' 的子集 */
  edges: string;
}

export interface TrimInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EMPTY_TRIM_INSETS: TrimInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})$/;

export function hexToRgb(color: string): Rgb | null {
  const match = HEX_PATTERN.exec(typeof color === 'string' ? color.trim() : '');
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** 像素 → '#RRGGBB'。 */
export function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** 两个颜色在「最大通道差」意义下的距离（0–255）。解析不出来返回 null。 */
export function colorDistance(a: string, b: string): number | null {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  if (!left || !right) {
    return null;
  }

  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b)
  );
}

/**
 * 两个颜色算不算「同一个颜色」。
 *
 * 判据就是 `COLOR_MATCH_EPSILON`：差在人眼看不出来的范围内就算同一个。
 * UI 拿它来决定「要不要提示用户换个识别色」。
 */
export function isSameColor(a: string, b: string): boolean {
  const distance = colorDistance(a, b);
  return distance !== null && distance <= COLOR_MATCH_EPSILON;
}

/**
 * 单个像素是不是「就是这个颜色」。
 *
 * 逐通道比较，允许 `COLOR_MATCH_EPSILON` 的误差 —— 不是严格相等。
 * 严格相等在真实图片上会直接失效（见 `COLOR_MATCH_EPSILON` 的注释）。
 */
export function isBackgroundPixel(
  pixels: Uint8ClampedArray,
  offset: number,
  rgb: Rgb
): boolean {
  return (
    Math.abs(pixels[offset] - rgb.r) <= COLOR_MATCH_EPSILON
    && Math.abs(pixels[offset + 1] - rgb.g) <= COLOR_MATCH_EPSILON
    && Math.abs(pixels[offset + 2] - rgb.b) <= COLOR_MATCH_EPSILON
  );
}

/**
 * 一条线（整行或整列）是不是「整条都是这个颜色」。
 * `stride` 是相邻两个采样点的字节跨度：横扫 = 4，竖扫 = 一行字节数。
 */
function lineIsBackground(
  pixels: Uint8ClampedArray,
  length: number,
  stride: number,
  startOffset: number,
  rgb: Rgb
): boolean {
  const allowed = Math.floor(length * LINE_MISMATCH_RATIO);
  let mismatches = 0;

  for (let index = 0; index < length; index += 1) {
    if (!isBackgroundPixel(pixels, startOffset + index * stride, rgb)) {
      mismatches += 1;
      if (mismatches > allowed) {
        return false;
      }
    }
  }

  return true;
}

/** 把裁剪量夹回安全范围，保证不会把图裁没。 */
export function clampTrimInsets(
  insets: TrimInsets,
  width: number,
  height: number
): TrimInsets {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));

  let top = Math.max(0, Math.floor(insets.top));
  let right = Math.max(0, Math.floor(insets.right));
  let bottom = Math.max(0, Math.floor(insets.bottom));
  let left = Math.max(0, Math.floor(insets.left));

  const minKeepWidth = Math.max(1, Math.floor(safeWidth * MIN_KEEP_RATIO));
  const maxHorizontal = Math.max(0, safeWidth - minKeepWidth);
  const horizontal = left + right;
  if (horizontal > maxHorizontal && horizontal > 0) {
    const scale = maxHorizontal / horizontal;
    left = Math.floor(left * scale);
    right = Math.floor(right * scale);
  }

  const minKeepHeight = Math.max(1, Math.floor(safeHeight * MIN_KEEP_RATIO));
  const maxVertical = Math.max(0, safeHeight - minKeepHeight);
  const vertical = top + bottom;
  if (vertical > maxVertical && vertical > 0) {
    const scale = maxVertical / vertical;
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }

  return { top, right, bottom, left };
}

/**
 * 从四条边向内扫，算出各边要裁掉多少像素（检测分辨率空间）。
 *
 * 规则一句话：**整行 / 整列还是这个颜色就往里走，碰到不同颜色就停。**
 * 四边独立扫 —— 只开了上边就只裁上面。
 */
export function resolveColorTrimInsets(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  params: ColorTrimParams
): TrimInsets {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));

  if (safeWidth === 0 || safeHeight === 0 || pixels.length < safeWidth * safeHeight * 4) {
    return { ...EMPTY_TRIM_INSETS };
  }

  const rgb = hexToRgb(params.color);
  if (!rgb) {
    return { ...EMPTY_TRIM_INSETS };
  }

  const edges = normalizeAutoCropEdges(params.edges);
  const rowStride = safeWidth * 4;

  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;

  if (hasAutoCropEdge(edges, 't')) {
    while (
      top < safeHeight
      && lineIsBackground(pixels, safeWidth, 4, top * rowStride, rgb)
    ) {
      top += 1;
    }
  }

  if (hasAutoCropEdge(edges, 'b')) {
    while (
      bottom < safeHeight - top
      && lineIsBackground(pixels, safeWidth, 4, (safeHeight - 1 - bottom) * rowStride, rgb)
    ) {
      bottom += 1;
    }
  }

  if (hasAutoCropEdge(edges, 'l')) {
    while (
      left < safeWidth
      && lineIsBackground(pixels, safeHeight, rowStride, left * 4, rgb)
    ) {
      left += 1;
    }
  }

  if (hasAutoCropEdge(edges, 'r')) {
    while (
      right < safeWidth - left
      && lineIsBackground(pixels, safeHeight, rowStride, (safeWidth - 1 - right) * 4, rgb)
    ) {
      right += 1;
    }
  }

  return clampTrimInsets({ top, right, bottom, left }, safeWidth, safeHeight);
}

/**
 * 把「检测分辨率」算出来的裁剪量换算回原图像素空间。
 *
 * 检测跑在缩小图上（见 detect.ts）——1024 已经远超「找一条边」所需，
 * 而全尺寸 ImageData 动辄几十 MB。两个调用方用同一个上限，
 * 换算出来的数就是同一份，预览和出图不会打架。
 */
export function scaleTrimInsets(
  insets: TrimInsets,
  scaleX: number,
  scaleY: number
): TrimInsets {
  const sx = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
  const sy = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;

  return {
    top: Math.max(0, Math.round(insets.top * sy)),
    right: Math.max(0, Math.round(insets.right * sx)),
    bottom: Math.max(0, Math.round(insets.bottom * sy)),
    left: Math.max(0, Math.round(insets.left * sx)),
  };
}

/**
 * 裁剪量 → 内容矩形（原图像素空间）。
 *
 * `paddingPx` 是「保留边距」：从裁剪量里往回减，等于给内容留一圈背景，
 * 避免主体贴边太紧（自动裁出来的图经常紧到看着别扭）。
 */
export function resolveAutoCropContentRect(
  insets: TrimInsets,
  imageWidth: number,
  imageHeight: number,
  paddingPx = 0
): CropRect {
  const width = Math.max(1, Math.round(imageWidth));
  const height = Math.max(1, Math.round(imageHeight));
  // pad 可为负：负值 = 往内容里多切一点（去掉自动裁剪后残留的细边）。
  const pad = Math.round(paddingPx);

  const left = Math.max(0, Math.round(insets.left) - pad);
  const top = Math.max(0, Math.round(insets.top) - pad);
  const right = Math.max(0, Math.round(insets.right) - pad);
  const bottom = Math.max(0, Math.round(insets.bottom) - pad);

  const x = Math.max(0, Math.min(left, width - 1));
  const y = Math.max(0, Math.min(top, height - 1));

  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, width - left - right)),
    height: Math.max(1, Math.min(height - y, height - top - bottom)),
  };
}

/**
 * 内容矩形 → 「四边实际裁掉了多少」。
 *
 * 和 `resolveAutoCropContentRect` 是逆运算，用途只有一个：面板上那行读数。
 * ⚠️ 必须用它而不是直接用 `insets`：开了「保留边距」之后 insets 是**识别**量，
 * 实际裁掉的要少一圈。两行数字不自洽，用户会以为工具算错了。
 */
export function resolveRemovedInsets(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number
): TrimInsets {
  const width = Math.max(1, Math.round(imageWidth));
  const height = Math.max(1, Math.round(imageHeight));
  const left = Math.max(0, Math.round(rect.x));
  const top = Math.max(0, Math.round(rect.y));
  const rectWidth = Math.max(1, Math.round(rect.width));
  const rectHeight = Math.max(1, Math.round(rect.height));

  return {
    top,
    left,
    right: Math.max(0, width - left - rectWidth),
    bottom: Math.max(0, height - top - rectHeight),
  };
}

/** 两个矩形求交；没有重叠（宽或高 ≤ 0）返回 null。 */
export function intersectCropRect(a: CropRect, b: CropRect): CropRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  const width = Math.round(right - left);
  const height = Math.round(bottom - top);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x: Math.round(left), y: Math.round(top), width, height };
}

/**
 * 有效裁剪框 = 手动裁剪框 ∩ 内容边界。
 *
 * 这是「PS 层级」的落点：自动裁剪只负责把底图边界收进去，
 * 用户手动拉的框如果本来就落在内容里，就完全不受影响；
 * 如果拉到了内容外面，多出来的那部分被内容边界截掉。
 *
 * 两边都缺一方时退回另一方；完全不重叠时退回手动框 ——
 * 宁可「没生效」也不要产出 0 尺寸的裁剪，那会让用户直接丢图。
 */
export function resolveEffectiveCropRect(
  manual: CropRect | null,
  content: CropRect | null
): CropRect | null {
  if (!manual) {
    return content;
  }
  if (!content) {
    return manual;
  }
  return intersectCropRect(manual, content) ?? manual;
}

/** 从裁剪工具的 options 里读出手动裁剪框；字段缺失或非法返回 null。 */
export function readCropRect(options: Record<string, unknown>): CropRect | null {
  const x = Number(options.cropX);
  const y = Number(options.cropY);
  const width = Number(options.cropWidth);
  const height = Number(options.cropHeight);

  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

export function isTrimInsetsEmpty(insets: TrimInsets): boolean {
  return insets.top === 0 && insets.right === 0 && insets.bottom === 0 && insets.left === 0;
}
