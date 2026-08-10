import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { FinalConnectionState, OnConnectStartParams } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { nodeHasSourceHandle, nodeHasTargetHandle } from '@/features/canvas/domain/nodeRegistry';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { SUPPRESS_PANE_CLICK_AFTER_CONNECT_MS } from '../constants';
import type {
  NodeContextMenuState,
  PendingConnectStart,
  PreviewConnectionVisual,
} from '../types';
import { createPreviewPath, getClientPosition } from '../utils/geometry';
import {
  canNodeBeManualConnectionSource,
  canNodeTypeBeManualConnectionSource,
  getGeneratedTextForConnection,
  resolveAllowedNodeTypes,
} from '../utils/node-helpers';

interface UseConnectFlowOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodes: CanvasNode[];
  lastCanvasPointerRef: { current: { x: number; y: number } | null };
  suppressPaneClickUntilRef: { current: number };
  scheduleCanvasPersist: (delay?: number) => void;
  setShowNodeMenu: (show: boolean) => void;
  setNodeContextMenu: (state: NodeContextMenuState | null) => void;
  setMenuAllowedTypes: (types: CanvasNodeType[] | undefined) => void;
  setMenuPosition: (position: { x: number; y: number }) => void;
  setFlowPosition: (position: { x: number; y: number }) => void;
}

export function useConnectFlow({
  wrapperRef,
  nodes,
  lastCanvasPointerRef,
  suppressPaneClickUntilRef,
  scheduleCanvasPersist,
  setShowNodeMenu,
  setNodeContextMenu,
  setMenuAllowedTypes,
  setMenuPosition,
  setFlowPosition,
}: UseConnectFlowOptions) {
  const reactFlowInstance = useReactFlow();
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(null);
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const lastConnectSelectionClearAtRef = useRef(0);
  const pendingConnectWasActiveRef = useRef(false);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      lastConnectSelectionClearAtRef.current = Date.now();
      clearBrowserTextSelection();
      setShowNodeMenu(false);
      setNodeContextMenu(null);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);
      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }
      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
      ) {
        setPendingConnectStart(null);
        return;
      }
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }
      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
    },
    [nodes, setMenuAllowedTypes, setNodeContextMenu, setShowNodeMenu, wrapperRef]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      lastConnectSelectionClearAtRef.current = 0;
      clearBrowserTextSelection();
      window.requestAnimationFrame(() => clearBrowserTextSelection());
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }
      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }
      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;
      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);
        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
          if (targetNode.type === CANVAS_NODE_TYPES.textAnnotation) {
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
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }
      const allowedTypes = resolveAllowedNodeTypes(pendingConnectStart.handleType);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }
      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;
      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }
      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }
      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressPaneClickUntilRef.current =
        Date.now() + SUPPRESS_PANE_CLICK_AFTER_CONNECT_MS;
      setShowNodeMenu(true);
    },
    [
      connectNodes,
      nodes,
      pendingConnectStart,
      reactFlowInstance,
      scheduleCanvasPersist,
      setFlowPosition,
      setMenuAllowedTypes,
      setMenuPosition,
      setShowNodeMenu,
      suppressPaneClickUntilRef,
      updateNodeData,
      wrapperRef,
    ]
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      lastCanvasPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      if (!pendingConnectStart) {
        return;
      }
      const now = Date.now();
      if (now - lastConnectSelectionClearAtRef.current < 50) {
        return;
      }
      lastConnectSelectionClearAtRef.current = now;
      clearBrowserTextSelection();
    },
    [lastCanvasPointerRef, pendingConnectStart]
  );

  useEffect(() => {
    if (pendingConnectStart) {
      pendingConnectWasActiveRef.current = true;
      return;
    }
    if (!pendingConnectWasActiveRef.current) {
      return;
    }
    pendingConnectWasActiveRef.current = false;
    lastConnectSelectionClearAtRef.current = 0;
    clearBrowserTextSelection();
    window.requestAnimationFrame(() => clearBrowserTextSelection());
  }, [pendingConnectStart]);

  return {
    pendingConnectStart,
    setPendingConnectStart,
    previewConnectionVisual,
    setPreviewConnectionVisual,
    handleConnectStart,
    handleConnectEnd,
    handleCanvasPointerMove,
  };
}