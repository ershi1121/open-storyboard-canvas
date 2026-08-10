import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

interface EdgePanGesture {
  active: boolean;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startViewportX: number;
  startViewportY: number;
  zoom: number;
  moved: boolean;
}

interface UseEdgePanOptions {
  wrapperRef: { current: HTMLDivElement | null };
  isRestoringCanvasRef: { current: boolean };
  suppressNextEdgeClickRef: { current: boolean };
}

export function useEdgePan({
  wrapperRef,
  isRestoringCanvasRef,
  suppressNextEdgeClickRef,
}: UseEdgePanOptions): void {
  const reactFlowInstance = useReactFlow();
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore((state) => state.cancelPendingViewportPersist);
  const edgePanGestureRef = useRef<EdgePanGesture | null>(null);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }
    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }
      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }
      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }
      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;
      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }
      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }
      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }
      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    isRestoringCanvasRef,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
    suppressNextEdgeClickRef,
    wrapperRef,
  ]);
}