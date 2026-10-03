import { describe, expect, it } from 'vitest';

import {
  clampTrimInsets,
  hexToRgb,
  intersectCropRect,
  isTrimInsetsEmpty,
  readCropRect,
  resolveAutoCropContentRect,
  resolveColorTrimInsets,
  resolveEffectiveCropRect,
  resolveRemovedInsets,
  scaleTrimInsets,
  type Rgb,
} from './trim';
import {
  DEFAULT_AUTO_CROP_OPTIONS,
  normalizeAutoCropEdges,
  readAutoCropOptions,
  toAutoCropToolOptions,
  toggleAutoCropEdge,
} from './types';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** 造一块纯色 RGBA 像素。 */
function createPixels(width: number, height: number, fill: Rgb = BLACK): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = fill.r;
    data[offset + 1] = fill.g;
    data[offset + 2] = fill.b;
    data[offset + 3] = 255;
  }
  return data;
}

function fillRect(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgb
): void {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let col = x; col < x + rectWidth; col += 1) {
      const offset = (row * width + col) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
    }
  }
}

function putPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  color: Rgb
): void {
  const offset = (y * width + x) * 4;
  data[offset] = color.r;
  data[offset + 1] = color.g;
  data[offset + 2] = color.b;
}

/**
 * 白底 10×10，中间 (2,2)-(7,7) 是黑块 —— 经典「白边包裹内容」。
 * 四边各该裁掉 2px。
 */
function createFramedImage(): Uint8ClampedArray {
  const data = createPixels(10, 10, WHITE);
  fillRect(data, 10, 2, 2, 6, 6, BLACK);
  return data;
}

describe('hexToRgb', () => {
  it('解析 #RRGGBB 与不带 # 的写法', () => {
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#00b140')).toEqual({ r: 0, g: 177, b: 64 });
  });

  it('非法输入返回 null', () => {
    expect(hexToRgb('white')).toBeNull();
    expect(hexToRgb('#FFF')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });
});

describe('resolveColorTrimInsets', () => {
  it('把四边的纯色边裁掉，留下内容边界', () => {
    expect(
      resolveColorTrimInsets(createFramedImage(), 10, 10, {
        color: '#FFFFFF',
        edges: 'tblr',
      })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
  });

  it('只裁开了开关的那几边', () => {
    const insets = resolveColorTrimInsets(createFramedImage(), 10, 10, {
      color: '#FFFFFF',
      edges: 'tb',
    });
    expect(insets).toEqual({ top: 2, right: 0, bottom: 2, left: 0 });
  });

  it('近似比色：差 ≤12 算「同一个颜色」（吸收压缩噪点与浅灰底），差 >12 立刻停', () => {
    // 差 5（#FAFAFA vs #FFFFFF）—— 肉眼就是白，继续裁
    const nearWhite = createPixels(10, 10, { r: 250, g: 250, b: 250 });
    fillRect(nearWhite, 10, 2, 2, 6, 6, BLACK);
    expect(
      resolveColorTrimInsets(nearWhite, 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });

    // 单通道差 1 也一样算同色
    const offByOne = createPixels(10, 10, { r: 255, g: 255, b: 254 });
    fillRect(offByOne, 10, 2, 2, 6, 6, BLACK);
    expect(
      resolveColorTrimInsets(offByOne, 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });

    // 正好压在阈值上（差 12）—— 仍然算同色
    const onThreshold = createPixels(10, 10, { r: 243, g: 243, b: 243 });
    fillRect(onThreshold, 10, 2, 2, 6, 6, BLACK);
    expect(
      resolveColorTrimInsets(onThreshold, 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });

    // 超过阈值（差 15，#F0F0F0）—— 看得出来的不同颜色，一点都不裁
    const greyEdge = createPixels(10, 10, { r: 240, g: 240, b: 240 });
    fillRect(greyEdge, 10, 2, 2, 6, 6, BLACK);
    expect(
      resolveColorTrimInsets(greyEdge, 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });

    // 完全一致当然也裁
    expect(
      resolveColorTrimInsets(createFramedImage(), 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
  });

  it('识别色不区分大小写与是否带 #', () => {
    expect(
      resolveColorTrimInsets(createFramedImage(), 10, 10, { color: '#ffffff', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
    expect(
      resolveColorTrimInsets(createFramedImage(), 10, 10, { color: 'FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
  });

  it('容忍一条线上的零星噪点（≤2%），但不放过成片的杂色', () => {
    const width = 100;
    const height = 10;

    const speckled = createPixels(width, height, WHITE);
    fillRect(speckled, width, 0, 2, width, 8, BLACK);
    putPixel(speckled, width, 50, 0, BLACK);
    expect(
      resolveColorTrimInsets(speckled, width, height, {
        color: '#FFFFFF',
        edges: 't',
      }).top
    ).toBe(2);

    const dirty = createPixels(width, height, WHITE);
    fillRect(dirty, width, 0, 2, width, 8, BLACK);
    putPixel(dirty, width, 10, 0, BLACK);
    putPixel(dirty, width, 30, 0, BLACK);
    putPixel(dirty, width, 70, 0, BLACK);
    expect(
      resolveColorTrimInsets(dirty, width, height, {
        color: '#FFFFFF',
        edges: 't',
      }).top
    ).toBe(0);
  });

  it('整张图都是识别色时兜底保留 10%，不会裁成空图', () => {
    const insets = resolveColorTrimInsets(createPixels(10, 10, WHITE), 10, 10, {
      color: '#FFFFFF',
      edges: 'tblr',
    });

    expect(insets).toEqual({ top: 9, right: 0, bottom: 0, left: 9 });

    const rect = resolveAutoCropContentRect(insets, 10, 10);
    expect(rect.width).toBe(1);
    expect(rect.height).toBe(1);
  });

  it('像素缓冲区不完整或颜色非法时返回全 0', () => {
    const tooShort = new Uint8ClampedArray(4);
    expect(
      resolveColorTrimInsets(tooShort, 10, 10, { color: '#FFFFFF', edges: 'tblr' })
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });

    expect(
      resolveColorTrimInsets(createFramedImage(), 10, 10, {
        color: 'not-a-color',
        edges: 'tblr',
      })
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('clampTrimInsets', () => {
  it('超出安全范围时按比例压缩，不会把图裁没', () => {
    expect(clampTrimInsets({ top: 100, right: 0, bottom: 100, left: 0 }, 10, 10)).toEqual({
      top: 4,
      right: 0,
      bottom: 4,
      left: 0,
    });
  });

  it('负数与小数量级一律归零取整', () => {
    expect(clampTrimInsets({ top: -3, right: 2.7, bottom: 0, left: 1.2 }, 100, 100)).toEqual({
      top: 0,
      right: 2,
      bottom: 0,
      left: 1,
    });
  });
});

describe('scaleTrimInsets', () => {
  it('把检测空间的裁剪量换算回原图空间', () => {
    expect(scaleTrimInsets({ top: 3, right: 5, bottom: 3, left: 5 }, 2, 2.5)).toEqual({
      top: 8,
      right: 10,
      bottom: 8,
      left: 10,
    });
  });

  it('比例非法时退化为 1:1', () => {
    expect(scaleTrimInsets({ top: 3, right: 3, bottom: 3, left: 3 }, 0, Number.NaN)).toEqual({
      top: 3,
      right: 3,
      bottom: 3,
      left: 3,
    });
  });
});

describe('resolveAutoCropContentRect', () => {
  it('裁剪量直接变成内容矩形', () => {
    expect(
      resolveAutoCropContentRect({ top: 10, right: 20, bottom: 30, left: 40 }, 200, 100)
    ).toEqual({ x: 40, y: 10, width: 140, height: 60 });
  });

  it('保留边距是往回留一圈，从裁剪量里减掉', () => {
    expect(
      resolveAutoCropContentRect({ top: 10, right: 10, bottom: 10, left: 10 }, 100, 100, 4)
    ).toEqual({ x: 6, y: 6, width: 88, height: 88 });
  });

  it('保留边距大于裁剪量时退回整张图', () => {
    expect(
      resolveAutoCropContentRect({ top: 3, right: 3, bottom: 3, left: 3 }, 100, 100, 10)
    ).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('resolveRemovedInsets', () => {
  it('是 resolveAutoCropContentRect 的逆运算', () => {
    const insets = { top: 10, right: 20, bottom: 30, left: 40 };
    const rect = resolveAutoCropContentRect(insets, 200, 100);
    expect(resolveRemovedInsets(rect, 200, 100)).toEqual(insets);
  });

  it('保留边距会同时缩掉内容边界与「裁掉量」，两行读数自洽', () => {
    const insets = { top: 40, right: 50, bottom: 40, left: 50 };
    const rect = resolveAutoCropContentRect(insets, 400, 300, 15);
    expect(rect).toEqual({ x: 35, y: 25, width: 330, height: 250 });
    expect(resolveRemovedInsets(rect, 400, 300)).toEqual({
      top: 25,
      right: 35,
      bottom: 25,
      left: 35,
    });
  });

  it('内容矩形铺满整张图时四边都是 0', () => {
    expect(
      resolveRemovedInsets({ x: 0, y: 0, width: 400, height: 300 }, 400, 300)
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('intersectCropRect', () => {
  it('完全包含时返回内层矩形', () => {
    expect(
      intersectCropRect(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 20, y: 20, width: 50, height: 50 }
      )
    ).toEqual({ x: 20, y: 20, width: 50, height: 50 });
  });

  it('部分重叠时返回交集', () => {
    expect(
      intersectCropRect(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: 50, width: 100, height: 100 }
      )
    ).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  it('不相交返回 null', () => {
    expect(
      intersectCropRect(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 100, y: 100, width: 10, height: 10 }
      )
    ).toBeNull();
  });
});

describe('resolveEffectiveCropRect', () => {
  const manual = { x: 0, y: 0, width: 100, height: 100 };
  const content = { x: 10, y: 10, width: 50, height: 50 };

  it('自动裁剪生效时取交集', () => {
    expect(resolveEffectiveCropRect(manual, content)).toEqual(content);
  });

  it('手动框落在内容里时完全不受影响', () => {
    const inner = { x: 20, y: 20, width: 20, height: 20 };
    expect(resolveEffectiveCropRect(inner, content)).toEqual(inner);
  });

  it('只有一边存在时退回那一边', () => {
    expect(resolveEffectiveCropRect(manual, null)).toEqual(manual);
    expect(resolveEffectiveCropRect(null, content)).toEqual(content);
  });

  it('完全不重叠时退回手动框，宁可没生效也不产出空图', () => {
    const far = { x: 500, y: 500, width: 20, height: 20 };
    expect(resolveEffectiveCropRect(far, content)).toEqual(far);
  });

  it('两边都缺返回 null', () => {
    expect(resolveEffectiveCropRect(null, null)).toBeNull();
  });
});

describe('readCropRect', () => {
  it('读出合法裁剪框', () => {
    expect(readCropRect({ cropX: 10, cropY: 20, cropWidth: 30, cropHeight: 40 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it('字段缺失或尺寸非正返回 null', () => {
    expect(readCropRect({})).toBeNull();
    expect(readCropRect({ cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 10 })).toBeNull();
    expect(
      readCropRect({ cropX: 'a', cropY: 0, cropWidth: 10, cropHeight: 10 })
    ).toBeNull();
  });
});

describe('isTrimInsetsEmpty', () => {
  it('四边全 0 才算空', () => {
    expect(isTrimInsetsEmpty({ top: 0, right: 0, bottom: 0, left: 0 })).toBe(true);
    expect(isTrimInsetsEmpty({ top: 0, right: 0, bottom: 0, left: 1 })).toBe(false);
  });
});

describe('边集合', () => {
  it('规范化成固定顺序，丢掉认不出的字符', () => {
    expect(normalizeAutoCropEdges('BR')).toBe('br');
    expect(normalizeAutoCropEdges('bltr')).toBe('tblr');
    expect(normalizeAutoCropEdges('xyz')).toBe('');
    expect(normalizeAutoCropEdges(undefined)).toBe('');
  });

  it('切换某一边时保持规范顺序', () => {
    expect(toggleAutoCropEdge('tblr', 't')).toBe('blr');
    expect(toggleAutoCropEdge('tb', 'r')).toBe('tbr');
    expect(toggleAutoCropEdge('', 'l')).toBe('l');
  });
});

describe('readAutoCropOptions / toAutoCropToolOptions', () => {
  it('缺省时全部回落到默认值', () => {
    expect(readAutoCropOptions({})).toEqual({
      enabled: false,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 0,
    });
  });

  it('越界数值被夹回范围，非法颜色回落到默认白', () => {
    const parsed = readAutoCropOptions({
      autoCropEnabled: true,
      autoCropColor: 'red',
      autoCropEdges: 'zz',
      autoCropPaddingPercent: 99,
    });

    expect(parsed).toEqual({
      enabled: true,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 20,
    });
  });

  it('只认布尔 true，脏数据一律当没开', () => {
    expect(readAutoCropOptions({ autoCropEnabled: 'true' }).enabled).toBe(false);
    expect(readAutoCropOptions({ autoCropEnabled: 1 }).enabled).toBe(false);
  });

  it('摊回 ToolOptions 时颜色大写、边集合规范化', () => {
    expect(
      toAutoCropToolOptions({
        enabled: true,
        color: '#ffffff',
        edges: 'rb',
        paddingPercent: 2,
      })
    ).toEqual({
      autoCropEnabled: true,
      autoCropColor: '#ffffff',
      autoCropEdges: 'br',
      autoCropPaddingPercent: 2,
    });
  });

  it('默认选项读回来等于默认值本身（往返一致）', () => {
    expect(readAutoCropOptions(DEFAULT_AUTO_CROP_OPTIONS)).toEqual({
      enabled: false,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 0,
    });
  });
});
