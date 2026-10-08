import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeDefinition, nodeHasSourceHandle, nodeHasTargetHandle } from '@/features/canvas/domain/nodeRegistry';

/**
 * Canvas2D 渲染层的场景模型（Render Model）。
 *
 * 设计原则（对应 docs/plans/2026-10-08-canvas2d-renderer-architecture.md）：
 * - 文档模型（zustand canvasStore）与渲染模型分离：本模块把 store 里的
 *   nodes/edges 转换成"绘制友好的扁平结构"（绝对坐标、类型归类、状态归一）。
 * - 纯函数、无 DOM / React / Tauri 依赖，可在 node 环境单测。
 * - 仅在 nodes/edges 引用变化时重建；拖拽等每帧手势不触碰 store，
 *   由 engine 以 delta 叠加方式绘制。
 */

export type RenderNodeKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'json'
  | 'tag'
  | 'tagGroup'
  | 'group'
  | 'storyboardSplit'
  | 'storyboardGen'
  | 'panorama'
  | 'blueprint'
  | 'ai';

export type RenderNodeStatus = 'ok' | 'gen' | 'fail';

export interface RenderNode {
  id: string;
  type: CanvasNodeType | undefined;
  kind: RenderNodeKind;
  /** 绝对世界坐标（已累加父链） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 绘制顺序（越大越靠前），同时用于命中测试优先级 */
  z: number;
  isGroup: boolean;
  title: string;
  /** 已解析为可显示 URL（resolveUrl 注入） */
  imageUrl: string | null;
  previewUrl: string | null;
  status: RenderNodeStatus;
  /** 主题色（标签颜色 / 类型色） */
  accent: string;
  /** 右上角小徽标文本（批次、帧数、时长等） */
  badge: string | null;
  /** 文本类节点的正文预览 */
  textPreview: string | null;
  /** 连接桩能力（来自 nodeRegistry.connectivity） */
  canSource: boolean;
  canTarget: boolean;
}

export interface RenderEdge {
  id: string;
  sourceId: string;
  targetId: string;
  state: 'idle' | 'gen' | 'fail';
}

export interface SceneBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneModel {
  /** 绘制顺序：分组最先（大组在后），随后普通节点按 store 顺序 */
  nodes: RenderNode[];
  byId: Map<string, RenderNode>;
  /** id → parentId（无父为 undefined），用于拖拽时展开后代集合 */
  parentOf: Map<string, string | undefined>;
  edges: RenderEdge[];
  bounds: SceneBounds;
  total: number;
}

const DEFAULT_NODE_HEIGHT = 150;
const TEXT_PREVIEW_LIMIT = 400;

const KIND_BY_TYPE: Record<string, RenderNodeKind> = {
  [CANVAS_NODE_TYPES.upload]: 'image',
  [CANVAS_NODE_TYPES.imageEdit]: 'image',
  [CANVAS_NODE_TYPES.exportImage]: 'image',
  [CANVAS_NODE_TYPES.video]: 'video',
  [CANVAS_NODE_TYPES.aiVideo]: 'video',
  [CANVAS_NODE_TYPES.audio]: 'audio',
  [CANVAS_NODE_TYPES.aiAudio]: 'audio',
  [CANVAS_NODE_TYPES.textAnnotation]: 'text',
  [CANVAS_NODE_TYPES.aiText]: 'ai',
  [CANVAS_NODE_TYPES.jsonCard]: 'json',
  [CANVAS_NODE_TYPES.group]: 'group',
  [CANVAS_NODE_TYPES.tag]: 'tag',
  [CANVAS_NODE_TYPES.tagGroup]: 'tagGroup',
  [CANVAS_NODE_TYPES.storyboardSplit]: 'storyboardSplit',
  [CANVAS_NODE_TYPES.storyboardGen]: 'storyboardGen',
  [CANVAS_NODE_TYPES.panorama]: 'panorama',
  [CANVAS_NODE_TYPES.blueprint]: 'blueprint',
};

export const KIND_ACCENT: Record<RenderNodeKind, string> = {
  image: '#38bdf8',
  video: '#a78bfa',
  audio: '#f472b6',
  text: '#34d399',
  json: '#fbbf24',
  tag: '#38bdf8',
  tagGroup: '#818cf8',
  group: '#64748b',
  storyboardSplit: '#fb923c',
  storyboardGen: '#fb923c',
  panorama: '#22d3ee',
  blueprint: '#f87171',
  ai: '#818cf8',
};

const TYPE_FALLBACK_LABEL: Record<string, string> = {
  [CANVAS_NODE_TYPES.upload]: '上传图',
  [CANVAS_NODE_TYPES.imageEdit]: 'AI 图片',
  [CANVAS_NODE_TYPES.exportImage]: '结果图',
  [CANVAS_NODE_TYPES.video]: '视频',
  [CANVAS_NODE_TYPES.aiVideo]: 'AI 视频',
  [CANVAS_NODE_TYPES.audio]: '音频',
  [CANVAS_NODE_TYPES.aiAudio]: 'AI 音频',
  [CANVAS_NODE_TYPES.textAnnotation]: '文本',
  [CANVAS_NODE_TYPES.aiText]: 'AI 文本',
  [CANVAS_NODE_TYPES.jsonCard]: 'JSON 卡片',
  [CANVAS_NODE_TYPES.group]: '分组',
  [CANVAS_NODE_TYPES.tag]: '标签',
  [CANVAS_NODE_TYPES.tagGroup]: '标签组',
  [CANVAS_NODE_TYPES.storyboardSplit]: '故事板',
  [CANVAS_NODE_TYPES.storyboardGen]: '故事板生成',
  [CANVAS_NODE_TYPES.panorama]: '全景',
  [CANVAS_NODE_TYPES.blueprint]: '导演台',
};

/** 标签颜色缺失时按源节点 id 哈希取色（与 TagNode"同源同色"策略一致的简化版） */
export function hashAccentColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 72%, 58%)`;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveSize(node: CanvasNode): { w: number; h: number } {
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  const w =
    (typeof node.measured?.width === 'number' && node.measured.width) ||
    (typeof node.width === 'number' && node.width) ||
    (typeof style?.width === 'number' && style.width) ||
    (typeof style?.width === 'string' && parseFloat(style.width)) ||
    getNodeDefinition(node.type)?.defaultSize?.width ||
    DEFAULT_NODE_WIDTH;
  const h =
    (typeof node.measured?.height === 'number' && node.measured.height) ||
    (typeof node.height === 'number' && node.height) ||
    (typeof style?.height === 'number' && style.height) ||
    (typeof style?.height === 'string' && parseFloat(style.height)) ||
    getNodeDefinition(node.type)?.defaultSize?.height ||
    DEFAULT_NODE_HEIGHT;
  return { w: Math.max(8, w), h: Math.max(8, h) };
}

function resolveStatus(data: Record<string, unknown>): RenderNodeStatus {
  if (data.isGenerating === true || data.isStreaming === true) return 'gen';
  const err = data.generationError ?? data.lastError ?? data.error ?? data.parseError;
  if ((typeof err === 'string' && err.length > 0) || (Array.isArray(err) && err.length > 0)) {
    return 'fail';
  }
  return 'ok';
}

function truncatePreview(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  return text.length > TEXT_PREVIEW_LIMIT ? text.slice(0, TEXT_PREVIEW_LIMIT) : text;
}

function joinJsonCardPreview(data: Record<string, unknown>): string | null {
  const fields = data.displayFields;
  if (Array.isArray(fields) && fields.length > 0) {
    const lines: string[] = [];
    for (const field of fields) {
      const item = field as { label?: unknown; value?: unknown };
      lines.push(`${str(item.label)}: ${str(item.value)}`);
    }
    return truncatePreview(lines.join('\n'));
  }
  return truncatePreview(str(data.rawContent));
}

export interface BuildSceneModelOptions {
  /** 把存储中的原始 URL 解析为可显示 URL（Tauri asset / data URL）。测试可传恒等函数。 */
  resolveUrl?: (url: string) => string;
}

/**
 * 从 store 的 nodes/edges 构建渲染模型。
 * O(N) 两遍扫描：第一遍解析绝对坐标（父链累加），第二遍生成绘制描述。
 */
export function buildSceneModel(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: BuildSceneModelOptions = {},
): SceneModel {
  const resolveUrl = options.resolveUrl ?? ((url: string) => url);
  const rawById = new Map<string, CanvasNode>();
  const parentOf = new Map<string, string | undefined>();
  for (const node of nodes) {
    rawById.set(node.id, node);
    parentOf.set(node.id, node.parentId);
  }

  // 第一遍：绝对坐标（父链累加，带环保护）
  const absById = new Map<string, { x: number; y: number }>();
  const resolveAbs = (node: CanvasNode): { x: number; y: number } => {
    const cached = absById.get(node.id);
    if (cached) return cached;
    absById.set(node.id, { x: node.position.x, y: node.position.y }); // 环保护占位
    let x = node.position.x;
    let y = node.position.y;
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = rawById.get(parentId);
      if (!parent) break;
      const parentAbs = resolveAbs(parent);
      x += parentAbs.x;
      y += parentAbs.y;
      parentId = parent.parentId;
    }
    const abs = { x, y };
    absById.set(node.id, abs);
    return abs;
  };

  const groups: RenderNode[] = [];
  const others: RenderNode[] = [];
  const byId = new Map<string, RenderNode>();

  nodes.forEach((node, index) => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const type = node.type;
    const kind = (type && KIND_BY_TYPE[type]) || 'image';
    const abs = resolveAbs(node);
    const size = resolveSize(node);
    const status = resolveStatus(data);

    let title = str(data.displayName).trim() || str(data.sourceFileName).trim();
    if (!title) title = str(data.label).trim();
    if (!title) title = (type && TYPE_FALLBACK_LABEL[type]) || '节点';

    let imageUrl: string | null = null;
    let previewUrl: string | null = null;
    let badge: string | null = null;
    let textPreview: string | null = null;
    let accent = KIND_ACCENT[kind];

    const rawImage = str(data.imageUrl);
    const rawPreview = str(data.previewImageUrl);
    if (rawImage) {
      imageUrl = resolveUrl(rawImage);
      previewUrl = resolveUrl(rawPreview || rawImage);
    }

    switch (kind) {
      case 'video': {
        const thumb = str(data.thumbnailUrl);
        if (!imageUrl && thumb) {
          imageUrl = resolveUrl(thumb);
          previewUrl = imageUrl;
        }
        const duration = data.durationSeconds;
        badge = typeof duration === 'number' && duration > 0 ? `▶ ${Math.round(duration)}s` : '▶ 视频';
        if (!textPreview) textPreview = truncatePreview(str(data.prompt));
        break;
      }
      case 'audio': {
        badge = '♪ 音频';
        textPreview = truncatePreview(str(data.prompt) || str(data.sourceFileName));
        break;
      }
      case 'text': {
        textPreview = truncatePreview(str(data.content));
        break;
      }
      case 'json': {
        badge = 'JSON';
        textPreview = joinJsonCardPreview(data);
        break;
      }
      case 'ai': {
        badge = 'AI';
        textPreview = truncatePreview(str(data.prompt));
        break;
      }
      case 'storyboardSplit': {
        const frames = Array.isArray(data.frames) ? (data.frames as Array<Record<string, unknown>>) : [];
        const first = frames.find((frame) => str(frame.imageUrl));
        if (!imageUrl && first) {
          imageUrl = resolveUrl(str(first.imageUrl));
          previewUrl = resolveUrl(str(first.previewImageUrl) || str(first.imageUrl));
        }
        badge = `${frames.length} 帧`;
        break;
      }
      case 'storyboardGen': {
        const frames = Array.isArray(data.frames) ? data.frames : [];
        badge = `${frames.length} 格`;
        break;
      }
      case 'panorama': {
        badge = '◎ 全景';
        break;
      }
      case 'blueprint': {
        const items = Array.isArray(data.items) ? data.items : [];
        badge = `⌂ ${items.length} 元素`;
        break;
      }
      case 'tag': {
        const custom = str(data.color);
        accent = custom || hashAccentColor(str(data.sourceId) || node.id);
        title = str(data.label).trim() || '标签';
        break;
      }
      case 'tagGroup': {
        const custom = str(data.color);
        const sources = Array.isArray(data.sources) ? data.sources : [];
        accent = custom || hashAccentColor(node.id);
        title = str(data.label).trim() || `标签组 ×${sources.length}`;
        badge = sources.length > 0 ? `${sources.length} 源` : null;
        break;
      }
      case 'group': {
        title = str(data.label).trim() || '分组';
        break;
      }
      case 'image': {
        const batchIndex = data.batchIndex;
        const batchTotal = data.batchTotal;
        if (typeof batchIndex === 'number' && typeof batchTotal === 'number' && batchTotal > 1) {
          badge = `${batchIndex + 1}/${batchTotal}`;
        }
        break;
      }
    }

    const renderNode: RenderNode = {
      id: node.id,
      type,
      kind,
      x: abs.x,
      y: abs.y,
      w: size.w,
      h: size.h,
      z: index,
      isGroup: kind === 'group',
      title,
      imageUrl,
      previewUrl: previewUrl || imageUrl,
      status,
      accent,
      badge,
      textPreview,
      canSource: type ? nodeHasSourceHandle(type) : false,
      canTarget: type ? nodeHasTargetHandle(type) : false,
    };
    byId.set(node.id, renderNode);
    if (renderNode.isGroup) groups.push(renderNode);
    else others.push(renderNode);
  });

  // 分组按面积降序（大组垫底），普通节点保持 store 顺序（后加的在上）
  groups.sort((a, b) => b.w * b.h - a.w * a.h);
  const ordered = [...groups, ...others];
  ordered.forEach((node, drawIndex) => {
    node.z = drawIndex;
  });

  const renderEdges: RenderEdge[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const state: RenderEdge['state'] =
      target.status === 'gen' ? 'gen' : target.status === 'fail' ? 'fail' : 'idle';
    renderEdges.push({ id: edge.id, sourceId: edge.source, targetId: edge.target, state });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of others) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  return {
    nodes: ordered,
    byId,
    parentOf,
    edges: renderEdges,
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    total: nodes.length,
  };
}
