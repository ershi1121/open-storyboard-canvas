import type { HandleType } from '@xyflow/react';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import type { CanvasMouseButton } from './constants';

export interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: { x: number; y: number };
}

export interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasMarqueeGesture {
  pointerId: number;
  button: CanvasMouseButton;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  moved: boolean;
  startNodeId: string | null;
}

export interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

export interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

export interface CanvasClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type ClipboardFreshnessSource = 'internal' | 'system' | null;

export interface NodeContextMenuState {
  nodeId: string | null;
  position: { x: number; y: number };
  flowPosition: { x: number; y: number };
  selectedText?: string;
}

export interface BlankCanvasRightClickState {
  timeStamp: number;
  clientX: number;
  clientY: number;
}

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
  flowPosition?: { x: number; y: number };
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

export interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}