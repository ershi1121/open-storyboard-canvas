import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { useCanvasShortcuts } from '@/features/canvas/hooks/useCanvasShortcuts';
import { CanvasSideToolbar } from '@/features/canvas/CanvasSideToolbar';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { hasConfiguredImageProvider } from '@/features/canvas/application/providerAvailability';
import { listModelProviders } from '@/features/canvas/models';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { nodeTypes } from '../nodes';
import { edgeTypes } from '../edges';
import { NodeSelectionMenu } from '../NodeSelectionMenu';
import { SelectedNodeOverlay } from '../ui/SelectedNodeOverlay';
import { NodeToolDialog } from '../ui/NodeToolDialog';
import { ImageViewerModal } from '../ui/ImageViewerModal';
import { AssetPanel } from '../ui/AssetPanel';
import { CANVAS_MOUSE_BUTTONS, DEFAULT_VIEWPORT, getCanvasMouseAction } from './constants';
import type { NodeContextMenuState } from './types';
import { shouldIgnoreCanvasMarqueeTarget } from './utils/geometry';
import { getGeneratedTextForConnection } from './utils/node-helpers';
import { useEdgePan } from './hooks/useEdgePan';
import { useBatchToolbarPosition } from './hooks/useBatchToolbarPosition';
import { useMarqueeSelection } from './hooks/useMarqueeSelection';
import { useMaterialImport } from './hooks/useMaterialImport';
import { useCanvasClipboard } from './hooks/useCanvasClipboard';
import { useAltDragCopy } from './hooks/useAltDragCopy';
import { useCanvasAssetPanel } from './hooks/useCanvasAssetPanel';
import { useConnectFlow } from './hooks/useConnectFlow';
import { useCanvasFlowHandlers } from './hooks/useCanvasFlowHandlers';
import { useCanvasSelection } from './hooks/useCanvasSelection';
import { useContextMenuActions } from './hooks/useContextMenuActions';
import { useCanvasMouseActions } from './hooks/useCanvasMouseActions';
import { SelectionOverlays } from './components/SelectionOverlays';
import { ConnectionPreview } from './components/ConnectionPreview';
import { EmptyHint } from './components/EmptyHint';
import { BatchToolbar } from './components/BatchToolbar';
import { ContextMenu } from './components/ContextMenu';

export function Canvas() {
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const suppressPaneClickUntilRef = useRef(0);
  const suppressNextEdgeClickRef = useRef(false);
  const suppressNextMarqueeSelectionClearRef = useRef(false);
  const nodesRef = useRef<CanvasNode[]>([]);
  
  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(undefined);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNode = useCanvasStore((state) => state.addNode);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);

  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
  const canvasMouseBindings = useSettingsStore((state) => state.canvasMouseBindings);
  const customProviders = useCustomProvidersStore((state) => state.providers);
  const cancelPendingViewportPersist = useProjectStore((state) => state.cancelPendingViewportPersist);

  const providerIds = useMemo(() => listModelProviders().map((provider) => provider.id), []);
  const hasConfiguredProvider = useMemo(
    () =>
      hasConfiguredImageProvider({
        apiKeys,
        builtInProviderIds: providerIds,
        customProviders,
        dreaminaStatus,
      }),
    [apiKeys, customProviders, dreaminaStatus, providerIds]
  );

  const panOnDragButtons = useMemo(
    () =>
      CANVAS_MOUSE_BUTTONS.filter(
        (button) => getCanvasMouseAction(canvasMouseBindings, button, 'drag') === 'panCanvas'
      ),
    [canvasMouseBindings]
  );

  const { isRestoringCanvasRef, scheduleCanvasPersist } = useCanvasPersistence(reactFlowInstance);

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });
    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  useCanvasGenerationPolling(nodes, apiKeys);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  // ==========================================
  // 🚨 BUG 1 修复区：解构 useState 提供的稳定 Setter
  // ==========================================
  const {
    pendingConnectStart,
    setPendingConnectStart,
    previewConnectionVisual,
    setPreviewConnectionVisual,
    handleConnectStart,
    handleConnectEnd,
    handleCanvasPointerMove,
  } = useConnectFlow({
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
  });

  const clearOverlays = useCallback(() => {
    setShowNodeMenu(false);
    setNodeContextMenu(null);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [setPendingConnectStart, setPreviewConnectionVisual]);
  // ==========================================

  const selection = useCanvasSelection({ wrapperRef, nodesRef });

  const flowHandlers = useCanvasFlowHandlers({
    wrapperRef,
    nodes,
    pendingConnectStart,
    suppressNextMarqueeSelectionClearRef,
    suppressNextEdgeClickRef,
    isRestoringCanvasRef,
    scheduleCanvasPersist,
    cancelPendingViewportPersist,
  });

  useEdgePan({ wrapperRef, isRestoringCanvasRef, suppressNextEdgeClickRef });

  const assetPanel = useCanvasAssetPanel({
    nodes,
    wrapperRef,
    pendingConnectStart,
    menuPosition,
    clearOverlays,
    scheduleCanvasPersist,
  });

  const materialImport = useMaterialImport({ scheduleCanvasPersist });

  const clipboard = useCanvasClipboard({
    wrapperRef,
    lastCanvasPointerRef,
    nodeContextMenu,
    setNodeContextMenu,
    scheduleCanvasPersist,
    createUploadImageNodeAtFlowPosition: materialImport.createUploadImageNodeAtFlowPosition,
    createUploadImageNodeAtClientPosition: materialImport.createUploadImageNodeAtClientPosition,
    createMaterialNodeFromFileAtFlowPosition: materialImport.createMaterialNodeFromFileAtFlowPosition,
    createMaterialNodeFromFileAtClientPosition: materialImport.createMaterialNodeFromFileAtClientPosition,
  });

  const contextMenuActions = useContextMenuActions({
    wrapperRef,
    nodesRef,
    nodeContextMenu,
    setNodeContextMenu,
    setShowNodeMenu,
    setMenuPosition,
    setFlowPosition,
    clearOverlays,
    selectSingleNode: selection.selectSingleNode,
    copyNodesToClipboard: clipboard.copyNodesToClipboard,
    markSystemClipboardFresh: clipboard.markSystemClipboardFresh,
    scheduleCanvasPersist,
  });

  const mouseActions = useCanvasMouseActions({
    wrapperRef,
    canvasMouseBindings,
    suppressPaneClickUntilRef,
    setNodeContextMenu,
    clearOverlays,
    closeAssetPanel: assetPanel.closeAssetPanel,
    selectSingleNode: selection.selectSingleNode,
    openContextMenuAtClientPosition: contextMenuActions.openContextMenuAtClientPosition,
    openNodeContextMenuAtClientPosition: contextMenuActions.openNodeContextMenuAtClientPosition,
    openNodeMenuAtClientPosition: contextMenuActions.openNodeMenuAtClientPosition,
  });

  const { marqueeRect } = useMarqueeSelection({
    wrapperRef,
    canvasMouseBindings,
    selectNodesInMarquee: selection.selectNodesInMarquee,
    openNodeContextMenuAtClientPosition: contextMenuActions.openNodeContextMenuAtClientPosition,
    clearOverlays,
    suppressPaneClickUntilRef,
    suppressNextMarqueeSelectionClearRef,
  });

  const { batchToolbarPosition, selectionBoundsRect } = useBatchToolbarPosition({
    wrapperRef,
    nodes,
    selectedNodeIds: selection.selectedNodeIds,
    isSingleSelectedGroup: selection.isSingleSelectedGroup,
  });

  const altDrag = useAltDragCopy({
    nodes,
    selectedNodeIds: selection.selectedNodeIds,
    duplicateNodes: clipboard.duplicateNodes,
    scheduleCanvasPersist,
  });

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    wrapperRef.current?.focus({ preventScroll: true });
  }, []);

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const pending = pendingConnectStart;
      const newNodeId = addNode(type, flowPosition);
      if (pending) {
        if (pending.handleType === 'source') {
          connectNodes({
            source: pending.nodeId,
            target: newNodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
          if (type === CANVAS_NODE_TYPES.textAnnotation) {
            const sourceNode = useCanvasStore.getState().nodes.find(
              (node) => node.id === pending.nodeId
            );
            if (sourceNode) {
              const sourceText = getGeneratedTextForConnection(sourceNode, useCanvasStore.getState().nodes);
              if (sourceText) {
                updateNodeData(newNodeId, { content: sourceText } as Partial<CanvasNodeData>);
              }
            }
          }
        } else {
          connectNodes({
            source: newNodeId,
            target: pending.nodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
        }
      }
      scheduleCanvasPersist(0);
      clearOverlays();
    },
    [
      addNode,
      clearOverlays,
      pendingConnectStart,
      connectNodes,
      flowPosition,
      scheduleCanvasPersist,
      updateNodeData,
    ]
  );

  const handleBatchGroup = useCallback(() => {
    const groupedNodeId = groupNodes(selection.selectedNodeIds);
    if (!groupedNodeId) {
      return;
    }
    scheduleCanvasPersist(0);
  }, [groupNodes, scheduleCanvasPersist, selection.selectedNodeIds]);

  const handleBatchUngroup = useCallback(() => {
    let changed = false;
    for (const groupNodeId of selection.selectedGroupNodeIds) {
      changed = ungroupNode(groupNodeId) || changed;
    }
    if (changed) {
      scheduleCanvasPersist(0);
    }
  }, [scheduleCanvasPersist, selection.selectedGroupNodeIds, ungroupNode]);

  const handleBatchTrigger = useCallback(() => {
    selection.selectedBatchTriggerNodeIds.forEach((nodeId) => {
      canvasEventBus.publish('generation-node/trigger', { nodeId });
    });
  }, [selection.selectedBatchTriggerNodeIds]);

  const handleBatchDelete = useCallback(() => {
    deleteNodes(selection.selectedNodeIds);
    scheduleCanvasPersist(0);
  }, [deleteNodes, scheduleCanvasPersist, selection.selectedNodeIds]);

  useCanvasShortcuts({
    nodes,
    selectedNodeId,
    selectedNodeIds: selection.selectedNodeIds,
    selectedUploadNodeId: selection.selectedUploadNodeId,
    scheduleCanvasPersist,
    undo,
    redo,
    groupNodes,
    deleteNode,
    deleteNodes,
    copyNodesToClipboard: clipboard.copyNodesToClipboard,
    pasteFromShortcut: clipboard.handleShortcutPaste,
    markSystemClipboardFresh: clipboard.markSystemClipboardFresh,
    pasteImageAtCanvasPosition: clipboard.pasteImageAtCanvasPosition,
    pasteImageFromClipboardEvent: clipboard.pasteImageFromClipboardEvent,
    pasteMediaFromClipboardEvent: clipboard.pasteMediaFromClipboardEvent,
    pasteTextFromClipboardEvent: clipboard.pasteTextFromClipboardEvent,
    shouldHandleClipboardEventPaste: clipboard.shouldHandleClipboardEventPaste,
  });

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full outline-none"
      tabIndex={0}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onContextMenu={mouseActions.handleCanvasContextMenu}
      onAuxClick={mouseActions.handleCanvasAuxClick}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={flowHandlers.handleNodesChange}
        onEdgesChange={flowHandlers.handleEdgesChange}
        onEdgeClick={flowHandlers.handleEdgeClick}
        onEdgeDoubleClick={flowHandlers.handleEdgeDoubleClick}
        onConnect={flowHandlers.handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={altDrag.handleNodeDragStart}
        onNodeDrag={altDrag.handleNodeDrag}
        onNodeDragStop={altDrag.handleNodeDragStop}
        onNodeClick={mouseActions.handleNodeClick}
        onNodeContextMenu={mouseActions.handleNodeContextMenu}
        onPaneClick={mouseActions.handlePaneClick}
        onMove={flowHandlers.handleMove}
        onMoveStart={flowHandlers.handleMoveStart}
        onMoveEnd={flowHandlers.handleMoveEnd}
        onDragOver={materialImport.handleCanvasDragOver}
        onDrop={materialImport.handleCanvasDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'disconnectableEdge' }}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        panOnDrag={panOnDragButtons.length > 0 ? panOnDragButtons : false}
        selectionOnDrag={false}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={['Control', 'Meta']}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--canvas-grid-dot)" />
        <MiniMap
          className="canvas-minimap nopan nowheel"
          style={{ pointerEvents: 'all', zIndex: 10000 }}
          nodeColor="var(--canvas-minimap-node)"
          maskColor="var(--canvas-minimap-mask)"
          pannable
          zoomable
        />
        <SelectedNodeOverlay />
      </ReactFlow>

      <SelectionOverlays marqueeRect={marqueeRect} selectionBoundsRect={selectionBoundsRect} />
      
      <BatchToolbar
        position={batchToolbarPosition}
        selectedCount={selection.batchToolbarSelectedCount}
        canGroup={selection.selectedNodeIds.length >= 2}
        canUngroup={selection.selectedGroupNodeIds.length > 0}
        canTrigger={selection.selectedBatchTriggerNodeIds.length > 0}
        onCopy={contextMenuActions.handleBatchCopy}
        onGroup={handleBatchGroup}
        onUngroup={handleBatchUngroup}
        onTrigger={handleBatchTrigger}
        onDelete={handleBatchDelete}
      />
      
      <CanvasSideToolbar onOpenAssets={assetPanel.handleOpenAssetPanel} />
      
      <AssetPanel
        isOpen={assetPanel.isAssetPanelOpen}
        assets={assetPanel.assetPanelAssets}
        buttonRect={assetPanel.assetButtonRect}
        mode={assetPanel.assetPanelMode}
        title={assetPanel.assetPanelMode === 'select' ? '资产' : undefined}
        subtitle={assetPanel.assetPanelMode === 'select' ? '选择一张现有图片连接到 AI 图片节点' : undefined}
        onClose={assetPanel.closeAssetPanel}
        onActivate={assetPanel.handleActivateAsset}
        onRename={assetPanel.assetPanelMode === 'browse' ? assetPanel.handleRenameAsset : undefined}
      />
      
      {nodes.length === 0 && <EmptyHint hasConfiguredProvider={hasConfiguredProvider} />}
      
      {nodes.length > 0 && !hasConfiguredProvider && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
          <MissingApiKeyHint />
        </div>
      )}
      
      {showNodeMenu && <ConnectionPreview visual={previewConnectionVisual} />}
      
      <ContextMenu
        state={nodeContextMenu}
        onCopySelectedText={() => void contextMenuActions.handleContextMenuCopySelectedText()}
        onCreateImageFromText={contextMenuActions.handleContextMenuCreateImageFromSelectedText}
        onCopyNode={contextMenuActions.handleNodeContextMenuCopy}
        onPaste={() => void clipboard.handleContextMenuPaste()}
        onDeleteNode={contextMenuActions.handleNodeContextMenuDelete}
      />
      
      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          showAssetOption={assetPanel.showConnectAssetOption}
          onSelectAsset={assetPanel.handleOpenConnectAssetPanel}
          onSelect={handleNodeSelect}
          onClose={clearOverlays}
        />
      )}
      
      <NodeToolDialog />
      
      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />
    </div>
  );
}