import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureAutoCrop } from './detect';
import type { AutoCropOptions } from './types';

/**
 * `measureAutoCrop` 走的是真实 DOM 路径（createElement('canvas') →
 * drawImage → getImageData），node 环境下没有 canvas，所以这里把
 * `document.createElement` 打桩成一个能吐出构造像素的假 canvas。
 *
 * 这样能证明「识别色 → 四边裁剪量」这条链路在 DOM 边界上真的通，
 * 而不只是纯算法 `resolveColorTrimInsets` 对。
 */

function installCanvasMock(borderPx: number): void {
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') {
        return {} as unknown as HTMLCanvasElement;
      }
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {
            /* 打桩：不真的画 */
          },
          getImageData(
            _x: number,
            _y: number,
            width: number,
            height: number
          ): { data: Uint8ClampedArray; width: number; height: number } {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let yy = 0; yy < height; yy += 1) {
              for (let xx = 0; xx < width; xx += 1) {
                const inBorder =
                  xx < borderPx || xx >= width - borderPx || yy < borderPx || yy >= height - borderPx;
                const offset = (yy * width + xx) * 4;
                if (inBorder) {
                  data[offset] = 255;
                  data[offset + 1] = 255;
                  data[offset + 2] = 255;
                } else {
                  // 中心：明显的红，和识别色「白」差几百，必然会停
                  data[offset] = 220;
                  data[offset + 1] = 20;
                  data[offset + 2] = 20;
                }
                data[offset + 3] = 255;
              }
            }
            return { data, width, height };
          },
        }),
      };
      return canvas as unknown as HTMLCanvasElement;
    },
  });
}

function makeImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  return {
    naturalWidth,
    naturalHeight,
    width: naturalWidth,
    height: naturalHeight,
  } as HTMLImageElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('measureAutoCrop（DOM 边界）', () => {
  it('把四周均匀的白边向内裁掉，算出内容矩形', () => {
    installCanvasMock(20);
    const image = makeImage(200, 100);
    const options: AutoCropOptions = {
      enabled: true,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 0,
    };

    const result = measureAutoCrop(image, options);

    expect(result).not.toBeNull();
    expect(result?.insets).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
    expect(result?.contentRect).toEqual({ x: 20, y: 20, width: 160, height: 60 });
    // 左上角第一个像素是白 → 角落实色报 #FFFFFF
    expect(result?.cornerColor).toBe('#FFFFFF');
  });

  it('图里根本不是识别色时，四边一像素都不裁', () => {
    installCanvasMock(0); // 整张都是红，没有白边
    const image = makeImage(120, 80);
    const options: AutoCropOptions = {
      enabled: true,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 0,
    };

    const result = measureAutoCrop(image, options);

    expect(result).not.toBeNull();
    expect(result?.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    // 角落实色是红，正好用于「换成它」诊断
    expect(result?.cornerColor).toBe('#DC1414');
  });

  it('超过检测上限时按缩图比例换算回原图尺寸', () => {
    // 2000×1000 → 检测上限 1024 → ratio≈0.512 → 缩图边 10px → 算回 20px
    installCanvasMock(10);
    const image = makeImage(2000, 1000);
    const options: AutoCropOptions = {
      enabled: true,
      color: '#FFFFFF',
      edges: 'tblr',
      paddingPercent: 0,
    };

    const result = measureAutoCrop(image, options);

    expect(result).not.toBeNull();
    expect(result?.insets).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
  });
});
