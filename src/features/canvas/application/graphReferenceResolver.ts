import {
  CANVAS_NODE_TYPES,
  isAiTextNode,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isJsonCardNode,
  isTagNode,
  isTagGroupNode, // ← 新增：标签组类型守卫
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
  type TagGroupNodeData, // ← 新增：标签组数据类型
} from '@/features/canvas/domain/canvasNodes';

import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';

export type GraphReferenceKind = 'image' | 'video' | 'audio' | 'text';

export interface GraphReferenceItem {
  kind: GraphReferenceKind;
  sourceNodeId: string;
  label: string;
  token: string;
  content?: string;
  imageUrl?: string;
  previewImageUrl?: string | null;
  videoUrl?: string;
  thumbnailUrl?: string | null;
  audioUrl?: string;
  title: string;
  /**
   * 标签组里给这条源起的自定义别名，仅用于 UI 展示（比如 @ 选择列表里
   * 让用户能视觉上区分是哪张图），不参与 label/token 的生成——
   * token 必须始终是固定的「图1」「视频2」这类格式，因为 prompt 里
   * 剥离 @ 符号的正则（以及其他依赖固定格式的解析逻辑）只认这种格式。
   */
  customLabel?: string;
}

// 内部辅助接口：用于在穿透过程中携带自定义别名
interface ResolvedSource {
  node: CanvasNode;
  customLabel?: string;
}

function getNodeTitle(node: CanvasNode): string {
  return resolveNodeDisplayName(node.type, node.data) || node.id;
}

function getTextContentForNode(node: CanvasNode, nodesById: Map<string, CanvasNode>): string {
  if (isTextAnnotationNode(node)) {
    return typeof node.data.content === 'string' ? node.data.content.trim() : '';
  }

  if (isJsonCardNode(node)) {
    if (node.data.parsedJson !== null && node.data.parsedJson !== undefined) {
      try {
        return JSON.stringify(node.data.parsedJson, null, 2);
      } catch {
        return String(node.data.parsedJson);
      }
    }
    return typeof node.data.rawContent === 'string' ? node.data.rawContent.trim() : '';
  }

  if (isAiTextNode(node)) {
    const resultNodeId = typeof node.data.resultNodeId === 'string' ? node.data.resultNodeId : '';
    const resultNode = resultNodeId ? nodesById.get(resultNodeId) : null;

    if (resultNode && isTextAnnotationNode(resultNode)) {
      return typeof resultNode.data.content === 'string' ? resultNode.data.content.trim() : '';
    }

    const fallbackResult = Array.from(nodesById.values()).find((candidate) => (
      isTextAnnotationNode(candidate) && candidate.data.sourceAiNodeId === node.id
    ));

    return fallbackResult && isTextAnnotationNode(fallbackResult)
      ? (typeof fallbackResult.data.content === 'string' ? fallbackResult.data.content.trim() : '')
      : '';
  }

  return '';
}

function extractReferenceFromNode(
  node: CanvasNode | undefined,
  nodesById: Map<string, CanvasNode>,
): Omit<GraphReferenceItem, 'label' | 'token'> | null {
  if (!node) {
    return null;
  }

  const title = getNodeTitle(node);

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    const imageUrl = node.data.imageUrl || node.data.previewImageUrl || '';
    if (!imageUrl) {
      return null;
    }
    return {
      kind: 'image',
      sourceNodeId: node.id,
      imageUrl,
      previewImageUrl: node.data.previewImageUrl ?? null,
      title,
    };
  }

  if (isVideoNode(node)) {
    const videoUrl = node.data.localVideoUrl || node.data.videoUrl || '';
    if (!videoUrl) {
      return null;
    }
    return {
      kind: 'video',
      sourceNodeId: node.id,
      videoUrl,
      thumbnailUrl: node.data.thumbnailUrl ?? null,
      title,
    };
  }

  if (isAudioNode(node)) {
    const audioUrl = node.data.localAudioUrl || node.data.audioUrl || '';
    if (!audioUrl) {
      return null;
    }
    return {
      kind: 'audio',
      sourceNodeId: node.id,
      audioUrl,
      title,
    };
  }

  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation ||
    node.type === CANVAS_NODE_TYPES.jsonCard ||
    node.type === CANVAS_NODE_TYPES.aiText
  ) {
    const content = getTextContentForNode(node, nodesById);
    if (!content) {
      return null;
    }
    return {
      kind: 'text',
      sourceNodeId: node.id,
      content,
      title,
    };
  }

  return null;
}

function labelPrefixForKind(kind: GraphReferenceKind): string {
  switch (kind) {
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    case 'text':
      return '文本';
    case 'image':
    default:
      return '图';
  }
}

/**
 * 核心穿透逻辑：
 * 1. 单标签 (TagNode)：继续向上穿透。
 * 2. 标签组 (TagGroupNode)：只穿透 enabled=true 的源，并携带 customLabel。
 * 3. 普通节点：直接返回。
 */
function collectReferenceSourceNodes(
  nodeId: string,
  nodesById: Map<string, CanvasNode>,
  edges: CanvasEdge[],
  visited: Set<string>,
  inheritedLabel?: string
): ResolvedSource[] {
  const sources: ResolvedSource[] = [];

  edges
    .filter((edge) => edge.target === nodeId)
    .forEach((edge) => {
      const sourceNode = nodesById.get(edge.source);
      
      // 防止死循环
      if (!sourceNode || visited.has(sourceNode.id)) {
        return;
      }
      visited.add(sourceNode.id);

      if (isTagNode(sourceNode)) {
        // 单标签：继续向上穿透
        sources.push(...collectReferenceSourceNodes(sourceNode.id, nodesById, edges, visited, inheritedLabel));
      } else if (isTagGroupNode(sourceNode)) {
        // 标签组：处理内部启用的源
        const groupData = sourceNode.data as TagGroupNodeData;
        const enabledSources = (groupData.sources || []).filter(s => s.enabled);
        
        // 找到连接到该标签组的所有入边
        const groupIncomingEdges = edges.filter(e => e.target === sourceNode.id);

        enabledSources.forEach(enabledSource => {
          // 根据 edgeId 匹配实际的连线
          const actualEdge = groupIncomingEdges.find(e => e.id === enabledSource.edgeId);
          if (!actualEdge) {
            return;
          }
          const upstreamNode = nodesById.get(actualEdge.source);
          if (!upstreamNode || visited.has(upstreamNode.id)) {
            return;
          }
          visited.add(upstreamNode.id);

          if (isTagNode(upstreamNode) || isTagGroupNode(upstreamNode)) {
            // 上游本身还是标签/标签组（嵌套场景），才需要继续穿透
            sources.push(
              ...collectReferenceSourceNodes(upstreamNode.id, nodesById, edges, visited, enabledSource.customLabel)
            );
          } else {
            // 普通节点：直接收集它本身，而不是去查“喂给它的上游”——
            // 之前这里错误地把 upstreamNode.id 当成中转节点递归，
            // 导致像上传节点这类没有入边的上游被当成“无来源”而丢失，
            // 或者被错误地穿透到再上一层、指向了完全不同的节点。
            sources.push({ node: upstreamNode, customLabel: enabledSource.customLabel });
          }
        });
      } else {
        // 普通节点：收集
        sources.push({ node: sourceNode, customLabel: inheritedLabel });
      }
    });

  return sources;
}

export function collectInputReferences(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GraphReferenceItem[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const counts: Record<GraphReferenceKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
  };
  const seen = new Set<string>();
  const references: GraphReferenceItem[] = [];

  collectReferenceSourceNodes(nodeId, nodesById, edges, new Set<string>())
    .forEach((sourceItem) => {
      const extracted = extractReferenceFromNode(sourceItem.node, nodesById);
      if (!extracted) {
        return;
      }

      // 优化去重：如果同一个源节点有不同的自定义别名，允许共存
      const dedupeKey = `${extracted.kind}:${extracted.sourceNodeId}:${sourceItem.customLabel || ''}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      counts[extracted.kind] += 1;

      // label/token 始终走标准编号（图1/视频2/文本3...），不使用自定义别名——
      // 自定义命名只用于标签组内部的视觉区分，通过 customLabel 字段单独展示。
      const label = `${labelPrefixForKind(extracted.kind)}${counts[extracted.kind]}`;

      references.push({
        ...extracted,
        label,
        token: `@${label}`,
        customLabel: sourceItem.customLabel,
      });
    });

  return references;
}

export function collectInputImageUrls(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string[] {
  return collectInputReferences(nodeId, nodes, edges)
    .filter((reference) => reference.kind === 'image' && reference.imageUrl)
    .map((reference) => reference.imageUrl as string);
}

export function buildReferenceContextPrompt(references: GraphReferenceItem[]): string {
  const contextual = references.filter((reference) => reference.kind !== 'image');
  if (contextual.length === 0) {
    return '';
  }

  const lines = contextual.map((reference) => {
    if (reference.kind === 'video') {
      return `- ${reference.token}：视频参考「${reference.title}」。请将它作为动作、节奏、镜头或场景连续性参考；支持视频引用的模型会收到对应视频 URL。`;
    }
    if (reference.kind === 'audio') {
      return `- ${reference.token}：音频参考「${reference.title}」。请将它作为对白、旁白、音乐、音色或节奏参考；支持音频引用的模型会收到对应音频 URL。`;
    }

    const content = (reference.content ?? '').trim();
    const excerpt = content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
    return `- ${reference.token}：文本参考「${reference.title}」\n${excerpt}`;
  });

  return `## 连接参考说明\n${lines.join('\n')}`;
}