import type { HandleType } from '@/features/canvas/domain/graphTypes';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

/** 画布层共享类型（自旧版 canvas-view/types.ts 迁移保留的子集） */

export interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: { x: number; y: number };
}

export interface NodeContextMenuState {
  nodeId: string | null;
  position: { x: number; y: number };
  worldPosition: { x: number; y: number };
  selectedText?: string;
}

export interface CanvasClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/* ---------------- 系统剪贴板 ---------------- */

export type ClipboardFreshnessSource = 'internal' | 'system' | null;

export interface ClipboardContentReadResult {
  mediaFile: File | null;
  imageFile: File | null;
  text: string;
  fingerprint: string | null;
  readFailed?: boolean;
}

export type ClipboardPasteSource =
  | { source: 'internal' }
  | { source: 'system'; content: ClipboardContentReadResult }
  | { source: 'none' };

export interface SystemClipboardPasteOptions {
  targetNode: CanvasNode | null;
  worldPosition?: { x: number; y: number };
  pasteIntoSelectedUpload?: boolean;
}

export interface BrowserClipboardMediaReadResult {
  file: File | null;
  readFailed: boolean;
}

export interface BrowserClipboardTextReadResult {
  text: string;
  readFailed: boolean;
}

export interface ReadClipboardContentOptions {
  preferBrowserApi?: boolean;
  avoidBrowserApiWhenTauriAvailable?: boolean;
}
