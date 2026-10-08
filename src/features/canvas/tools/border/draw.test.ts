import { describe, expect, it } from 'vitest';

import { drawImageWithBorder, roundedRectPath } from './draw';
import { resolveBorderGeometry, type BorderLayer, type BorderOptions } from './types';

interface RecordedCall {
  name: string;
  args: number[];
  /** 记录那一刻的填充 / 描边状态，用来验证每一层用的是自己那个颜色 */
  fillStyle?: string;
  strokeStyle?: string;
  lineWidth?: number;
}

/**
 * 只记录调用序列的假 canvas context。
 * 目的是锁住「先铺底色 → 各层外→内 → 裁圆角贴图 → 内侧描边」这个顺序，
 * 以及画布尺寸 / 每层矩形 / 贴图坐标 / 描边线宽是否和 geometry 一致。
 */
function createMockContext() {
  const calls: RecordedCall[] = [];
  const record = (name: string, args: unknown[]) => {
    calls.push({ name, args: args.filter((item): item is number => typeof item === 'number') });
  };

  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    clearRect: (...args: unknown[]) => record('clearRect', args),
    fillRect: (...args: unknown[]) => record('fillRect', args),
    fill: () => {
      calls.push({ name: 'fill', args: [], fillStyle: context.fillStyle });
    },
    save: () => record('save', []),
    restore: () => record('restore', []),
    beginPath: () => record('beginPath', []),
    moveTo: (...args: unknown[]) => record('moveTo', args),
    lineTo: (...args: unknown[]) => record('lineTo', args),
    quadraticCurveTo: (...args: unknown[]) => record('quadraticCurveTo', args),
    rect: (...args: unknown[]) => record('rect', args),
    closePath: () => record('closePath', []),
    clip: () => record('clip', []),
    drawImage: (...args: unknown[]) => record('drawImage', args),
    stroke: () => {
      calls.push({
        name: 'stroke',
        args: [],
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
      });
    },
  };

  return { context, calls };
}

function layer(color: string, widthPercent: number): BorderLayer {
  return { id: `${color}-${widthPercent}`, color, widthPercent };
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

const FAKE_IMAGE = { width: 100, height: 100 } as unknown as CanvasImageSource;

function findCall(calls: RecordedCall[], name: string): RecordedCall | undefined {
  return calls.find((call) => call.name === name);
}

function findCalls(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter((call) => call.name === name);
}

function draw(context: unknown, geometry: ReturnType<typeof resolveBorderGeometry>) {
  drawImageWithBorder(context as CanvasRenderingContext2D, FAKE_IMAGE, geometry);
}

describe('roundedRectPath', () => {
  it('degenerates to a plain rect when the radius is zero', () => {
    const { context, calls } = createMockContext();

    roundedRectPath(context as unknown as CanvasRenderingContext2D, 10, 20, 100, 50, 0);

    expect(findCall(calls, 'rect')).toBeDefined();
    expect(findCall(calls, 'quadraticCurveTo')).toBeUndefined();
  });

  it('uses quadratic corners when the radius is positive', () => {
    const { context, calls } = createMockContext();

    roundedRectPath(context as unknown as CanvasRenderingContext2D, 10, 20, 100, 50, 8);

    expect(findCall(calls, 'quadraticCurveTo')).toBeDefined();
    expect(findCall(calls, 'rect')).toBeUndefined();
    expect(findCalls(calls, 'quadraticCurveTo')).toHaveLength(4);
  });

  it('clamps the radius to half of the shorter side', () => {
    const { context, calls } = createMockContext();

    // height 40 → 半径最多 20；传 999 应该按 20 走
    roundedRectPath(context as unknown as CanvasRenderingContext2D, 0, 0, 200, 40, 999);

    const firstCorner = findCall(calls, 'quadraticCurveTo');
    expect(firstCorner?.args).toEqual([200, 0, 200, 20]);
  });
});

describe('drawImageWithBorder', () => {
  it('paints the whole canvas with the outermost colour before anything else', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#E24B4A', 10)] })
    );

    draw(context, geometry);

    expect(calls[0]).toEqual({ name: 'clearRect', args: [0, 0, 920, 720] });
    expect(calls[1]).toEqual({ name: 'fillRect', args: [0, 0, 920, 720] });
    // 10% 以短边 600 为基准 → 四周各 60px
    expect(context.fillStyle).toBe('#E24B4A');
  });

  it('draws the image inset by the padding at its natural size', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#FFFFFF', 10)] })
    );

    draw(context, geometry);

    expect(findCall(calls, 'drawImage')?.args).toEqual([60, 60, 800, 600]);
  });

  it('draws the image at the origin when there is no border at all', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(800, 600, makeBorder());

    draw(context, geometry);

    expect(findCall(calls, 'drawImage')?.args).toEqual([0, 0, 800, 600]);
  });

  it('paints each ring from the outside in, in its own colour', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#FFFFFF', 10), layer('#000000', 5)] })
    );

    draw(context, geometry);

    // 短边 600 → 内层 60px、外层 30px，合计外扩 90px
    const rings = findCalls(calls, 'fill');
    expect(rings.map((call) => call.fillStyle)).toEqual(['#000000', '#FFFFFF']);

    // 两层同心：圆角半径随外扩距离一起长，所以圆弧起点的 x 相同（都是 padX + 基础半径），
    // y 相差的正好是外层的厚度 —— 内层比外层内缩一层。
    const moves = findCalls(calls, 'moveTo');
    expect(moves[0].args).toEqual([90, 0]);
    expect(moves[1].args).toEqual([90, 30]);
  });

  it('skips a layer whose width is zero instead of overpainting its neighbour', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#FFFFFF', 0), layer('#000000', 5)] })
    );

    draw(context, geometry);

    expect(findCalls(calls, 'fill').map((call) => call.fillStyle)).toEqual(['#000000']);
  });

  it('doubles the stroke line width so the clip keeps only the inner half', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#378ADD', 0)], strokePercent: 5 })
    );

    draw(context, geometry);

    expect(geometry.strokePx).toBe(30);
    const stroke = findCall(calls, 'stroke');
    expect(stroke).toBeDefined();
    expect(stroke?.lineWidth).toBe(60);
    // 描边颜色取最内层，也就是贴着图片的那一圈
    expect(stroke?.strokeStyle).toBe('#378ADD');
  });

  it('skips the stroke entirely when there is no inside stroke', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ layers: [layer('#FFFFFF', 10)] })
    );

    draw(context, geometry);

    expect(findCall(calls, 'stroke')).toBeUndefined();
  });

  it('clips the image so rounded corners reveal the border colour', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(800, 600, makeBorder({ radiusPercent: 5 }));

    draw(context, geometry);

    expect(geometry.radiusPx).toBe(30);
    expect(findCall(calls, 'clip')).toBeDefined();
  });

  it('balances every save with a restore', () => {
    const { context, calls } = createMockContext();
    const geometry = resolveBorderGeometry(
      800,
      600,
      makeBorder({ radiusPercent: 5, strokePercent: 3 })
    );

    draw(context, geometry);

    expect(findCalls(calls, 'save')).toHaveLength(findCalls(calls, 'restore').length);
  });

  it('places the image inside the ratio padding when 按比例补边 is on', () => {
    const { context, calls } = createMockContext();
    // 1000x500 补到 1:1，留白滑杆为 0 → 只补「不够比例」的那一轴（上下）：
    // 主方向补 250px，画布 1000x1000（正好 1:1），图片以原尺寸落在 (padX, padY) = (0, 250)，
    // 左右贴边。想要四边都留一圈，就把「补边留白」滑杆往上推。
    const geometry = resolveBorderGeometry(1000, 500, makeBorder({ ratioMode: '1:1' }));

    draw(context, geometry);

    expect(calls[0].args).toEqual([0, 0, 1000, 1000]);
    expect(findCall(calls, 'drawImage')?.args).toEqual([0, 250, 1000, 500]);
  });
});
