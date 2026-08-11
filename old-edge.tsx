import { memo, useMemo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';

const EMPTY_ROUTE_NODES: CanvasNode[] = [];

function resolveNodeWidth(node: CanvasNode): number | string {
  return node.measured?.width
    ?? node.width
    ?? (typeof node.style?.width === 'number' || typeof node.style?.width === 'string' ? node.style.width : '');
}

function resolveNodeHeight(node: CanvasNode): number | string {
  return node.measured?.height
    ?? node.height
    ?? (typeof node.style?.height === 'number' || typeof node.style?.height === 'string' ? node.style.height : '');
}

function buildNodeGeometrySignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => [
      node.id,
      node.type,
      node.position.x,
      node.position.y,
      resolveNodeWidth(node),
      resolveNodeHeight(node),
    ].join(':'))
    .join('|');
}

export const DisconnectableEdge = memo(function DisconnectableEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    selected,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  } = props;
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  const nodeGeometrySignature = useCanvasStore((state) =>
    canvasEdgeRoutingMode === 'smartOrthogonal' ? buildNodeGeometrySignature(state.nodes) : ''
  );
  const routeNodes = useMemo(
    () => (canvasEdgeRoutingMode === 'smartOrthogonal' ? useCanvasStore.getState().nodes : EMPTY_ROUTE_NODES),
    [canvasEdgeRoutingMode, nodeGeometrySignature]
  );
  const isProcessingEdge = useCanvasStore((state) => {
    const sourceNode = state.nodes.find((node) => node.id === source);
    const targetNode = state.nodes.find((node) => node.id === target);

    if (!sourceNode || !targetNode || targetNode.type !== CANVAS_NODE_TYPES.exportImage) {
      return false;
    }

    const isSupportedSource =
      sourceNode.type === CANVAS_NODE_TYPES.storyboardGen ||
      sourceNode.type === CANVAS_NODE_TYPES.imageEdit;
    if (!isSupportedSource) {
      return false;
    }

    return (targetNode.data as { isGenerating?: boolean } | undefined)?.isGenerating === true;
  });

  const { edgePath, labelX, labelY } = useMemo(() => {
    if (canvasEdgeRoutingMode === 'spline') {
      const [path, nextLabelX, nextLabelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      return {
        edgePath: path,
        labelX: nextLabelX,
        labelY: nextLabelY,
      };
    }

    const route = buildOrthogonalRoute({
      sourceId: source,
      targetId: target,
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Right,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Left,
      nodes: routeNodes,
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return {
      edgePath: route.path,
      labelX: route.labelX,
      labelY: route.labelY,
    };
  }, [
    canvasEdgeRoutingMode,
    routeNodes,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  const processingStroke = 'rgb(var(--accent-rgb) / 0.94)';
  const processingDashStroke = 'rgb(var(--accent-rgb) / 1)';
  const baseStrokeWidth = isProcessingEdge
    ? (selected ? 2.7 : 2.2)
    : (selected ? 2.4 : 1.9);

  return (
    <>
      {isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={processingDashStroke}
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="canvas-processing-edge__flow"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isProcessingEdge ? processingStroke : style?.stroke,
          strokeWidth: baseStrokeWidth,
          ...style,
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan absolute flex h-6 w-6 items-center justify-center text-text-muted transition-colors hover:text-text-dark"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onClick={(event) => {
              event.stopPropagation();
              deleteEdge(id);
            }}
            aria-label="断开连线"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M2 12C2 6.477 6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12m7.707-3.707a1 1 0 0 0-1.414 1.414L10.586 12l-2.293 2.293a1 1 0 1 0 1.414 1.414L12 13.414l2.293 2.293a1 1 0 0 0 1.414-1.414L13.414 12l2.293-2.293a1 1 0 0 0-1.414-1.414L12 10.586z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
