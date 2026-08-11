import { useEffect, useRef, useState } from 'react';
import type { CanvasMouseBindings } from '@/stores/settingsStore';
import {
  CANVAS_MARQUEE_MIN_DISTANCE,
  SUPPRESS_PANE_CLICK_AFTER_MARQUEE_MS,
  getCanvasMouseAction,
  isCanvasMouseButton,
} from '../constants';
import type { CanvasMarqueeGesture, CanvasMarqueeRect } from '../types';
import {
  getCanvasNodeIdFromTarget,
  normalizeClientRect,
  shouldIgnoreCanvasMarqueeTarget,
} from '../utils/geometry';

interface UseMarqueeSelectionOptions {
  wrapperRef: { current: HTMLDivElement | null };
  canvasMouseBindings: CanvasMouseBindings;
  selectNodesInMarquee: (gesture: CanvasMarqueeGesture) => string[];
  openNodeContextMenuAtClientPosition: (nodeId: string, clientX: number, clientY: number) => void;
  clearOverlays: () => void;
  suppressPaneClickUntilRef: { current: number };
  suppressNextMarqueeSelectionClearRef: { current: boolean };
}

export function useMarqueeSelection({
  wrapperRef,
  canvasMouseBindings,
  selectNodesInMarquee,
  openNodeContextMenuAtClientPosition,
  clearOverlays,
  suppressPaneClickUntilRef,
  suppressNextMarqueeSelectionClearRef,
}: UseMarqueeSelectionOptions): { marqueeRect: CanvasMarqueeRect | null } {
  const marqueeGestureRef = useRef<CanvasMarqueeGesture | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<CanvasMarqueeRect | null>(null);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const clearMarqueeGesture = () => {
      const gesture = marqueeGestureRef.current;
      if (gesture) {
        try {
          wrapperElement.releasePointerCapture(gesture.pointerId);
        } catch {
          // Pointer capture can already be released by the browser.
        }
      }
      marqueeGestureRef.current = null;
      setMarqueeRect(null);
    };

    const handlePointerDown = (event: PointerEvent) => {
      // 🚀 Ctrl/Meta + 左键 也启动自定义选框（与右键拖拽同款），
      // 胶囊是 selectable:false，RF 内置选框看不见它，必须走自定义选框才能选中/打组
      const isCtrlMarquee = event.button === 0 && (event.ctrlKey || event.metaKey);
      if (
        !isCanvasMouseButton(event.button) ||
        (getCanvasMouseAction(canvasMouseBindings, event.button, 'drag') !== 'selectionBox' &&
          !isCtrlMarquee) ||
        shouldIgnoreCanvasMarqueeTarget(event.target)
      ) {
        return;
      }
      const startNodeId = getCanvasNodeIdFromTarget(event.target);
      if (event.button === 0 && startNodeId) {
        return;
      }
      if (event.button !== 0 || isCtrlMarquee) {
        event.preventDefault();
        event.stopPropagation();
        try {
          wrapperElement.setPointerCapture(event.pointerId);
        } catch {
          // Some WebViews may reject capture if the pointer has already been claimed.
        }
      }
      marqueeGestureRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        moved: false,
        startNodeId,
      };
      clearOverlays();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = marqueeGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      gesture.currentClientX = event.clientX;
      gesture.currentClientY = event.clientY;
      const dragDistance = Math.hypot(
        gesture.currentClientX - gesture.startClientX,
        gesture.currentClientY - gesture.startClientY
      );
      if (!gesture.moved) {
        if (dragDistance < CANVAS_MARQUEE_MIN_DISTANCE) {
          return;
        }
        gesture.moved = true;
        try {
          wrapperElement.setPointerCapture(gesture.pointerId);
        } catch {
          // Pointer capture is best-effort; window listeners still receive the gesture.
        }
      }
      event.preventDefault();
      event.stopPropagation();
      const containerRect = wrapperElement.getBoundingClientRect();
      setMarqueeRect(normalizeClientRect(
        gesture.startClientX,
        gesture.startClientY,
        gesture.currentClientX,
        gesture.currentClientY,
        containerRect
      ));
    };

    const completeMarqueeGesture = (
      event: PointerEvent | MouseEvent,
      options: { allowSelectionOnCancel?: boolean } = {}
    ) => {
      const gesture = marqueeGestureRef.current;
      if (!gesture || ('pointerId' in event && event.pointerId !== gesture.pointerId)) {
        return;
      }
      gesture.currentClientX = event.clientX;
      gesture.currentClientY = event.clientY;
      const shouldSelectMarquee = gesture.moved && options.allowSelectionOnCancel !== false;
      const shouldOpenNodeMenu =
        !shouldSelectMarquee &&
        Boolean(gesture.startNodeId) &&
        getCanvasMouseAction(canvasMouseBindings, gesture.button, 'click') === 'nodeMenu';
      if (!shouldSelectMarquee && !shouldOpenNodeMenu) {
        clearMarqueeGesture();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (shouldSelectMarquee) {
        const nextSelectedIds = selectNodesInMarquee(gesture);
        if (gesture.button === 0) {
          suppressPaneClickUntilRef.current = Date.now() + SUPPRESS_PANE_CLICK_AFTER_MARQUEE_MS;
          if (nextSelectedIds.length > 0) {
            suppressNextMarqueeSelectionClearRef.current = true;
            window.setTimeout(() => {
              suppressNextMarqueeSelectionClearRef.current = false;
            }, 120);
          }
        }
      } else if (gesture.startNodeId) {
        openNodeContextMenuAtClientPosition(gesture.startNodeId, event.clientX, event.clientY);
      }
      clearMarqueeGesture();
    };

    const handlePointerUp = (event: PointerEvent) => {
      completeMarqueeGesture(event);
    };
    const handleMouseUp = (event: MouseEvent) => {
      completeMarqueeGesture(event);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      completeMarqueeGesture(event);
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    canvasMouseBindings,
    clearOverlays,
    openNodeContextMenuAtClientPosition,
    selectNodesInMarquee,
    suppressNextMarqueeSelectionClearRef,
    suppressPaneClickUntilRef,
    wrapperRef,
  ]);

  return { marqueeRect };
}