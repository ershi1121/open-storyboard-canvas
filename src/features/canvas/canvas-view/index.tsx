import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  useViewport,
  ViewportPortal,
  Panel,
  type IsValidConnection,
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
  type CanvasEdge,
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
// 🧲 自动吸附 + 跟随移动（SnapGuides 在本文件内定义，JSX 只存在于 .tsx）
import { useCanvasSnapFollow, type SnapGuide } from './hooks/useCanvasSnapFollow';
import { useSnapStore } from '@/stores/snapStore';
import { SnapToggle } from './components/SnapToggle';
import { SelectionOverlays } from './components/SelectionOverlays';
import { ConnectionPreview } from './components/ConnectionPreview';
import { EmptyHint } from './components/EmptyHint';
import { BatchToolbar } from './components/BatchToolbar';
import { ContextMenu } from './components/ContextMenu';

/** 标签胶囊类型集合：间接取值，避免字面量比较报错 */
const NODE_TYPE_RECORD = CANVAS_NODE_TYPES as unknown as Record<string, string>;
const TAG_CAPSULE_TYPES = new Set<string>(
  [NODE_TYPE_RECORD.tag, NODE_TYPE_RECORD.tagGroup].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  ),
);

// 🧲 吸附参考线（蓝色虚线，zoom 补偿：屏幕恒定 1px 线宽 + 恒定虚线节奏）
function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  const { zoom } = useViewport();
  const thickness = Math.max(0.5, 1 / zoom);
  const dash = 8 / zoom; // 虚线段：屏幕恒定 8px
  const gap = 6 / zoom;  // 间隔：屏幕恒定 6px
  const blue = 'rgba(59, 130, 246, 0.9)'; // blue-500，深浅主题都醒目

  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      {guides.map((g) =>
        g.orientation === 'vertical' ? (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50"
            style={{
              left: g.position,
              top: -100000,
              width: thickness,
              height: 200000,
              backgroundImage: `repeating-linear-gradient(to bottom, ${blue} 0, ${blue} ${dash}px, transparent ${dash}px, transparent ${dash + gap}px)`,
            }}
          />
        ) : (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50"
            style={{
              top: g.position,
              left: -100000,
              height: thickness,
              width: 200000,
              backgroundImage: `repeating-linear-gradient(to right, ${blue} 0, ${blue} ${dash}px, transparent ${dash}px, transparent ${dash + gap}px)`,
            }}
          />
        )
      )}
    </ViewportPortal>
  );
}

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
  const snapEnabled = useSnapStore((s) => s.snapEnabled);
  // 🚨 彻底修复：胶囊退出 RF 内部选择体系（selectable: false）
  const flowNodes = useMemo(
    () =>
      nodes.map((node) =>
        TAG_CAPSULE_TYPES.has(node.type) ? { ...node, selectable: false } : node,
      ),
    [nodes],
  );
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

  const selection = useCanvasSelection({ nodesRef });
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
  // 🧲 自动吸附 + 跟随移动
  const snapFollow = useCanvasSnapFollow();

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    wrapperRef.current?.focus({ preventScroll: true });
  }, []);

  // ===== 🚀 新增：连线验证（标签胶囊单源限制 + 防重复连线）=====
  const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>(
    (connection) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;

      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!targetNode) return true;

      // 1. 避免完全重复的连线
      const edgeExists = edges.some(
        (e) => e.source === connection.source && e.target === connection.target
      );
      if (edgeExists) return false;

      // 2. 标签节点专属规则：如果目标已经是标签节点且已有其他上游，则禁止拖入（显示红色禁止图标 🚫）
      //    说明：如果你更喜欢“拖拽自动替换旧源”的体验，请注释掉下面这个 if 块，
      //    底层 canvasStore 会自动移除旧入边并更新 sourceId。
      if (targetNode.type === CANVAS_NODE_TYPES.tag) {
        const hasExistingIncomingEdge = edges.some(
          (e) => e.target === connection.target && e.source !== connection.source
        );
        if (hasExistingIncomingEdge) return false;
      }

      return true;
    },
    [nodes, edges]
  );
  // ==========================================================

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
              const sourceText = getGeneratedTextForConnection(
                sourceNode,
                useCanvasStore.getState().nodes
              );
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
        nodes={flowNodes}
        edges={edges}
        isValidConnection={isValidConnection} // 👈 新增这一行
        // 🧲 修改1：吸附逻辑先处理 changes，再交给原有处理逻辑
        onNodesChange={(changes) =>
          flowHandlers.handleNodesChange(
            snapEnabled ? snapFollow.processNodeChanges(changes) : changes,
          )
        }
        onEdgesChange={flowHandlers.handleEdgesChange}
        onEdgeClick={flowHandlers.handleEdgeClick}
        onEdgeDoubleClick={flowHandlers.handleEdgeDoubleClick}
        onConnect={flowHandlers.handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={(event, node) => {
          // 启动 rAF 循环，持续强制覆盖 React Flow 内部设置的 grabbing
          const enforceCursor = () => {
            document.body.style.setProperty('cursor', 'move', 'important');
            (window as any).__nodeDragRaf = requestAnimationFrame(enforceCursor);
          };
          enforceCursor();

          if (snapEnabled) snapFollow.onNodeDragStart(event, node);
          altDrag.handleNodeDragStart(event, node);
        }}
        onNodeDrag={(event, node) => {
          altDrag.handleNodeDrag(event, node);
        }}
        onNodeDragStop={(event, node) => {
          // 停止 rAF 循环，清除内联样式
          if ((window as any).__nodeDragRaf) {
            cancelAnimationFrame((window as any).__nodeDragRaf);
            (window as any).__nodeDragRaf = null;
          }
          document.body.style.removeProperty('cursor');

          snapFollow.onNodeDragStop();
          altDrag.handleNodeDragStop(event, node);
        }}
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
        selectionKeyCode={null}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
      >
        {/* 🧲 修改4：渲染吸附参考线 */}
        <SnapGuides guides={snapEnabled ? snapFollow.guides : []} />
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
        <Panel position="bottom-left">
          <SnapToggle />
        </Panel>
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
        subtitle={
          assetPanel.assetPanelMode === 'select' ? '选择一张现有图片连接到 AI 图片节点' : undefined
        }
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