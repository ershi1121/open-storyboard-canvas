import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import type { NodeContextMenuState } from '../types';
import { writeTextToClipboard } from '../utils/clipboard';

interface UseContextMenuActionsOptions {
  wrapperRef: { current: HTMLDivElement | null };
  nodesRef: { current: CanvasNode[] };
  nodeContextMenu: NodeContextMenuState | null;
  setNodeContextMenu: (state: NodeContextMenuState | null) => void;
  setShowNodeMenu: (show: boolean) => void;
  setMenuPosition: (position: { x: number; y: number }) => void;
  setFlowPosition: (position: { x: number; y: number }) => void;
  clearOverlays: () => void;
  selectSingleNode: (nodeId: string | null) => void;
  copyNodesToClipboard: (sourceNodeIds: string[]) => void;
  markSystemClipboardFresh: () => void;
  scheduleCanvasPersist: (delay?: number) => void;
}

export function useContextMenuActions({
  wrapperRef,
  nodesRef,
  nodeContextMenu,
  setNodeContextMenu,
  setShowNodeMenu,
  setMenuPosition,
  setFlowPosition,
  clearOverlays,
  selectSingleNode,
  copyNodesToClipboard,
  markSystemClipboardFresh,
  scheduleCanvasPersist,
}: UseContextMenuActionsOptions) {
  const reactFlowInstance = useReactFlow();
  const addNode = useCanvasStore((state) => state.addNode);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);

  const openContextMenuAtClientPosition = useCallback((
    nodeId: string | null,
    clientX: number,
    clientY: number,
    options: { selectedText?: string; selectNode?: boolean } = {}
  ) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }
    const menuFlowPosition = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });
    if (options.selectNode) {
      selectSingleNode(nodeId);
    }
    clearOverlays();
    setNodeContextMenu({
      nodeId,
      position: {
        x: clientX - containerRect.left,
        y: clientY - containerRect.top,
      },
      flowPosition: menuFlowPosition,
      selectedText: options.selectedText,
    });
  }, [clearOverlays, reactFlowInstance, selectSingleNode, setNodeContextMenu]);

  const openNodeContextMenuAtClientPosition = useCallback((
    nodeId: string,
    clientX: number,
    clientY: number,
    options: { selectedText?: string; selectNode?: boolean } = {}
  ) => {
    openContextMenuAtClientPosition(nodeId, clientX, clientY, {
      ...options,
      selectNode: options.selectNode ?? true,
    });
  }, [openContextMenuAtClientPosition]);

  const openNodeMenuAtClientPosition = useCallback((clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }
    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });
    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    });
    clearOverlays();
    setShowNodeMenu(true);
  }, [clearOverlays, reactFlowInstance, setFlowPosition, setMenuPosition, setShowNodeMenu]);

  const handleBatchCopy = useCallback(() => {
    const selectedIds = nodesRef.current
      .filter((node) => Boolean(node.selected))
      .map((node) => node.id);
    if (selectedIds.length === 0) {
      return;
    }
    copyNodesToClipboard(selectedIds);
    setNodeContextMenu(null);
  }, [copyNodesToClipboard, nodesRef, setNodeContextMenu]);

  const handleNodeContextMenuCopy = useCallback(() => {
    if (!nodeContextMenu?.nodeId) {
      return;
    }
    copyNodesToClipboard([nodeContextMenu.nodeId]);
    setNodeContextMenu(null);
  }, [copyNodesToClipboard, nodeContextMenu, setNodeContextMenu]);

  const handleContextMenuCopySelectedText = useCallback(async () => {
    const selectedText = nodeContextMenu?.selectedText?.trim();
    if (!selectedText) {
      return;
    }
    try {
      await writeTextToClipboard(selectedText);
      markSystemClipboardFresh();
    } catch (error) {
      console.warn('Failed to copy selected text', error);
    } finally {
      setNodeContextMenu(null);
    }
  }, [markSystemClipboardFresh, nodeContextMenu, setNodeContextMenu]);

  const handleContextMenuCreateImageFromSelectedText = useCallback(() => {
    const selectedText = nodeContextMenu?.selectedText?.trim();
    const menuFlowPosition = nodeContextMenu?.flowPosition;
    if (!selectedText || !menuFlowPosition) {
      return;
    }
    const newNodeId = addNode(CANVAS_NODE_TYPES.imageEdit, menuFlowPosition, {
      prompt: selectedText,
    });
    applyNodesChange([
      ...nodesRef.current.map((node) => ({
        id: node.id,
        type: 'select' as const,
        selected: false,
      })),
      {
        id: newNodeId,
        type: 'select' as const,
        selected: true,
      },
    ]);
    setSelectedNode(newNodeId);
    scheduleCanvasPersist(0);
    setNodeContextMenu(null);
    window.requestAnimationFrame(() => clearBrowserTextSelection());
  }, [addNode, applyNodesChange, nodeContextMenu, nodesRef, scheduleCanvasPersist, setNodeContextMenu, setSelectedNode]);

  const handleNodeContextMenuDelete = useCallback(() => {
    if (!nodeContextMenu?.nodeId) {
      return;
    }
    deleteNode(nodeContextMenu.nodeId);
    scheduleCanvasPersist(0);
    setNodeContextMenu(null);
  }, [deleteNode, nodeContextMenu, scheduleCanvasPersist, setNodeContextMenu]);

  return {
    openContextMenuAtClientPosition,
    openNodeContextMenuAtClientPosition,
    openNodeMenuAtClientPosition,
    handleBatchCopy,
    handleNodeContextMenuCopy,
    handleContextMenuCopySelectedText,
    handleContextMenuCreateImageFromSelectedText,
    handleNodeContextMenuDelete,
  };
}