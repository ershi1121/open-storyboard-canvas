import { useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Connection, EdgeChange, NodeChange, Viewport } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasWasdPan } from '@/features/canvas/hooks/useCanvasWasdPan';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import type { PendingConnectStart } from '../types';
import {
  canNodeBeManualConnectionSource,
  getGeneratedTextForConnection,
} from '../utils/node-helpers';

interface UseCanvasFlowHandlersOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodes: CanvasNode[];
  pendingConnectStart: PendingConnectStart | null;
  suppressNextMarqueeSelectionClearRef: { current: boolean };
  suppressNextEdgeClickRef: { current: boolean };
  isRestoringCanvasRef: { current: boolean };
  scheduleCanvasPersist: (delay?: number) => void;
  cancelPendingViewportPersist: () => void;
}

export function useCanvasFlowHandlers({
  wrapperRef,
  nodes,
  pendingConnectStart,
  suppressNextMarqueeSelectionClearRef,
  suppressNextEdgeClickRef,
  isRestoringCanvasRef,
  scheduleCanvasPersist,
  cancelPendingViewportPersist,
}: UseCanvasFlowHandlersOptions) {
  const reactFlowInstance = useReactFlow();
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const enableCanvasWasdPan = useSettingsStore((state) => state.enableCanvasWasdPan);
  const canvasWasdPanSensitivity = useSettingsStore((state) => state.canvasWasdPanSensitivity);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      if (pendingConnectStart && changes.every((change) => change.type === 'select')) {
        return;
      }
      if (
        suppressNextMarqueeSelectionClearRef.current &&
        changes.length > 0 &&
        changes.every((change) => change.type === 'select' && change.selected === false)
      ) {
        suppressNextMarqueeSelectionClearRef.current = false;
        return;
      }
      applyNodesChange(changes);
      const hasDragMove = changes.some(
        (change) => change.type === 'position' && 'dragging' in change && Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) => change.type === 'position' && 'dragging' in change && change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) => change.type === 'dimensions' && 'resizing' in change && Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) => change.type === 'dimensions' && 'resizing' in change && change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;
      if (hasInteractionMove) {
        return;
      }
      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }
      scheduleCanvasPersist();
    },
    [applyNodesChange, pendingConnectStart, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, [suppressNextEdgeClickRef]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes)) {
        return;
      }
      connectNodes(connection);
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (sourceNode && targetNode?.type === CANVAS_NODE_TYPES.textAnnotation) {
        const sourceText = getGeneratedTextForConnection(sourceNode, nodes);
        if (sourceText) {
          const currentContent = (targetNode.data as { content?: unknown }).content;
          const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
          updateNodeData(targetNode.id, {
            content: normalizedCurrent ? `${normalizedCurrent}\n${sourceText}` : sourceText,
          } as Partial<CanvasNodeData>);
        }
      }
      scheduleCanvasPersist(0);
    },
    [connectNodes, nodes, scheduleCanvasPersist, updateNodeData]
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, isRestoringCanvasRef, saveCurrentProjectViewport, setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {
    cancelPendingViewportPersist();
  }, [cancelPendingViewportPersist]);

  const handleWasdPanEnd = useCallback(
    (viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, isRestoringCanvasRef, saveCurrentProjectViewport, setViewportState]
  );

  useCanvasWasdPan({
    wrapperRef,
    enabled: enableCanvasWasdPan,
    sensitivity: canvasWasdPanSensitivity,
    reactFlowInstance,
    onPanStart: cancelPendingViewportPersist,
    onViewportChange: setViewportState,
    onPanEnd: handleWasdPanEnd,
  });

  return {
    handleNodesChange,
    handleEdgesChange,
    handleEdgeDoubleClick,
    handleEdgeClick,
    handleConnect,
    handleMove,
    handleMoveStart,
    handleMoveEnd,
  };
}