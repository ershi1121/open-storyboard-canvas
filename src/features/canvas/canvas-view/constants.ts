import type { Viewport } from '@xyflow/react';
import type { CanvasMouseBindings, CanvasMouseAction, CanvasMouseBindingSlot } from '@/stores/settingsStore';
import type { CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
export const CANVAS_MARQUEE_MIN_DISTANCE = 4;
export const ALT_DRAG_COPY_Z_INDEX = 2000;
export const BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_MS = 450;
export const BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_DISTANCE = 8;
export const SUPPRESS_PANE_CLICK_AFTER_MARQUEE_MS = 120;
export const SUPPRESS_PANE_CLICK_AFTER_CONNECT_MS = 200;

export const EMPTY_CANVAS_ASSETS: CanvasAssetItem[] = [];

export const CANVAS_BATCH_TRIGGER_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.tag,
]);

export const CANVAS_MOUSE_BUTTONS = [0, 1, 2] as const;
export type CanvasMouseButton = typeof CANVAS_MOUSE_BUTTONS[number];

export const CLICK_SLOT_BY_BUTTON: Record<CanvasMouseButton, CanvasMouseBindingSlot> = {
  0: 'leftClick',
  1: 'middleClick',
  2: 'rightClick',
};

export const DRAG_SLOT_BY_BUTTON: Record<CanvasMouseButton, CanvasMouseBindingSlot> = {
  0: 'leftDrag',
  1: 'middleDrag',
  2: 'rightDrag',
};

export function isCanvasMouseButton(button: number): button is CanvasMouseButton {
  return button === 0 || button === 1 || button === 2;
}

export function getCanvasMouseAction(
  bindings: CanvasMouseBindings,
  button: number,
  gesture: 'click' | 'drag'
): CanvasMouseAction {
  if (!isCanvasMouseButton(button)) {
    return 'none';
  }
  return bindings[gesture === 'click' ? CLICK_SLOT_BY_BUTTON[button] : DRAG_SLOT_BY_BUTTON[button]];
}