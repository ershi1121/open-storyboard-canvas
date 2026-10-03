import {
  resolveAutoCropContentRect,
  resolveColorTrimInsets,
  rgbToHex,
  scaleTrimInsets,
  type CropRect,
  type TrimInsets,
} from './trim';
import type { AutoCropOptions } from './types';

/**
 * DOM 层：把一张已经加载好的图变成「内容边界」。
 *
 * 刻意只收 `HTMLImageElement`，自己不去加载图 ——
 * 加载各调用方本来就有（裁剪面板手上有 imgRef，出图链路上有 loadImageElement），
 * 而且 imageData 属于 application 层，tools 反向依赖它会形成环。
 */

/**
 * 检测分辨率上限。
 *
 * 检测只是为了「找到那条边」，1024 早已足够；全尺寸 ImageData 动辄几十 MB
 * （4000×4000 = 64MB），在面板里还要随参数变化重算，必须缩。
 * ⚠️ 预览和出图必须用**同一个**上限，否则缩图比例不同、取整不同，两边会差一两像素。
 */
export const AUTO_CROP_DETECT_MAX_DIMENSION = 1024;

export interface AutoCropDetection {
  /** 原图像素空间的四边裁剪量 */
  insets: TrimInsets;
  /** 原图像素空间的内容矩形（已含「保留边距」） */
  contentRect: CropRect;
  /**
   * 左上角那个像素的颜色。
   *
   * 用途只有一个：**四边一个像素都没裁到的时候告诉用户「你的背景其实是什么颜色」**。
   * 「识别色选错了」是这一步最可能的失败原因，而用户从画面上看不出差在哪，
   * 把这个数摆出来 + 一个「就用它」的按钮，问题当场自解。
   */
  cornerColor: string;
  naturalWidth: number;
  naturalHeight: number;
  /** 实际参与扫描的尺寸，调试 / 展示用 */
  detectWidth: number;
  detectHeight: number;
}

/**
 * 扫描图片，算出内容边界。
 *
 * 返回 null 的两种情况都由调用方当「检测不可用」处理（保留手动画的裁剪框）：
 *  - 图片尺寸还没就绪；
 *  - 画布被跨域图污染，`getImageData` 抛 SecurityError。
 */
export function measureAutoCrop(
  image: HTMLImageElement,
  options: AutoCropOptions,
  maxDimension = AUTO_CROP_DETECT_MAX_DIMENSION
): AutoCropDetection | null {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }

  const ratio = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const detectWidth = Math.max(1, Math.round(naturalWidth * ratio));
  const detectHeight = Math.max(1, Math.round(naturalHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = detectWidth;
  canvas.height = detectHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, detectWidth, detectHeight);

  let snapshot: ImageData;
  try {
    snapshot = context.getImageData(0, 0, detectWidth, detectHeight);
  } catch {
    // 跨域图会把 canvas 标记为 tainted，读像素直接抛异常。
    return null;
  }

  const detectInsets = resolveColorTrimInsets(snapshot.data, detectWidth, detectHeight, {
    color: options.color,
    edges: options.edges,
  });

  const insets = scaleTrimInsets(
    detectInsets,
    naturalWidth / detectWidth,
    naturalHeight / detectHeight
  );

  const paddingPx = Math.round(
    (Math.min(naturalWidth, naturalHeight) * Math.max(0, options.paddingPercent)) / 100
  );

  return {
    insets,
    contentRect: resolveAutoCropContentRect(insets, naturalWidth, naturalHeight, paddingPx),
    cornerColor: rgbToHex(snapshot.data[0], snapshot.data[1], snapshot.data[2]),
    naturalWidth,
    naturalHeight,
    detectWidth,
    detectHeight,
  };
}
