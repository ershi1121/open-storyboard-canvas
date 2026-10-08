import { describe, expect, it } from 'vitest';

import {
  BORDER_MAX_LAYERS,
  createBorderLayerId,
  describeAspectRatio,
  isBorderNoop,
  parseBorderLayers,
  parseBorderRatio,
  readBorderOptions,
  resolveBorderGeometry,
  stringifyBorderLayers,
  toBorderToolOptions,
  type BorderLayer,
  type BorderOptions,
} from './types';

function layer(color: string, widthPercent: number, id = `${color}-${widthPercent}`): BorderLayer {
  return { id, color, widthPercent };
}

function makeBorder(patch: Partial<BorderOptions> = {}): BorderOptions {
  return {
    layers: [],
    strokePercent: 0,
    radiusPercent: 0,
    ratioMode: 'none',
    customRatio: '',
    padPercent: 0,
    ...patch,
  };
}

describe('parseBorderRatio', () => {
  it('parses preset ratios', () => {
    expect(parseBorderRatio('16:9', '')).toBeCloseTo(16 / 9);
  });

  it('parses decimal and custom ratios', () => {
    expect(parseBorderRatio('custom', '1.5')).toBe(1.5);
    expect(parseBorderRatio('custom', '3:2')).toBe(1.5);
  });

  it('returns null for none and for invalid input', () => {
    expect(parseBorderRatio('none', '')).toBeNull();
    expect(parseBorderRatio('custom', '')).toBeNull();
    expect(parseBorderRatio('custom', 'abc')).toBeNull();
    expect(parseBorderRatio('custom', '0:5')).toBeNull();
  });
});

describe('parseBorderLayers', () => {
  it('returns an empty list when the option is missing or blank', () => {
    expect(parseBorderLayers(undefined)).toEqual([]);
    expect(parseBorderLayers('')).toEqual([]);
    expect(parseBorderLayers('   ')).toEqual([]);
  });

  it('returns an empty list instead of throwing on malformed JSON', () => {
    expect(parseBorderLayers('{not json')).toEqual([]);
    expect(parseBorderLayers('42')).toEqual([]);
  });

  it('round-trips through stringify', () => {
    const layers = [layer('#FFFFFF', 4), layer('#000000', 2)];
    expect(parseBorderLayers(stringifyBorderLayers(layers))).toEqual(layers);
  });

  it('normalises the colour casing and clamps the width', () => {
    const parsed = parseBorderLayers(
      JSON.stringify([{ id: 'a', color: '#3b82f6', widthPercent: 999 }])
    );

    expect(parsed[0].color).toBe('#3B82F6');
    expect(parsed[0].widthPercent).toBe(50);
  });

  it('falls back to the default colour rather than feeding canvas a bad fillStyle', () => {
    const parsed = parseBorderLayers(JSON.stringify([{ id: 'a', color: 'red', widthPercent: 1 }]));
    expect(parsed[0].color).toBe('#FFFFFF');
  });

  it('drops unusable entries but keeps the good ones', () => {
    const parsed = parseBorderLayers(
      JSON.stringify([null, 'nope', { color: '#000000', widthPercent: 3 }])
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].color).toBe('#000000');
  });

  it('mints an id when one is missing', () => {
    const parsed = parseBorderLayers(JSON.stringify([{ color: '#000000', widthPercent: 1 }]));
    expect(parsed[0].id).toBeTruthy();
  });

  it('caps the layer count', () => {
    const many = Array.from({ length: BORDER_MAX_LAYERS + 3 }, (_item, index) =>
      layer('#FFFFFF', 1, `id-${index}`)
    );
    expect(parseBorderLayers(stringifyBorderLayers(many))).toHaveLength(BORDER_MAX_LAYERS);
  });

  it('never reuses an id it handed out', () => {
    const ids = new Set([createBorderLayerId(), createBorderLayerId(), createBorderLayerId()]);
    expect(ids.size).toBe(3);
  });
});

describe('readBorderOptions', () => {
  it('falls back to defaults for missing options', () => {
    expect(readBorderOptions({})).toEqual({
      layers: [],
      strokePercent: 0,
      radiusPercent: 0,
      ratioMode: 'none',
      customRatio: '',
      padPercent: 0,
    });
  });

  it('clamps percents into their allowed range', () => {
    expect(readBorderOptions({ borderStrokePercent: -5 }).strokePercent).toBe(0);
    expect(readBorderOptions({ borderRadiusPercent: 999 }).radiusPercent).toBe(50);
  });

  it('drops an unknown ratio mode', () => {
    expect(readBorderOptions({ borderRatioMode: 'bogus' }).ratioMode).toBe('none');
  });

  it('round-trips through toBorderToolOptions', () => {
    const border = makeBorder({
      layers: [layer('#FFFFFF', 4), layer('#000000', 2)],
      strokePercent: 3,
      radiusPercent: 5,
      ratioMode: '1:1',
      customRatio: '',
    });

    expect(readBorderOptions(toBorderToolOptions(border))).toEqual(border);
  });
});

describe('resolveBorderGeometry', () => {
  it('is a no-op when there are no layers at all', () => {
    const geometry = resolveBorderGeometry(800, 600, makeBorder());

    expect(geometry.padX).toBe(0);
    expect(geometry.padY).toBe(0);
    expect(geometry.canvasWidth).toBe(800);
    expect(geometry.canvasHeight).toBe(600);
    expect(geometry.rings).toEqual([]);
  });

  it('grows the canvas by the layer width on all four sides', () => {
    const geometry = resolveBorderGeometry(1000, 500, makeBorder({ layers: [layer('#FFFFFF', 10)] }));

    // 10% 以短边 500 为基准 → 50px
    expect(geometry.totalThicknessPx).toBe(50);
    expect(geometry.padX).toBe(50);
    expect(geometry.padY).toBe(50);
    expect(geometry.canvasWidth).toBe(1100);
    expect(geometry.canvasHeight).toBe(600);
  });

  it('stacks layers concentrically and grows the canvas by the sum', () => {
    const geometry = resolveBorderGeometry(
      1000,
      500,
      makeBorder({ layers: [layer('#FFFFFF', 10), layer('#000000', 6)] })
    );

    // 短边 500 → 50 + 30 = 80
    expect(geometry.totalThicknessPx).toBe(80);
    expect(geometry.rings.map((ring) => ring.thicknessPx)).toEqual([50, 30]);
    expect(geometry.rings.map((ring) => ring.outerOffsetPx)).toEqual([50, 80]);
    expect(geometry.padX).toBe(80);
    expect(geometry.canvasWidth).toBe(1160);
    expect(geometry.canvasHeight).toBe(660);
  });

  it('takes the fill colour from the outermost layer and the stroke colour from the innermost', () => {
    const geometry = resolveBorderGeometry(
      1000,
      500,
      makeBorder({ layers: [layer('#FFFFFF', 10), layer('#E24B4A', 6)] })
    );

    expect(geometry.fillColor).toBe('#E24B4A');
    expect(geometry.strokeColor).toBe('#FFFFFF');
  });

  it('grows each ring radius with its offset so the corners stay concentric', () => {
    const geometry = resolveBorderGeometry(
      1000,
      500,
      makeBorder({ layers: [layer('#FFFFFF', 10), layer('#000000', 6)], radiusPercent: 4 })
    );

    // 短边 500 → 基础半径 20；外扩 50 / 80 后各加回去
    expect(geometry.radiusPx).toBe(20);
    expect(geometry.rings.map((ring) => ring.radiusPx)).toEqual([70, 100]);
  });

  it('letterboxes only the deficit axis when 补边留白 is 0 (and uses the layer-expanded size as basis)', () => {
    // 1000x500 加 10% 边框 → base 1100x600，补到 1:1、留白 0 → 只补上下：
    // 上下各补 250，左右停在边框的 50。画布 1100x1100 —— 若是按原始 1000x500 算会是
    // 1000x1000，1100 同时证明补边基准取的是「加完边框」的尺寸。
    const geometry = resolveBorderGeometry(
      1000,
      500,
      makeBorder({ layers: [layer('#FFFFFF', 10)], ratioMode: '1:1' })
    );

    expect(geometry.padX).toBe(50);
    expect(geometry.padY).toBe(300);
    expect(geometry.canvasWidth).toBe(1100);
    expect(geometry.canvasHeight).toBe(1100);
  });

  it('letterboxes left and right when a taller image targets a wider ratio', () => {
    const geometry = resolveBorderGeometry(500, 1000, makeBorder({ ratioMode: '16:9' }));

    // 留白 0 → 次方向（上下）不补，只往左右补到刚好 16:9。
    expect(geometry.padY).toBe(0);
    expect(geometry.padX).toBe(639);
    expect(geometry.canvasWidth / geometry.canvasHeight).toBeCloseTo(16 / 9, 2);
  });

  it('keeps a balanced margin on all four sides while still hitting the exact ratio', () => {
    // 1000x500，留白 20%（短边 500 → 四边各至少 100px），目标 1:1：
    // 先四边补 100 → 1200x700，再只补上下到刚好 1:1 → 画布 1200x1200。
    // 左右（次方向）稳定停在 minPad=100，上下（主方向）继续长 —— 四边都有、且不贴边。
    const geometry = resolveBorderGeometry(
      1000,
      500,
      makeBorder({ ratioMode: '1:1', padPercent: 20 })
    );

    expect(geometry.padX).toBe(100);
    expect(geometry.padY).toBe(350);
    expect(geometry.canvasWidth).toBe(1200);
    expect(geometry.canvasHeight).toBe(1200);
    expect(geometry.canvasWidth / geometry.canvasHeight).toBeCloseTo(1, 5);
  });

  it('shows a visible margin on all four sides when 补边留白 > 0', () => {
    const wide = resolveBorderGeometry(1200, 800, makeBorder({ ratioMode: '16:9', padPercent: 10 }));
    expect(wide.padX).toBeGreaterThan(0);
    expect(wide.padY).toBeGreaterThan(0);
    expect(wide.canvasWidth / wide.canvasHeight).toBeCloseTo(16 / 9, 2);

    const tall = resolveBorderGeometry(1200, 800, makeBorder({ ratioMode: '4:3', padPercent: 10 }));
    expect(tall.padX).toBeGreaterThan(0);
    expect(tall.padY).toBeGreaterThan(0);
    expect(tall.canvasWidth / tall.canvasHeight).toBeCloseTo(4 / 3, 2);
  });

  it('adds an even margin on all four sides when 补边留白 is on but no target ratio is set', () => {
    // 没有目标比例时，留白就是「四边各补这么多」，不强凑任何比例。
    // 1000x500，留白 10%（短边 500 → 50）：画布 1100x600。
    const geometry = resolveBorderGeometry(1000, 500, makeBorder({ ratioMode: 'none', padPercent: 10 }));

    expect(geometry.padX).toBe(50);
    expect(geometry.padY).toBe(50);
    expect(geometry.canvasWidth).toBe(1100);
    expect(geometry.canvasHeight).toBe(600);
  });

  it('is a no-op when the ratio already matches', () => {
    const geometry = resolveBorderGeometry(1600, 900, makeBorder({ ratioMode: '16:9' }));

    expect(geometry.padX).toBe(0);
    expect(geometry.padY).toBe(0);
  });

  it('never lets the corner radius exceed half of the short side', () => {
    const geometry = resolveBorderGeometry(100, 100, makeBorder({ radiusPercent: 50 }));
    expect(geometry.radiusPx).toBe(50);

    const extreme = resolveBorderGeometry(100, 100, makeBorder({ radiusPercent: 100 }));
    expect(extreme.radiusPx).toBe(50);
  });

  it('keeps the inside stroke from changing the canvas size', () => {
    const geometry = resolveBorderGeometry(800, 600, makeBorder({ strokePercent: 5 }));

    expect(geometry.strokePx).toBe(30);
    expect(geometry.canvasWidth).toBe(800);
    expect(geometry.canvasHeight).toBe(600);
  });
});

describe('isBorderNoop', () => {
  it('detects a border with nothing switched on so the pipeline can skip re-encoding', () => {
    expect(isBorderNoop(resolveBorderGeometry(800, 600, makeBorder()))).toBe(true);
    expect(
      isBorderNoop(resolveBorderGeometry(800, 600, makeBorder({ layers: [layer('#FFFFFF', 0)] })))
    ).toBe(true);
    expect(
      isBorderNoop(resolveBorderGeometry(800, 600, makeBorder({ layers: [layer('#FFFFFF', 2)] })))
    ).toBe(false);
    expect(isBorderNoop(resolveBorderGeometry(800, 600, makeBorder({ strokePercent: 2 })))).toBe(false);
    expect(isBorderNoop(resolveBorderGeometry(800, 600, makeBorder({ radiusPercent: 2 })))).toBe(false);
  });
});

describe('describeAspectRatio', () => {
  it('reduces common ratios', () => {
    expect(describeAspectRatio(1080, 1080)).toBe('1:1');
    expect(describeAspectRatio(1920, 1080)).toBe('16:9');
  });

  it('falls back to a decimal for ratios that do not reduce nicely', () => {
    expect(describeAspectRatio(1081, 1000)).toBe('1.081:1');
  });
});
