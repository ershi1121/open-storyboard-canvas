import type { HandleType } from '@/features/canvas/domain/graphTypes';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

/** 从 canvas-view/types.ts 迁移的共享类型（React Flow 清除后保留的子集） */

export interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: { x: number; y: number };
}

export interface NodeContextMenuState {
  nodeId: string | null;
  position: { x: number; y: number };
  flowPosition: { x: number; y: number };
  selectedText?: string;
}

export interface CanvasClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
