import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXT_LAYER,
  TEXT_FONT_SIZE_MAX,
  TEXT_LAYERS_KEY,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  TEXT_MAX_LAYERS,
  TEXT_NUMBER_TOKEN,
  buildTextLayersPatch,
  createTextLayer,
  readTextLayerOptions,
  readTextLayers,
  readTextLayersFromNode,
  resolveTextContent,
  resolveTextNumber,
  stringifyTextLayers,
  type TextLayer,
} from './types';

function makeLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return { ...DEFAULT_TEXT_LAYER, id: 'test-layer', ...patch };
}

function makeNodeLike(data: Record<string, unknown>) {
  return { data } as unknown as Parameters<typeof readTextLayersFromNode>[0];
}

describe('resolveTextNumber', () => {
  it('is numberStart + index (画布第一张 = 起始值)', () => {
    expect(resolveTextNumber(makeLayer({ numberStart: 1 }), 0)).toBe(1);
    expect(resolveTextNumber(makeLayer({ numberStart: 1 }), 3)).toBe(4);
    expect(resolveTextNumber(makeLayer({ numberStart: 10 }), 0)).toBe(10);
  });

  it('clamps a negative index to 0 instead of going below the start', () => {
    expect(resolveTextNumber(makeLayer({ numberStart: 1 }), -2)).toBe(1);
  });
});

describe('resolveTextContent', () => {
  it('replaces {n} at the placeholder position', () => {
    expect(resolveTextContent(makeLayer({ text: `第${TEXT_NUMBER_TOKEN}页` }), 0)).toBe('第1页');
    expect(resolveTextContent(makeLayer({ text: `第${TEXT_NUMBER_TOKEN}页` }), 2)).toBe('第3页');
  });

  it('appends the number when the template has no placeholder', () => {
    expect(resolveTextContent(makeLayer({ text: '图像' }), 0)).toBe('图像1');
    expect(resolveTextContent(makeLayer({ text: '图像' }), 4)).toBe('图像5');
  });

  it('keeps the template untouched when auto numbering is off', () => {
    expect(resolveTextContent(makeLayer({ text: '封面', autoNumber: false }), 3)).toBe('封面');
  });

  it('still fills an explicit {n} even when auto numbering is off', () => {
    expect(
      resolveTextContent(makeLayer({ text: `第${TEXT_NUMBER_TOKEN}页`, autoNumber: false }), 1)
    ).toBe('第2页');
  });

  it('never turns an empty template into a lone number', () => {
    // 否则用户清空输入框会得到孤零零一个「1」。
    expect(resolveTextContent(makeLayer({ text: '' }), 0)).toBe('');
    expect(resolveTextContent(makeLayer({ text: '   ' }), 0)).toBe('   ');
  });

  it('honours a custom starting number', () => {
    expect(resolveTextContent(makeLayer({ text: '图像', numberStart: 10 }), 0)).toBe('图像10');
  });
});

describe('readTextLayerOptions', () => {
  it('returns the defaults for missing input', () => {
    const parsed = readTextLayerOptions(undefined);
    expect(parsed.text).toBe(DEFAULT_TEXT_LAYER.text);
    expect(parsed.direction).toBe('horizontal');
    expect(parsed.lineHeightPercent).toBe(DEFAULT_TEXT_LAYER.lineHeightPercent);
    expect(parsed.visible).toBe(true);
  });

  it('falls back to defaults for wrong-typed values', () => {
    const parsed = readTextLayerOptions({
      xPercent: 'nope',
      color: 'red',
      align: 'diagonal',
      direction: 'diagonal',
      fontSizePercent: Number.NaN,
      autoNumber: 'yes',
    });

    expect(parsed.xPercent).toBe(DEFAULT_TEXT_LAYER.xPercent);
    expect(parsed.color).toBe(DEFAULT_TEXT_LAYER.color);
    expect(parsed.align).toBe(DEFAULT_TEXT_LAYER.align);
    expect(parsed.direction).toBe(DEFAULT_TEXT_LAYER.direction);
    expect(parsed.fontSizePercent).toBe(DEFAULT_TEXT_LAYER.fontSizePercent);
    expect(parsed.autoNumber).toBe(DEFAULT_TEXT_LAYER.autoNumber);
  });

  it('clamps out-of-range numbers', () => {
    const parsed = readTextLayerOptions({
      xPercent: 500,
      yPercent: -500,
      fontSizePercent: 999,
      strokePercent: -5,
      lineHeightPercent: 9999,
    });

    expect(parsed.xPercent).toBe(200);
    expect(parsed.yPercent).toBe(-100);
    expect(parsed.fontSizePercent).toBe(TEXT_FONT_SIZE_MAX);
    expect(parsed.strokePercent).toBe(0);
    expect(parsed.lineHeightPercent).toBe(TEXT_LINE_HEIGHT_MAX);
  });

  it('accepts vertical direction and normalises hex colours', () => {
    const parsed = readTextLayerOptions({ direction: 'vertical', color: '#ff0000' });
    expect(parsed.direction).toBe('vertical');
    expect(parsed.color).toBe('#FF0000');
    expect(readTextLayerOptions({ color: '#ff00' }).color).toBe(DEFAULT_TEXT_LAYER.color);
  });

  it('gives a fresh id when the payload has none', () => {
    const first = readTextLayerOptions({ text: 'a' });
    const second = readTextLayerOptions({ text: 'a' });
    expect(first.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });
});

describe('readTextLayers / stringifyTextLayers', () => {
  it('returns an empty array when there is nothing saved', () => {
    expect(readTextLayers(undefined)).toEqual([]);
    expect(readTextLayers('')).toEqual([]);
    expect(readTextLayers('not json')).toEqual([]);
    expect(readTextLayers({ nope: true })).toEqual([]);
  });

  it('parses a JSON string back into layers', () => {
    const layers = [makeLayer({ text: '甲' }), makeLayer({ id: 'second', text: '乙' })];
    const parsed = readTextLayers(stringifyTextLayers(layers));

    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('甲');
    expect(parsed[1].id).toBe('second');
    expect(parsed[1].text).toBe('乙');
  });

  it('accepts an already-parsed array', () => {
    expect(readTextLayers([{ text: '甲' }])[0].text).toBe('甲');
  });

  it('caps the layer count so a bad payload cannot flood the canvas', () => {
    const many = Array.from({ length: TEXT_MAX_LAYERS + 5 }, (_item, index) =>
      makeLayer({ id: `l-${index}` })
    );
    expect(readTextLayers(many)).toHaveLength(TEXT_MAX_LAYERS);
  });

  it('normalises every layer it reads', () => {
    const parsed = readTextLayers([{ text: '甲', xPercent: 9999, direction: 'vertical' }]);
    expect(parsed[0].xPercent).toBe(200);
    expect(parsed[0].direction).toBe('vertical');
    expect(parsed[0].fontFamily).toBe(DEFAULT_TEXT_LAYER.fontFamily);
  });
});

describe('node-backed helpers', () => {
  it('reads the shared layers off node.data', () => {
    const node = makeNodeLike({ [TEXT_LAYERS_KEY]: stringifyTextLayers([makeLayer({ text: '甲' })]) });
    expect(readTextLayersFromNode(node)[0].text).toBe('甲');
    expect(readTextLayersFromNode(null)).toEqual([]);
    expect(readTextLayersFromNode(makeNodeLike({}))).toEqual([]);
  });

  it('writes a patch keyed by the shared field name', () => {
    const patch = buildTextLayersPatch([makeLayer({ text: '甲' })]);
    expect(patch).toHaveProperty(TEXT_LAYERS_KEY);
    expect(readTextLayers(patch[TEXT_LAYERS_KEY])[0].text).toBe('甲');
  });
});

describe('createTextLayer', () => {
  it('gives every layer a unique id', () => {
    const a = createTextLayer();
    const b = createTextLayer();
    expect(a.id).not.toBe(b.id);
  });

  it('applies the patch on top of the defaults', () => {
    const layer = createTextLayer({ text: '甲', direction: 'vertical' });
    expect(layer.text).toBe('甲');
    expect(layer.direction).toBe('vertical');
    expect(layer.color).toBe(DEFAULT_TEXT_LAYER.color);
  });

  it('clamps the default line height inside the allowed range', () => {
    expect(DEFAULT_TEXT_LAYER.lineHeightPercent).toBeGreaterThanOrEqual(TEXT_LINE_HEIGHT_MIN);
    expect(DEFAULT_TEXT_LAYER.lineHeightPercent).toBeLessThanOrEqual(TEXT_LINE_HEIGHT_MAX);
  });
});
