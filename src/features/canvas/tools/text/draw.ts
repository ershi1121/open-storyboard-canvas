import {
  TEXT_LAYERS_KEY,
  readTextLayerOptions,
  readTextLayers,
  resolveTextContent,
  type TextAlign,
  type TextDirection,
  type TextLayer,
} from './types';

/**
 * 单个文字层的排布结果。预览（DOM）和出图（canvas）共用这一份计算，
 * 保证「看到的就是导出的」。
 */
export interface TextLayerLayout {
  layerId: string;
  direction: TextDirection;
  /** 横排：每行一个字符串；竖排：每列一个字符串（渲染时逐字拆开）。 */
  lines: string[];
  fontSizePx: number;
  /** 行距（横排）/ 字距与列距（竖排） */
  lineHeightPx: number;
  /** 锚点坐标（输出画幅的像素空间） */
  anchorX: number;
  anchorY: number;
  align: TextAlign;
  /** 可见描边宽度；0 = 不描边 */
  strokeWidthPx: number;
  bold: boolean;
  fontFamily: string;
  color: string;
  strokeColor: string;
  /**
   * 竖排：块宽 = 列数 × lineHeightPx（可精确算出，DOM 用 transform 百分比对齐）。
   * 横排：0 —— 宽度取决于字体渲染，交给 canvas 的 textAlign / CSS 的 text-align 处理。
   */
  blockWidth: number;
  /** 竖排：最长列的字数 × lineHeightPx；横排：行数 × lineHeightPx。 */
  blockHeight: number;
}

/** 字号下限（px）—— 超小图也不至于算出 0 号字被浏览器吞掉。 */
const TEXT_MIN_FONT_SIZE_PX = 6;

/** 拼 canvas / CSS 通用的 font 简写。 */
export function buildTextFont(
  layout: Pick<TextLayerLayout, 'bold' | 'fontSizePx' | 'fontFamily'>
): string {
  return `${layout.bold ? '700' : '400'} ${layout.fontSizePx}px ${layout.fontFamily}`;
}

/** 锚点相对文字块的水平位移（CSS transform / canvas textAlign 共用同一套语义）。 */
export function textAnchorTranslate(align: TextAlign): string {
  if (align === 'left') {
    return '0';
  }
  return align === 'right' ? '-100%' : '-50%';
}

/**
 * 算出一个文字层怎么摆。返回 null 表示「这一层不用画」
 * （隐藏 / 文字为空 / 画布尺寸非法）。
 *
 * @param index 该图在画布图片节点顺序中的 0-based 下标，用来决定 {n} 的值。
 */
export function resolveTextLayerLayout(
  imageWidth: number,
  imageHeight: number,
  layerInput: TextLayer | Record<string, unknown>,
  index: number
): TextLayerLayout | null {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) {
    return null;
  }
  if (imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const layer = readTextLayerOptions(layerInput);
  if (!layer.visible) {
    return null;
  }

  const content = resolveTextContent(layer, index);
  if (!content.trim()) {
    return null;
  }

  // 字号以短边为基准：横图竖图同一个百分比，视觉占比一致。
  const shortSide = Math.min(imageWidth, imageHeight);
  const fontSizePx = Math.max(
    TEXT_MIN_FONT_SIZE_PX,
    Math.round((shortSide * layer.fontSizePercent) / 100)
  );
  const lineHeightPx = Math.max(1, Math.round((fontSizePx * layer.lineHeightPercent) / 100));
  const strokeWidthPx = Math.max(0, (fontSizePx * layer.strokePercent) / 100);

  const lines = content.split('\n');
  const isVertical = layer.direction === 'vertical';

  return {
    layerId: layer.id,
    direction: layer.direction,
    lines,
    fontSizePx,
    lineHeightPx,
    anchorX: (imageWidth * layer.xPercent) / 100,
    anchorY: (imageHeight * layer.yPercent) / 100,
    align: layer.align,
    strokeWidthPx,
    bold: layer.bold,
    fontFamily: layer.fontFamily,
    color: layer.color,
    strokeColor: layer.strokeColor,
    blockWidth: isVertical ? lines.length * lineHeightPx : 0,
    blockHeight: isVertical
      ? Math.max(...lines.map((line) => Array.from(line).length)) * lineHeightPx
      : lines.length * lineHeightPx,
  };
}

/** 一次算出所有图层的排布（跳过不画的层）。 */
export function resolveTextLayersLayout(
  imageWidth: number,
  imageHeight: number,
  layers: TextLayer[],
  index: number
): TextLayerLayout[] {
  const layouts: TextLayerLayout[] = [];
  for (const layer of layers) {
    const layout = resolveTextLayerLayout(imageWidth, imageHeight, layer, index);
    if (layout) {
      layouts.push(layout);
    }
  }
  return layouts;
}

/**
 * 把一个文字层画到 canvas 上。
 *
 * 先描边后填充：描边是居中描边的，线宽取两倍再被填充盖掉内半圈，
 * 于是「可见描边宽度」正好等于 strokeWidthPx —— 和预览里
 * `-webkit-text-stroke: 2×strokeWidthPx` 的效果对齐。
 */
export function drawTextLayer(
  context: CanvasRenderingContext2D,
  layout: TextLayerLayout
): void {
  if (layout.lines.length === 0) {
    return;
  }

  context.save();
  context.font = buildTextFont(layout);
  context.textBaseline = 'middle';

  const hasStroke = layout.strokeWidthPx > 0;
  if (hasStroke) {
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.lineWidth = layout.strokeWidthPx * 2;
    context.strokeStyle = layout.strokeColor;
  }
  context.fillStyle = layout.color;

  const paint = (text: string, x: number, y: number) => {
    if (hasStroke) {
      context.strokeText(text, x, y);
    }
    context.fillText(text, x, y);
  };

  if (layout.direction === 'vertical') {
    // 竖排：逐字往下画，列从右往左排。
    context.textAlign = 'center';
    const blockWidth = layout.blockWidth;
    const left =
      layout.align === 'left'
        ? layout.anchorX
        : layout.align === 'center'
          ? layout.anchorX - blockWidth / 2
          : layout.anchorX - blockWidth;

    layout.lines.forEach((column, columnIndex) => {
      const columnCenterX =
        left + blockWidth - layout.lineHeightPx / 2 - columnIndex * layout.lineHeightPx;
      const chars = Array.from(column);
      const firstY = layout.anchorY - (chars.length * layout.lineHeightPx) / 2 + layout.lineHeightPx / 2;

      chars.forEach((char, charIndex) => {
        paint(char, columnCenterX, firstY + charIndex * layout.lineHeightPx);
      });
    });
  } else {
    context.textAlign = layout.align;
    const totalHeight = layout.lines.length * layout.lineHeightPx;
    const firstY = layout.anchorY - totalHeight / 2 + layout.lineHeightPx / 2;

    layout.lines.forEach((line, lineIndex) => {
      paint(line, layout.anchorX, firstY + lineIndex * layout.lineHeightPx);
    });
  }

  context.restore();
}

/**
 * 便捷入口：直接在已铺好底图的 context 上按 options 里的所有图层画一遍。
 * 返回是否真的画了东西（没画的话调用方可以跳过重编码）。
 */
export function drawTextLayersFromOptions(
  context: CanvasRenderingContext2D,
  imageWidth: number,
  imageHeight: number,
  options: Record<string, unknown> | null | undefined,
  index: number
): boolean {
  const layers = readTextLayers((options ?? {})[TEXT_LAYERS_KEY]);
  if (layers.length === 0) {
    return false;
  }

  let drew = false;
  for (const layer of layers) {
    const layout = resolveTextLayerLayout(imageWidth, imageHeight, layer, index);
    if (!layout) {
      continue;
    }
    drawTextLayer(context, layout);
    drew = true;
  }
  return drew;
}
