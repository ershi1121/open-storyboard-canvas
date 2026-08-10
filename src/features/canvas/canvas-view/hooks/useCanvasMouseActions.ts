import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { CanvasMouseAction } from '@/stores/settingsStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_DISTANCE,
  BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_MS,
  getCanvasMouseAction,
} from '../constants';
import type { BlankCanvasRightClickState, NodeContextMenuState } from '../types';
import {
  getCanvasNodeIdFromTarget,
  getSelectedCanvasText,
  shouldIgnoreCanvasMarqueeTarget,
} from '../utils/geometry';

interface UseCanvasMouseActionsOptions {
  wrapperRef: { current: HTMLDivElement | null };
  canvasMouseBindings: Parameters<typeof getCanvasMouseAction>[0];
  suppressPaneClickUntilRef: { current: number };
  setNodeContextMenu: (state: NodeContextMenuState | null) => void;
  clearOverlays: () => void;
  closeAssetPanel: () => void;
  selectSingleNode: (nodeId: string | null) => void;
  openContextMenuAtClientPosition: (
    nodeId: string | null,
    clientX: number,
    clientY: number,
    options?: { selectedText?: string; selectNode?: boolean }
  ) => void;
  openNodeContextMenuAtClientPosition: (
    nodeId: string,
    clientX: number,
    clientY: number,
    options?: { selectedText?: string; selectNode?: boolean }
  ) => void;
  openNodeMenuAtClientPosition: (clientX: number, clientY: number) => void;
}

export function useCanvasMouseActions({
  wrapperRef,
  canvasMouseBindings,
  suppressPaneClickUntilRef,
  setNodeContextMenu,
  clearOverlays,
  closeAssetPanel,
  selectSingleNode,
  openContextMenuAtClientPosition,
  openNodeContextMenuAtClientPosition,
  openNodeMenuAtClientPosition, // 👈 关键：确保这一行在你的文件里存在！
}: UseCanvasMouseActionsOptions) {
  const blankCanvasRightClickRef = useRef<BlankCanvasRightClickState | null>(null);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (suppressPaneClickUntilRef.current > 0) {
      const shouldSuppress = Date.now() <= suppressPaneClickUntilRef.current;
      suppressPaneClickUntilRef.current = 0;
      if (shouldSuppress) {
        return;
      }
    }
    if (event.detail >= 2) {
      openNodeMenuAtClientPosition(event.clientX, event.clientY);
      return;
    }
    selectSingleNode(null);
    closeAssetPanel();
    clearOverlays();
  }, [clearOverlays, closeAssetPanel, openNodeMenuAtClientPosition, selectSingleNode, suppressPaneClickUntilRef]);

  const handleCanvasContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const selectedText = getSelectedCanvasText(wrapperRef.current);
    if (selectedText) {
      event.stopPropagation();
      event.preventDefault();
      blankCanvasRightClickRef.current = null;
      openContextMenuAtClientPosition(
        getCanvasNodeIdFromTarget(event.target),
        event.clientX,
        event.clientY,
        { selectedText }
      );
      return;
    }
    if (shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (getCanvasNodeIdFromTarget(event.target)) {
      blankCanvasRightClickRef.current = null;
      return;
    }
    clearOverlays();
    if (event.button !== 2) {
      blankCanvasRightClickRef.current = null;
      setNodeContextMenu(null);
      return;
    }
    const previousRightClick = blankCanvasRightClickRef.current;
    const elapsedMs = previousRightClick
      ? event.timeStamp - previousRightClick.timeStamp
      : Number.POSITIVE_INFINITY;
    const distancePx = previousRightClick
      ? Math.hypot(
          event.clientX - previousRightClick.clientX,
          event.clientY - previousRightClick.clientY
        )
      : Number.POSITIVE_INFINITY;
    const isDoubleRightClick = elapsedMs >= 0
      && elapsedMs <= BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_MS
      && distancePx <= BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_DISTANCE;
    if (!isDoubleRightClick) {
      blankCanvasRightClickRef.current = {
        timeStamp: event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      setNodeContextMenu(null);
      return;
    }
    blankCanvasRightClickRef.current = null;
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }
    openContextMenuAtClientPosition(null, event.clientX, event.clientY);
  }, [clearOverlays, openContextMenuAtClientPosition, setNodeContextMenu, wrapperRef]);

  const handleConfiguredNodeClickAction = useCallback((
    event: ReactMouseEvent,
    nodeId: string,
    action: CanvasMouseAction
  ) => {
    if (action === 'nodeMenu') {
      event.preventDefault();
      event.stopPropagation();
      openNodeContextMenuAtClientPosition(nodeId, event.clientX, event.clientY);
      return;
    }
    if (action === 'selectNode') {
      selectSingleNode(nodeId);
      setNodeContextMenu(null);
      return;
    }
    if (action === 'none' || action === 'panCanvas' || action === 'selectionBox') {
      event.preventDefault();
      window.setTimeout(() => selectSingleNode(null), 0);
      setNodeContextMenu(null);
    }
  }, [openNodeContextMenuAtClientPosition, selectSingleNode, setNodeContextMenu]);

  const handleNodeClick = useCallback((event: ReactMouseEvent, node: CanvasNode) => {
    handleConfiguredNodeClickAction(
      event,
      node.id,
      getCanvasMouseAction(canvasMouseBindings, 0, 'click')
    );
  }, [canvasMouseBindings, handleConfiguredNodeClickAction]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: CanvasNode) => {
    event.preventDefault();
    event.stopPropagation();
    const selectedText = getSelectedCanvasText(wrapperRef.current);
    if (selectedText) {
      blankCanvasRightClickRef.current = null;
      openNodeContextMenuAtClientPosition(node.id, event.clientX, event.clientY, {
        selectedText,
        selectNode: false,
      });
      return;
    }
    const action = getCanvasMouseAction(canvasMouseBindings, 2, 'click');
    handleConfiguredNodeClickAction(event, node.id, action);
  }, [canvasMouseBindings, handleConfiguredNodeClickAction, openNodeContextMenuAtClientPosition, wrapperRef]);

  const handleCanvasAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    const nodeId = getCanvasNodeIdFromTarget(event.target);
    const action = getCanvasMouseAction(canvasMouseBindings, 1, 'click');
    if (action === 'none' || action === 'nodeMenu' || action === 'selectNode') {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!nodeId) {
      if (action !== 'panCanvas' && action !== 'selectionBox') {
        setNodeContextMenu(null);
      }
      return;
    }
    handleConfiguredNodeClickAction(event, nodeId, action);
  }, [canvasMouseBindings, handleConfiguredNodeClickAction, setNodeContextMenu]);

  return {
    handlePaneClick,
    handleCanvasContextMenu,
    handleNodeClick,
    handleNodeContextMenu,
    handleCanvasAuxClick,
  };
}