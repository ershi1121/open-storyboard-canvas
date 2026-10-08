import { isAudioFile, isImageFile, isVideoFile } from './imageDragDrop';

/**
 * 剪贴板图片解析工具（从原 useCanvasShortcuts 中提取的纯函数，
 * 由节点编辑组件与画布粘贴流程继续使用）。
 */
export function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }
  return null;
}

/**
 * 从粘贴事件解析媒体文件（图片优先，其次视频、音频）。
 * 无名文件按 MIME 生成 pasted-<kind>.<ext> 文件名。
 */
export function resolveClipboardMediaFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  const candidates: File[] = [];
  for (const item of Array.from(clipboardItems)) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      candidates.push(file);
      continue;
    }

    const kind = item.type.startsWith('video/')
      ? 'video'
      : item.type.startsWith('audio/')
        ? 'audio'
        : 'image';
    const subtype =
      item.type.split('/')[1]?.split('+')[0] ||
      (kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3');
    candidates.push(
      new File([file], `pasted-${kind}.${subtype}`, {
        type: file.type || item.type,
        lastModified: Date.now(),
      }),
    );
  }

  return (
    candidates.find(isImageFile) ||
    candidates.find(isVideoFile) ||
    candidates.find(isAudioFile) ||
    null
  );
}
