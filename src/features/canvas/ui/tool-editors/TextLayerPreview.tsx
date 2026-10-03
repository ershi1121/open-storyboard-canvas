import type { CSSProperties } from 'react';

import { textAnchorTranslate, type TextLayerLayout } from '@/features/canvas/tools/text';

interface TextLayerPreviewProps {
  layout: TextLayerLayout;
  /** 预览尺寸 ÷ 输出尺寸。把 layout 的像素坐标缩到预览尺度。 */
  scale: number;
}

/**
 * 一个文字层的 DOM 预览。
 *
 * 刻意和 canvas 的 `drawTextLayer` 用同一套几何：
 *  - 横排：整段文字一个块，靠 `text-align` + transform 百分比对齐锚点；
 *  - 竖排：`row-reverse` 的列（第 0 列在最右，符合中文竖排），列内逐字一个 span，
 *    每个字占 `lineHeightPx` 高度 —— 和 canvas 逐字 fillText 的位置一一对应。
 *  - 描边用 `-webkit-text-stroke` + `paint-order`，可见宽度等于 canvas 的 strokeWidthPx。
 *
 * 裁剪面板用它把文字叠在「裁剪 + 边框」的合成结果上，
 * 和出图的 `drawTextLayer` 是同一套几何，所以预览就是成品。
 */
export function TextLayerPreview({ layout, scale }: TextLayerPreviewProps) {
  const fontSizePx = layout.fontSizePx * scale;
  const lineHeightPx = layout.lineHeightPx * scale;
  const strokeWidthPx = layout.strokeWidthPx * scale;

  const baseStyle: CSSProperties = {
    position: 'absolute',
    left: `${layout.anchorX * scale}px`,
    top: `${layout.anchorY * scale}px`,
    transform: `translate(${textAnchorTranslate(layout.align)}, -50%)`,
    fontFamily: layout.fontFamily,
    fontWeight: layout.bold ? 700 : 400,
    color: layout.color,
    WebkitTextStroke:
      strokeWidthPx > 0 ? `${strokeWidthPx * 2}px ${layout.strokeColor}` : undefined,
    paintOrder: 'stroke fill',
    pointerEvents: 'none',
  };

  if (layout.direction === 'vertical') {
    return (
      <div style={{ ...baseStyle, display: 'flex', flexDirection: 'row-reverse' }}>
        {layout.lines.map((column, columnIndex) => (
          <div
            key={columnIndex}
            style={{ display: 'flex', flexDirection: 'column', width: `${lineHeightPx}px` }}
          >
            {Array.from(column).map((char, charIndex) => (
              <span
                key={charIndex}
                style={{
                  width: `${lineHeightPx}px`,
                  height: `${lineHeightPx}px`,
                  lineHeight: `${lineHeightPx}px`,
                  fontSize: `${fontSizePx}px`,
                  textAlign: 'center',
                }}
              >
                {char}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        ...baseStyle,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        textAlign: layout.align,
        whiteSpace: 'pre',
      }}
    >
      {layout.lines.join('\n')}
    </div>
  );
}
