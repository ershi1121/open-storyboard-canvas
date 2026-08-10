import { useCallback, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { nodeHasSourceHandle, nodeHasTargetHandle } from '@/features/canvas/domain/nodeRegistry';
import type { CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { EMPTY_CANVAS_ASSETS } from '../constants';
import type { PendingConnectStart } from '../types';
import { extractCanvasAssets } from '../utils/assets';
import { createAssetPanelAnchorRect } from '../utils/geometry';
import { getNodeSize } from '../utils/node-helpers';

interface UseCanvasAssetPanelOptions {
  nodes: CanvasNode[];
  wrapperRef: { current: HTMLDivElement | null };
  pendingConnectStart: PendingConnectStart | null;
  menuPosition: { x: number; y: number };
  clearOverlays: () => void;
  scheduleCanvasPersist: (delay?: number) => void;
}

export function useCanvasAssetPanel({
  nodes,
  wrapperRef,
  pendingConnectStart,
  menuPosition,
  clearOverlays,
  scheduleCanvasPersist,
}: UseCanvasAssetPanelOptions) {
  const reactFlowInstance = useReactFlow();
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [isAssetPanelOpen, setIsAssetPanelOpen] = useState(false);
  const [assetButtonRect, setAssetButtonRect] = useState<DOMRect | null>(null);
  const [assetPanelMode, setAssetPanelMode] = useState<'browse' | 'select'>('browse');
  const [assetConnectTargetNodeId, setAssetConnectTargetNodeId] = useState<string | null>(null);

  const canvasAssets = useMemo(
    () => (isAssetPanelOpen ? extractCanvasAssets(nodes) : EMPTY_CANVAS_ASSETS),
    [isAssetPanelOpen, nodes]
  );
  const assetPanelAssets = useMemo(() => {
    if (assetPanelMode !== 'select' || !assetConnectTargetNodeId) {
      return canvasAssets;
    }
    return canvasAssets.filter(
      (asset) => asset.kind === 'image' && asset.nodeId !== assetConnectTargetNodeId
    );
  }, [assetConnectTargetNodeId, assetPanelMode, canvasAssets]);

  const showConnectAssetOption = useMemo(() => {
    if (!pendingConnectStart || pendingConnectStart.handleType !== 'target') {
      return false;
    }
    const targetNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
    return targetNode?.type === CANVAS_NODE_TYPES.imageEdit;
  }, [nodes, pendingConnectStart]);

  const handleOpenAssetPanel = useCallback((buttonRect: DOMRect) => {
    setAssetButtonRect(buttonRect);
    setAssetPanelMode('browse');
    setAssetConnectTargetNodeId(null);
    setIsAssetPanelOpen((open) => !open);
    clearOverlays();
  }, [clearOverlays]);

  const closeAssetPanel = useCallback(() => {
    setIsAssetPanelOpen(false);
    setAssetPanelMode('browse');
    setAssetConnectTargetNodeId(null);
    setAssetButtonRect(null);
  }, []);

  const handleActivateAsset = useCallback(
    (asset: CanvasAssetItem) => {
      if (assetPanelMode === 'select') {
        if (asset.kind !== 'image' || !assetConnectTargetNodeId || asset.nodeId === assetConnectTargetNodeId) {
          return;
        }
        const sourceNode = nodes.find((node) => node.id === asset.nodeId);
        const targetNode = nodes.find((node) => node.id === assetConnectTargetNodeId);
        if (targetNode && nodeHasTargetHandle(targetNode.type)) {
          const canConnectExistingSource =
            sourceNode &&
            asset.id === `${sourceNode.id}:image` &&
            (
              sourceNode.type === CANVAS_NODE_TYPES.upload ||
              sourceNode.type === CANVAS_NODE_TYPES.imageEdit ||
              sourceNode.type === CANVAS_NODE_TYPES.exportImage
            ) &&
            nodeHasSourceHandle(sourceNode.type);
          const sourceNodeId = canConnectExistingSource
            ? sourceNode.id
            : addNode(CANVAS_NODE_TYPES.exportImage, {
                x: targetNode.position.x - 300,
                y: targetNode.position.y,
              }, {
                displayName: asset.title,
                imageUrl: asset.rawImageUrl,
                previewImageUrl: asset.rawPreviewImageUrl ?? asset.rawImageUrl,
                aspectRatio: asset.aspectRatio ?? '1:1',
                resultKind: 'generic',
              });
          addEdge(sourceNodeId, assetConnectTargetNodeId);
          scheduleCanvasPersist(0);
        }
        setIsAssetPanelOpen(false);
        setAssetPanelMode('browse');
        setAssetConnectTargetNodeId(null);
        setAssetButtonRect(null);
        return;
      }
      const targetNode = nodes.find((node) => node.id === asset.nodeId);
      if (!targetNode) {
        return;
      }
      const size = getNodeSize(targetNode);
      const centerX = targetNode.position.x + size.width / 2;
      const centerY = targetNode.position.y + size.height / 2;
      const viewportNow = reactFlowInstance.getViewport();
      reactFlowInstance.setCenter(centerX, centerY, {
        zoom: Math.max(viewportNow.zoom, 0.85),
        duration: 450,
      });
      applyNodesChange(
        nodes.map((node) => ({
          id: node.id,
          type: 'select',
          selected: node.id === targetNode.id,
        }))
      );
      setSelectedNode(targetNode.id);
      setIsAssetPanelOpen(false);
    },
    [
      addEdge,
      addNode,
      applyNodesChange,
      assetConnectTargetNodeId,
      assetPanelMode,
      nodes,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
    ]
  );

  const handleRenameAsset = useCallback(
    (asset: CanvasAssetItem, title: string) => {
      const node = nodes.find((item) => item.id === asset.nodeId);
      updateNodeData(asset.nodeId, {
        displayName: title,
        ...(node?.type === CANVAS_NODE_TYPES.exportImage || node?.type === CANVAS_NODE_TYPES.video
          ? { generatedNamingMode: 'custom' as const }
          : {}),
      });
    },
    [nodes, updateNodeData]
  );

  const handleOpenConnectAssetPanel = useCallback(() => {
    if (!pendingConnectStart || pendingConnectStart.handleType !== 'target') {
      return;
    }
    const targetNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
    if (!targetNode || targetNode.type !== CANVAS_NODE_TYPES.imageEdit) {
      return;
    }
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const anchorX = (containerRect?.left ?? 0) + menuPosition.x;
    const anchorY = (containerRect?.top ?? 0) + menuPosition.y;
    setAssetButtonRect(createAssetPanelAnchorRect(anchorX, anchorY));
    setAssetPanelMode('select');
    setAssetConnectTargetNodeId(targetNode.id);
    setIsAssetPanelOpen(true);
    clearOverlays();
  }, [clearOverlays, menuPosition.x, menuPosition.y, nodes, pendingConnectStart, wrapperRef]);

  return {
    isAssetPanelOpen,
    assetButtonRect,
    assetPanelMode,
    assetConnectTargetNodeId,
    assetPanelAssets,
    showConnectAssetOption,
    handleOpenAssetPanel,
    handleActivateAsset,
    handleRenameAsset,
    closeAssetPanel,
    handleOpenConnectAssetPanel,
  };
}