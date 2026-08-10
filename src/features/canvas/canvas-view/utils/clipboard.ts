import { copyImageSourceToClipboard, readSystemClipboard } from '@/commands/image';
import {
  isAudioFile,
  isImageFile,
  isVideoFile,
} from '@/features/canvas/application/imageDragDrop';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { getGeneratedTextForConnection } from './node-helpers';
import type {
  BrowserClipboardMediaReadResult,
  BrowserClipboardTextReadResult,
  CanvasClipboardSnapshot,
  ClipboardContentReadResult,
  ReadClipboardContentOptions,
} from '../types';

export function hashBytes(bytes: ArrayLike<number>): string {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function resolveMediaFingerprintKind(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (isImageFile(file)) return 'image';
  if (isVideoFile(file)) return 'video';
  if (isAudioFile(file)) return 'audio';
  return 'file';
}

export async function fingerprintMediaFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `${resolveMediaFingerprintKind(file)}:${file.type || 'application/octet-stream'}:${bytes.byteLength}:${hashBytes(bytes)}`;
}

export async function fingerprintImageFile(file: File): Promise<string> {
  return fingerprintMediaFile(file);
}

export function fingerprintClipboardContent(content: {
  image?: { bytes: ArrayLike<number>; mimeType?: string | null } | null;
  text?: string | null;
}): string | null {
  const image = content.image;
  if (image) {
    return `image:${image.mimeType || 'application/octet-stream'}:${image.bytes.length}:${hashBytes(image.bytes)}`;
  }
  const text = content.text?.trim();
  if (text) {
    return `text:${text.length}:${hashText(text)}`;
  }
  return null;
}

export function createClipboardFile(
  blob: Blob,
  mimeType: string,
  fallbackKind: 'image' | 'video' | 'audio'
): File {
  const subtype = mimeType.split('/')[1]?.split('+')[0] || (
    fallbackKind === 'image' ? 'png' : fallbackKind === 'video' ? 'mp4' : 'mp3'
  );
  return new File([blob], `pasted-${fallbackKind}.${subtype}`, {
    type: blob.type || mimeType,
    lastModified: Date.now(),
  });
}

export async function readBrowserClipboardMediaFile(): Promise<BrowserClipboardMediaReadResult> {
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>;
  };
  if (typeof clipboard?.read !== 'function') {
    return { file: null, readFailed: false };
  }
  try {
    const items = await clipboard.read();
    const mediaPrefixes = ['image/', 'video/', 'audio/'] as const;
    for (const prefix of mediaPrefixes) {
      for (const item of items) {
        const mediaType = item.types.find((type) => type.startsWith(prefix));
        if (!mediaType) {
          continue;
        }
        const blob = await item.getType(mediaType);
        const kind = prefix.slice(0, -1) as 'image' | 'video' | 'audio';
        return {
          file: createClipboardFile(blob, blob.type || mediaType, kind),
          readFailed: false,
        };
      }
    }
  } catch (error) {
    console.warn('Failed to read media from clipboard', error);
    return { file: null, readFailed: true };
  }
  return { file: null, readFailed: false };
}

export async function readBrowserClipboardText(): Promise<BrowserClipboardTextReadResult> {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    return { text: '', readFailed: false };
  }
  try {
    return { text: await navigator.clipboard.readText(), readFailed: false };
  } catch (error) {
    console.warn('Failed to read text from clipboard', error);
    return { text: '', readFailed: true };
  }
}

export function emptyClipboardContent(readFailed = false): ClipboardContentReadResult {
  return {
    mediaFile: null,
    imageFile: null,
    text: '',
    fingerprint: null,
    readFailed,
  };
}

export async function readBrowserClipboardContent(): Promise<ClipboardContentReadResult> {
  const mediaRead = await readBrowserClipboardMediaFile();
  const textRead = await readBrowserClipboardText();
  const mediaFile = mediaRead.file;
  return {
    mediaFile,
    imageFile: isImageFile(mediaFile) ? mediaFile : null,
    text: textRead.text,
    fingerprint: mediaFile
      ? await fingerprintMediaFile(mediaFile)
      : fingerprintClipboardContent({ text: textRead.text }),
    readFailed: mediaRead.readFailed || textRead.readFailed,
  };
}

export async function readTauriClipboardContent(): Promise<ClipboardContentReadResult | null> {
  try {
    const systemClipboard = await readSystemClipboard();
    if (systemClipboard) {
      const image = systemClipboard.image;
      const imageFile = image
        ? new File([new Uint8Array(image.bytes)], image.fileName || 'pasted-image.png', {
            type: image.mimeType || 'image/png',
            lastModified: Date.now(),
          })
        : null;
      return {
        mediaFile: imageFile,
        imageFile,
        text: systemClipboard.text ?? '',
        fingerprint: fingerprintClipboardContent(systemClipboard),
      };
    }
  } catch (error) {
    console.warn('Failed to read system clipboard via Tauri', error);
    return emptyClipboardContent(true);
  }
  return null;
}

export function hasClipboardPayload(content: ClipboardContentReadResult): boolean {
  return Boolean(content.mediaFile || content.imageFile || content.text.trim() || content.fingerprint);
}

export async function readClipboardContent(
  options: ReadClipboardContentOptions = {}
): Promise<ClipboardContentReadResult> {
  if (options.avoidBrowserApiWhenTauriAvailable) {
    const tauriClipboard = await readTauriClipboardContent();
    if (tauriClipboard) {
      return tauriClipboard;
    }
    return await readBrowserClipboardContent();
  }
  if (options.preferBrowserApi) {
    const browserClipboard = await readBrowserClipboardContent();
    if (hasClipboardPayload(browserClipboard)) {
      return browserClipboard;
    }
    const tauriClipboard = await readTauriClipboardContent();
    if (tauriClipboard && hasClipboardPayload(tauriClipboard)) {
      return {
        ...tauriClipboard,
        readFailed: tauriClipboard.readFailed || browserClipboard.readFailed,
      };
    }
    return tauriClipboard
      ? { ...tauriClipboard, readFailed: tauriClipboard.readFailed || browserClipboard.readFailed }
      : browserClipboard;
  }
  const tauriClipboard = await readTauriClipboardContent();
  if (tauriClipboard && hasClipboardPayload(tauriClipboard)) {
    return tauriClipboard;
  }
  const browserClipboard = await readBrowserClipboardContent();
  if (hasClipboardPayload(browserClipboard)) {
    return browserClipboard;
  }
  return tauriClipboard
    ? { ...tauriClipboard, readFailed: tauriClipboard.readFailed || browserClipboard.readFailed }
    : browserClipboard;
}

export async function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Failed to copy text');
  }
}

export function resolveNodeImageClipboardSource(node: CanvasNode): string {
  if (
    node.type !== CANVAS_NODE_TYPES.upload
    && node.type !== CANVAS_NODE_TYPES.imageEdit
    && node.type !== CANVAS_NODE_TYPES.exportImage
  ) {
    return '';
  }
  const data = node.data as { imageUrl?: unknown; previewImageUrl?: unknown };
  return (
    (typeof data.imageUrl === 'string' && data.imageUrl.trim())
    || (typeof data.previewImageUrl === 'string' && data.previewImageUrl.trim())
    || ''
  );
}

export function resolveNodeTextClipboardContent(node: CanvasNode, nodes: CanvasNode[]): string {
  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation
    || node.type === CANVAS_NODE_TYPES.jsonCard
    || node.type === CANVAS_NODE_TYPES.aiText
  ) {
    return getGeneratedTextForConnection(node, nodes);
  }
  if (node.type === CANVAS_NODE_TYPES.aiVideo || node.type === CANVAS_NODE_TYPES.imageEdit) {
    const prompt = (node.data as { prompt?: unknown }).prompt;
    return typeof prompt === 'string' ? prompt.trim() : '';
  }
  if (node.type === CANVAS_NODE_TYPES.video) {
    const data = node.data as { localVideoUrl?: unknown; videoUrl?: unknown };
    return (
      (typeof data.localVideoUrl === 'string' && data.localVideoUrl.trim())
      || (typeof data.videoUrl === 'string' && data.videoUrl.trim())
      || ''
    );
  }
  return '';
}

export async function syncSingleCanvasNodeToSystemClipboard(
  snapshot: CanvasClipboardSnapshot | null,
  allNodes: CanvasNode[]
): Promise<string | null> {
  if (!snapshot || snapshot.nodes.length !== 1) {
    return (await readClipboardContent()).fingerprint;
  }
  const [node] = snapshot.nodes;
  const imageSource = resolveNodeImageClipboardSource(node);
  try {
    if (imageSource) {
      await copyImageSourceToClipboard(imageSource);
      return (await readClipboardContent()).fingerprint;
    }
    const text = resolveNodeTextClipboardContent(node, allNodes);
    if (text) {
      await writeTextToClipboard(text);
      return (await readClipboardContent()).fingerprint;
    }
  } catch (error) {
    console.warn('Failed to sync canvas copy into system clipboard', error);
  }
  return (await readClipboardContent()).fingerprint;
}