import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';

export function getNodeDisplayTitle(node: CanvasNode, fallback: string): string {
  const data = node.data as Record<string, unknown>;
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (displayName) {
    return displayName;
  }
  const sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
  return sourceFileName || fallback;
}

export function getNodeAssetSourceLabel(node: CanvasNode): string {
  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
      return '上传图';
    case CANVAS_NODE_TYPES.imageEdit:
      return 'AI 图片';
    case CANVAS_NODE_TYPES.exportImage:
      return '结果图';
    case CANVAS_NODE_TYPES.panorama:
      return '全景图';
    case CANVAS_NODE_TYPES.storyboardSplit:
      return '故事板帧';
    case CANVAS_NODE_TYPES.storyboardGen:
      return '故事板生成图';
    case CANVAS_NODE_TYPES.video:
      return '视频';
    default:
      return '图片资产';
  }
}

export function resolveAssetPreview(
  rawImageUrl: string,
  rawPreviewImageUrl?: string | null
): { imageUrl: string; previewImageUrl: string } {
  const imageUrl = resolveImageDisplayUrl(rawImageUrl);
  return {
    imageUrl,
    previewImageUrl: resolveImageDisplayUrl(rawPreviewImageUrl || rawImageUrl),
  };
}

export function extractCanvasAssets(nodes: CanvasNode[]): CanvasAssetItem[] {
  const assets: CanvasAssetItem[] = [];
  nodes.forEach((node, nodeIndex) => {
    const data = node.data as Record<string, unknown>;
    const sourceLabel = getNodeAssetSourceLabel(node);
    const baseOrder = nodeIndex * 1000;
    const imageUrl = typeof data.imageUrl === 'string' ? data.imageUrl : '';
    if (imageUrl) {
      const previewImageUrl =
        typeof data.previewImageUrl === 'string' ? data.previewImageUrl : null;
      const resolved = resolveAssetPreview(imageUrl, previewImageUrl);
      assets.push({
        id: `${node.id}:image`,
        nodeId: node.id,
        kind: 'image',
        rawImageUrl: imageUrl,
        rawPreviewImageUrl: previewImageUrl,
        aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
        title: getNodeDisplayTitle(node, sourceLabel),
        sourceLabel,
        order: baseOrder,
        ...resolved,
      });
    }
    if (node.type === CANVAS_NODE_TYPES.video) {
      const videoUrl = typeof data.localVideoUrl === 'string' && data.localVideoUrl.trim()
        ? data.localVideoUrl
        : typeof data.videoUrl === 'string'
          ? data.videoUrl
          : '';
      if (videoUrl) {
        const thumbnailUrl =
          typeof data.thumbnailUrl === 'string' && data.thumbnailUrl.trim()
            ? data.thumbnailUrl
            : null;
        assets.push({
          id: `${node.id}:video`,
          nodeId: node.id,
          kind: 'video',
          rawVideoUrl: videoUrl,
          rawThumbnailUrl: thumbnailUrl,
          videoUrl: resolveImageDisplayUrl(videoUrl),
          thumbnailUrl: thumbnailUrl ? resolveImageDisplayUrl(thumbnailUrl) : null,
          aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
          title: getNodeDisplayTitle(node, sourceLabel),
          sourceLabel,
          order: baseOrder,
        });
      }
    }
    if (Array.isArray(data.frames)) {
      data.frames.forEach((frame, frameIndex) => {
        if (!frame || typeof frame !== 'object') {
          return;
        }
        const frameRecord = frame as Record<string, unknown>;
        const frameImageUrl =
          typeof frameRecord.imageUrl === 'string' ? frameRecord.imageUrl : '';
        if (!frameImageUrl) {
          return;
        }
        const framePreviewImageUrl =
          typeof frameRecord.previewImageUrl === 'string' ? frameRecord.previewImageUrl : null;
        const frameNote = typeof frameRecord.note === 'string' ? frameRecord.note.trim() : '';
        const frameOrder = Number.isFinite(frameRecord.order)
          ? Number(frameRecord.order)
          : frameIndex;
        assets.push({
          id: `${node.id}:frame:${String(frameRecord.id ?? frameIndex)}`,
          nodeId: node.id,
          kind: 'image',
          rawImageUrl: frameImageUrl,
          rawPreviewImageUrl: framePreviewImageUrl,
          aspectRatio: typeof frameRecord.aspectRatio === 'string'
            ? frameRecord.aspectRatio
            : undefined,
          title: frameNote || `${getNodeDisplayTitle(node, '故事板')} · 第 ${frameIndex + 1} 帧`,
          sourceLabel,
          order: baseOrder + frameOrder + 1,
          ...resolveAssetPreview(frameImageUrl, framePreviewImageUrl),
        });
      });
    }
  });
  return assets;
}