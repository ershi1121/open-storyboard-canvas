import type { BorderGeometry } from './types';

/** 圆角矩形路径。radius <= 0 时退化成普通矩形。 */
export function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const resolvedRadius = Math.max(0, Math.min(radius, Math.min(width, height) / 2));

  context.beginPath();

  if (resolvedRadius <= 0) {
    context.rect(x, y, width, height);
    return;
  }

  context.moveTo(x + resolvedRadius, y);
  context.lineTo(x + width - resolvedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + resolvedRadius);
  context.lineTo(x + width, y + height - resolvedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - resolvedRadius, y + height);
  context.lineTo(x + resolvedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - resolvedRadius);
  context.lineTo(x, y + resolvedRadius);
  context.quadraticCurveTo(x, y, x + resolvedRadius, y);
  context.closePath();
}

/**
 * 把图片画成带（多层）边框的结果：
 *   1. 整块画布铺满最外层颜色 —— 按比例补出来的那一圈靠它显色；
 *   2. 各层从外向内依次画同心圆角矩形，内层覆盖外层，
 *      于是每层只剩自己那一圈可见（这就是「多层边框」）；
 *   3. 图片按圆角裁切后落在最内层里；
 *   4. 内侧描边贴着图片边缘往内画一圈（线宽取两倍再靠 clip 砍掉外半圈），
 *      所以描边不会改变画布尺寸，只是把边框「吃」进图片一点。
 *      描边颜色取最内层，也就是紧挨着图片的那一圈。
 *
 * 调用方负责先把 canvas 设成 geometry.canvasWidth × geometry.canvasHeight。
 */
export function drawImageWithBorder(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  geometry: BorderGeometry
): void {
  const {
    canvasWidth,
    canvasHeight,
    imageWidth,
    imageHeight,
    padX,
    padY,
    strokePx,
    strokeColor,
    radiusPx,
    rings,
    fillColor,
  } = geometry;

  context.clearRect(0, 0, canvasWidth, canvasHeight);

  context.fillStyle = fillColor;
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  for (let index = rings.length - 1; index >= 0; index -= 1) {
    const ring = rings[index];
    // 宽度 0 的层什么都不画：它的矩形和下一层完全重合，
    // 画了也会被后画的层盖掉，跳过省事。
    if (ring.thicknessPx <= 0) {
      continue;
    }

    context.fillStyle = ring.color;
    roundedRectPath(
      context,
      padX - ring.outerOffsetPx,
      padY - ring.outerOffsetPx,
      imageWidth + ring.outerOffsetPx * 2,
      imageHeight + ring.outerOffsetPx * 2,
      ring.radiusPx
    );
    context.fill();
  }

  context.save();
  roundedRectPath(context, padX, padY, imageWidth, imageHeight, radiusPx);
  context.clip();

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, padX, padY, imageWidth, imageHeight);

  if (strokePx > 0) {
    context.strokeStyle = strokeColor;
    context.lineWidth = strokePx * 2;
    roundedRectPath(context, padX, padY, imageWidth, imageHeight, radiusPx);
    context.stroke();
  }

  context.restore();
}
