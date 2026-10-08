import { describe, expect, it } from 'vitest';

import {
  buildTextFont,
  drawTextLayer,
  drawTextLayersFromOptions,
  resolveTextLayerLayout,
  resolveTextLayersLayout,
  textAnchorTranslate,
} from './draw';
import {
  DEFAULT_TEXT_LAYER,
  TEXT_LAYERS_KEY,
  stringifyTextLayers,
  type TextLayer,
} from './types';

interface RecordedCall {
  name: 'save' | 'restore' | 'fillText' | 'strokeText';
  text?: string;
  x?: number;
  y?: number;
  fillStyle?: string;
  strokeStyle?: string;
  lineWidth?: number;
  font?: string;
  textAlign?: string;
  textBaseline?: string;
  lineJoin?: string;
}

/**
 * 只记录调用序列的假 canvas context。
 * 目的是锁住「先描边后填充」「多行按 lineHeight 递进」「竖排逐字 + 列从右往左」
 * 这几件事 —— 它们直接决定预览和导出是不是同一张脸。
 */
function createMockContext() {
  const calls: RecordedCall[] = [];

  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    save: () => {
      calls.push({ name: 'save' });
    },
    restore: () => {
      calls.push({ name: 'restore' });
    },
    fillText: (text: string, x: number, y: number) => {
      calls.push({
        name: 'fillText',
        text,
        x,
        y,
        fillStyle: context.fillStyle,
        font: context.font,
        textAlign: context.textAlign,
        textBaseline: context.textBaseline,
      });
    },
    strokeText: (text: string, x: number, y: number) => {
      calls.push({
        name: 'strokeText',
        text,
        x,
        y,
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
        lineJoin: context.lineJoin,
      });
    },
  };

  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

function makeLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return { ...DEFAULT_TEXT_LAYER, id: 'test-layer', ...patch };
}

describe('resolveTextLayerLayout', () => {
  it('returns null when there is nothing to draw', () => {
    expect(resolveTextLayerLayout(800, 600, makeLayer({ text: '' }), 0)).toBeNull();
    expect(resolveTextLayerLayout(800, 600, makeLayer({ text: '   ' }), 0)).toBeNull();
  });

  it('returns null when the layer is hidden', () => {
    expect(resolveTextLayerLayout(800, 600, makeLayer({ visible: false }), 0)).toBeNull();
  });

  it('returns null for a degenerate image size', () => {
    expect(resolveTextLayerLayout(0, 600, makeLayer(), 0)).toBeNull();
    expect(resolveTextLayerLayout(800, Number.NaN, makeLayer(), 0)).toBeNull();
  });

  it('scales the font from the short side so 横竖图占比一致', () => {
    const wide = resolveTextLayerLayout(2000, 1000, makeLayer({ fontSizePercent: 10 }), 0);
    const tall = resolveTextLayerLayout(1000, 2000, makeLayer({ fontSizePercent: 10 }), 0);

    expect(wide?.fontSizePx).toBe(100);
    expect(tall?.fontSizePx).toBe(100);
  });

  it('places the anchor by percentage of the image', () => {
    const layout = resolveTextLayerLayout(
      1000,
      800,
      makeLayer({ xPercent: 25, yPercent: 75 }),
      0
    );

    expect(layout?.anchorX).toBe(250);
    expect(layout?.anchorY).toBe(600);
  });

  it('splits multi-line text and derives the stroke width from the font size', () => {
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({ text: '上\n下', autoNumber: false, fontSizePercent: 10, strokePercent: 20 }),
      0
    );

    expect(layout?.lines).toEqual(['上', '下']);
    expect(layout?.fontSizePx).toBe(100);
    expect(layout?.strokeWidthPx).toBeCloseTo(20);
    // 默认行距 125% → 100px 字 → 125px 行高
    expect(layout?.lineHeightPx).toBe(125);
    expect(layout?.blockHeight).toBe(250);
  });

  it('resolves the numbering token with the given order index', () => {
    const layout = resolveTextLayerLayout(1000, 1000, makeLayer({ text: '图像' }), 2);
    expect(layout?.lines).toEqual(['图像3']);
  });

  it('computes a vertical block size that the DOM preview can reuse', () => {
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({
        text: '一二\n三四',
        autoNumber: false,
        direction: 'vertical',
        fontSizePercent: 10,
        lineHeightPercent: 100,
      }),
      0
    );

    expect(layout?.direction).toBe('vertical');
    expect(layout?.lines).toEqual(['一二', '三四']);
    // 2 列 × 100px 列宽；最长列 2 字 × 100px
    expect(layout?.blockWidth).toBe(200);
    expect(layout?.blockHeight).toBe(200);
  });

  it('leaves blockWidth at 0 for horizontal text (width depends on the font)', () => {
    const layout = resolveTextLayerLayout(1000, 1000, makeLayer(), 0);
    expect(layout?.blockWidth).toBe(0);
  });
});

describe('resolveTextLayersLayout', () => {
  it('skips hidden / empty layers but keeps the rest', () => {
    const layouts = resolveTextLayersLayout(
      1000,
      1000,
      [
        makeLayer({ id: 'a', text: '甲' }),
        makeLayer({ id: 'b', text: '' }),
        makeLayer({ id: 'c', text: '丙', visible: false }),
        makeLayer({ id: 'd', text: '丁' }),
      ],
      0
    );

    expect(layouts.map((layout) => layout.layerId)).toEqual(['a', 'd']);
  });

  it('returns an empty array for no layers', () => {
    expect(resolveTextLayersLayout(1000, 1000, [], 0)).toEqual([]);
  });
});

describe('buildTextFont / textAnchorTranslate', () => {
  it('includes weight, size and family', () => {
    expect(buildTextFont({ bold: true, fontSizePx: 42, fontFamily: 'Georgia, serif' })).toBe(
      '700 42px Georgia, serif'
    );
    expect(buildTextFont({ bold: false, fontSizePx: 42, fontFamily: 'Georgia, serif' })).toBe(
      '400 42px Georgia, serif'
    );
  });

  it('maps alignment to a CSS translate percentage', () => {
    expect(textAnchorTranslate('left')).toBe('0');
    expect(textAnchorTranslate('center')).toBe('-50%');
    expect(textAnchorTranslate('right')).toBe('-100%');
  });
});

describe('drawTextLayer (horizontal)', () => {
  it('strokes before filling so the visible outline stays outside the glyph', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({ text: '图像', fontSizePercent: 10, strokePercent: 10 }),
      0
    );

    drawTextLayer(context, layout!);

    const drawn = calls.filter((call) => call.name === 'fillText' || call.name === 'strokeText');
    expect(drawn.map((call) => call.name)).toEqual(['strokeText', 'fillText']);
    // 线宽取两倍再被填充盖掉内半圈 → 可见描边 = strokeWidthPx。
    expect(drawn[0].lineWidth).toBeCloseTo(layout!.strokeWidthPx * 2);
    expect(drawn[0].lineJoin).toBe('round');
  });

  it('skips stroking entirely when stroke width is zero', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(1000, 1000, makeLayer({ strokePercent: 0 }), 0);

    drawTextLayer(context, layout!);

    expect(calls.some((call) => call.name === 'strokeText')).toBe(false);
    expect(calls.some((call) => call.name === 'fillText')).toBe(true);
  });

  it('centres the text block vertically on the anchor and advances by line height', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({
        text: '一\n二\n三',
        autoNumber: false,
        fontSizePercent: 10,
        yPercent: 50,
        strokePercent: 0,
      }),
      0
    );

    drawTextLayer(context, layout!);

    const lines = calls.filter((call) => call.name === 'fillText');
    expect(lines).toHaveLength(3);
    expect(lines[0].y).toBeCloseTo(500 - 125);
    expect(lines[1].y).toBeCloseTo(500);
    expect(lines[2].y).toBeCloseTo(500 + 125);
  });

  it('applies font, alignment and middle baseline from the layout', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({ align: 'right', bold: true, fontFamily: 'Georgia, serif', strokePercent: 0 }),
      0
    );

    drawTextLayer(context, layout!);

    const first = calls.find((call) => call.name === 'fillText');
    expect(first?.textAlign).toBe('right');
    expect(first?.textBaseline).toBe('middle');
    expect(first?.font).toContain('700');
    expect(first?.font).toContain('Georgia, serif');
  });
});

describe('drawTextLayer (vertical)', () => {
  it('draws one glyph per call, stacked downward, with columns running right to left', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(
      1000,
      1000,
      makeLayer({
        text: '一二\n三四',
        autoNumber: false,
        direction: 'vertical',
        fontSizePercent: 10,
        lineHeightPercent: 100,
        // 不显式给 yPercent 的话会拿到默认的 92，anchorY = 920，
        // 下面「垂直居中于 y=500」的断言就不成立了。
        yPercent: 50,
        strokePercent: 0,
      }),
      0
    );

    drawTextLayer(context, layout!);

    const glyphs = calls.filter((call) => call.name === 'fillText');
    // 2 列 × 2 字 = 4 次 fillText，每次只画一个字
    expect(glyphs.map((call) => call.text)).toEqual(['一', '二', '三', '四']);
    expect(glyphs.every((call) => call.textAlign === 'center')).toBe(true);

    // 块宽 200、居中于 x=500 → 左边界 400；第 0 列中心 550，第 1 列中心 450
    expect(glyphs[0].x).toBeCloseTo(550);
    expect(glyphs[1].x).toBeCloseTo(550);
    expect(glyphs[2].x).toBeCloseTo(450);
    expect(glyphs[3].x).toBeCloseTo(450);

    // 每列垂直居中于 y=500：两个字分别在 450 / 550
    expect(glyphs[0].y).toBeCloseTo(450);
    expect(glyphs[1].y).toBeCloseTo(550);
  });

  it('honours left / right alignment of the whole block', () => {
    const base = {
      text: '一二\n三四',
      autoNumber: false,
      direction: 'vertical' as const,
      fontSizePercent: 10,
      lineHeightPercent: 100,
      strokePercent: 0,
    };

    const leftRun = createMockContext();
    drawTextLayer(
      leftRun.context,
      resolveTextLayerLayout(1000, 1000, makeLayer({ ...base, align: 'left' }), 0)!
    );
    // 左对齐 → 块左边界 = 500，第 0 列（最右）中心 = 500 + 200 - 50 = 650
    expect(leftRun.calls.find((call) => call.name === 'fillText')?.x).toBeCloseTo(650);

    const rightRun = createMockContext();
    drawTextLayer(
      rightRun.context,
      resolveTextLayerLayout(1000, 1000, makeLayer({ ...base, align: 'right' }), 0)!
    );
    // 右对齐 → 块右边界 = 500，第 0 列中心 = 500 - 50 = 450
    expect(rightRun.calls.find((call) => call.name === 'fillText')?.x).toBeCloseTo(450);
  });
});

describe('drawTextLayer state hygiene', () => {
  it('wraps every draw in save/restore so it never leaks state', () => {
    const { context, calls } = createMockContext();
    const layout = resolveTextLayerLayout(1000, 1000, makeLayer(), 0);

    drawTextLayer(context, layout!);

    expect(calls[0].name).toBe('save');
    expect(calls[calls.length - 1].name).toBe('restore');
  });
});

describe('drawTextLayersFromOptions', () => {
  it('draws every visible layer and reports whether anything was painted', () => {
    const { context, calls } = createMockContext();
    const options = {
      [TEXT_LAYERS_KEY]: stringifyTextLayers([
        makeLayer({ id: 'a', text: '甲' }),
        makeLayer({ id: 'b', text: '乙', visible: false }),
      ]),
    };

    expect(drawTextLayersFromOptions(context, 1000, 1000, options, 0)).toBe(true);
    expect(calls.filter((call) => call.name === 'fillText')).toHaveLength(1);
  });

  it('returns false (and paints nothing) when there are no layers', () => {
    const { context, calls } = createMockContext();

    expect(drawTextLayersFromOptions(context, 1000, 1000, {}, 0)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('applies the per-image order index to every layer', () => {
    const { context, calls } = createMockContext();
    const options = {
      [TEXT_LAYERS_KEY]: stringifyTextLayers([makeLayer({ id: 'a', text: '图像' })]),
    };

    drawTextLayersFromOptions(context, 1000, 1000, options, 4);

    expect(calls.find((call) => call.name === 'fillText')?.text).toBe('图像5');
  });
});
