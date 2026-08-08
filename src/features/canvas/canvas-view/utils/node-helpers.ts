import type { HandleType } from '@xyflow/react';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { getConnectMenuNodeTypes } from '@/features/canvas/domain/nodeRegistry';
import type { CanvasClipboardSnapshot } from '../types';

export function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

export function resolveAbsoluteNodePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let currentParentId = node.parentId;
  const visited = new Set<string>();
  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    currentParentId = parent.parentId;
  }
  return { x, y };
}

export function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): string[] {
  const nodeIds = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || nodeIds.has(node.id)) {
        continue;
      }
      if (nodeIds.has(node.parentId)) {
        nodeIds.add(node.id);
        changed = true;
      }
    }
  }
  return Array.from(nodeIds);
}

export function sortNodesForDuplication(nodes: CanvasNode[]): CanvasNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const depthCache = new Map<string, number>();
  const getDepth = (node: CanvasNode, visiting = new Set<string>()): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(node.id)) {
      return 0;
    }
    visiting.add(node.id);
    const parent = node.parentId ? nodeMap.get(node.parentId) : null;
    const depth = parent ? getDepth(parent, visiting) + 1 : 0;
    visiting.delete(node.id);
    depthCache.set(node.id, depth);
    return depth;
  };
  return [...nodes].sort((a, b) => getDepth(a) - getDepth(b));
}

export function getSnapshotBounds(
  snapshot: CanvasClipboardSnapshot
): { minX: number; minY: number } | null {
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of snapshot.nodes) {
    const absolute = resolveAbsoluteNodePosition(node, nodeMap);
    minX = Math.min(minX, absolute.x);
    minY = Math.min(minY, absolute.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }
  return { minX, minY };
}

export function buildDuplicateEdge(
  edge: CanvasEdge,
  nextSource: string,
  nextTarget: string,
  existingEdgeIds: Set<string>
): CanvasEdge {
  let edgeId = `e-${nextSource}-${nextTarget}`;
  if (existingEdgeIds.has(edgeId)) {
    const baseEdgeId = `${edgeId}-copy`;
    let copyIndex = 1;
    edgeId = `${baseEdgeId}-${copyIndex}`;
    while (existingEdgeIds.has(edgeId)) {
      copyIndex += 1;
      edgeId = `${baseEdgeId}-${copyIndex}`;
    }
  }
  existingEdgeIds.add(edgeId);
  return {
    ...cloneNodeData(edge),
    id: edgeId,
    source: nextSource,
    target: nextTarget,
    sourceHandle: edge.sourceHandle ?? 'source',
    targetHandle: edge.targetHandle ?? 'target',
    type: edge.type ?? 'disconnectableEdge',
    selected: false,
  };
}

export function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

export function resolveAllowedNodeTypes(handleType: HandleType): CanvasNodeType[] {
  return getConnectMenuNodeTypes(handleType);
}

export function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage
    || type === CANVAS_NODE_TYPES.video
    || type === CANVAS_NODE_TYPES.audio
    || type === CANVAS_NODE_TYPES.aiText
    || type === CANVAS_NODE_TYPES.textAnnotation
    || type === CANVAS_NODE_TYPES.jsonCard
    || type === CANVAS_NODE_TYPES.tag;
}

export function canNodeBeManualConnectionSource(
  nodeId: string | null | undefined,
  nodes: CanvasNode[]
): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

export function getGeneratedTextForConnection(sourceNode: CanvasNode, nodes: CanvasNode[]): string {
  if (sourceNode.type === CANVAS_NODE_TYPES.textAnnotation) {
    const content = (sourceNode.data as { content?: unknown }).content;
    return typeof content === 'string' ? content.trim() : '';
  }
  if (sourceNode.type === CANVAS_NODE_TYPES.jsonCard) {
    const data = sourceNode.data as { parsedJson?: unknown; rawContent?: unknown };
    if (data.parsedJson !== null && data.parsedJson !== undefined) {
      try {
        return JSON.stringify(data.parsedJson, null, 2);
      } catch {
        return String(data.parsedJson);
      }
    }
    return typeof data.rawContent === 'string' ? data.rawContent.trim() : '';
  }
  if (sourceNode.type === CANVAS_NODE_TYPES.aiText) {
    const resultNodeId = (sourceNode.data as { resultNodeId?: unknown }).resultNodeId;
    const resultNode = typeof resultNodeId === 'string'
      ? nodes.find((node) => node.id === resultNodeId)
      : null;
    const resultContent = resultNode?.type === CANVAS_NODE_TYPES.textAnnotation
      ? (resultNode.data as { content?: unknown }).content
      : null;
    if (typeof resultContent === 'string' && resultContent.trim()) {
      return resultContent.trim();
    }
    const fallbackResult = nodes.find((node) => (
      node.type === CANVAS_NODE_TYPES.textAnnotation
      && (node.data as { sourceAiNodeId?: unknown }).sourceAiNodeId === sourceNode.id
    ));
    const fallbackContent = fallbackResult
      ? (fallbackResult.data as { content?: unknown }).content
      : null;
    return typeof fallbackContent === 'string' ? fallbackContent.trim() : '';
  }
  return '';
}

export function isLikelyVideoSourceText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return /\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed)
    || /^https?:\/\/.+\/.+\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed)
    || /^file:\/\/.+\/.+\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed);
}