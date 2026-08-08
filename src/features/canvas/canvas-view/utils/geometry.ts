import type { CanvasMarqueeRect, PreviewConnectionLine } from '../types';

export function createAssetPanelAnchorRect(x: number, y: number): DOMRect {
  if (typeof DOMRect !== 'undefined') {
    return new DOMRect(x, y, 0, 0);
  }
  return {
    x,
    y,
    left: x,
    right: x,
    top: y,
    bottom: y,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

export function normalizeClientRect(
  startClientX: number,
  startClientY: number,
  currentClientX: number,
  currentClientY: number,
  containerRect: DOMRect
): CanvasMarqueeRect {
  const minClientX = Math.min(startClientX, currentClientX);
  const minClientY = Math.min(startClientY, currentClientY);
  const maxClientX = Math.max(startClientX, currentClientX);
  const maxClientY = Math.max(startClientY, currentClientY);
  return {
    left: minClientX - containerRect.left,
    top: minClientY - containerRect.top,
    width: maxClientX - minClientX,
    height: maxClientY - minClientY,
  };
}

export function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function escapeNodeDataId(nodeId: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(nodeId);
  }
  return nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function shouldIgnoreCanvasMarqueeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  if ((target as HTMLElement).isContentEditable || target.closest('[contenteditable]')) {
    return true;
  }
  return Boolean(target.closest([
    'button',
    'input',
    'textarea',
    'select',
    'video',
    'dialog',
    '[role="dialog"]',
    '[data-canvas-no-marquee="true"]',
    '.react-flow__handle',
    '.react-flow__edgeupdater',
    '.react-flow__resize-control',
    '.react-flow__edge',
    '.react-flow__minimap',
    '.canvas-minimap',
  ].join(',')));
}

export function getCanvasNodeIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const nodeElement = target.closest<HTMLElement>('.react-flow__node[data-id]');
  return nodeElement?.dataset.id ?? null;
}

export function getSelectedCanvasText(container: HTMLElement | null): string {
  if (!container) {
    return '';
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return '';
  }
  const selectedText = selection.toString().trim();
  if (!selectedText) {
    return '';
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (container.contains(range.commonAncestorContainer)) {
      return selectedText;
    }
  }
  if (
    (selection.anchorNode && container.contains(selection.anchorNode))
    || (selection.focusNode && container.contains(selection.focusNode))
  ) {
    return selectedText;
  }
  return '';
}

export function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }
  return { x: touch.clientX, y: touch.clientY };
}
export function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;
  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}