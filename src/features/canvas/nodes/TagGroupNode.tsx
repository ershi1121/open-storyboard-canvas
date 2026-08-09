import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Handle,
  NodeResizeControl,
  Position,
  useEdges,
  useUpdateNodeInternals,
} from '@xyflow/react';
import {
  FileText,
  Image as ImageIcon,
  Layers,
  Music,
  Tag as TagIcon,
  Trash2,
  Video,
} from 'lucide-react';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiCheckbox, UiInput } from '@/components/ui';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  CANVAS_NODE_TYPES,
  isTagNode,
  isTagGroupNode,
  type CanvasEdge,
  type CanvasNode,
  type TagGroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import { pruneDeadReferenceTokens } from '@/features/canvas/application/referenceTokenEditing';

// 卡片尺寸：默认高度与 AI 图片节点一致（380）
const TAG_GROUP_DEFAULT_WIDTH = 320;
const TAG_GROUP_DEFAULT_HEIGHT = 380;
const TAG_GROUP_MIN_WIDTH = 240;
const TAG_GROUP_MIN_HEIGHT = 220;
const TAG_GROUP_MAX_WIDTH = 900;
const TAG_GROUP_MAX_HEIGHT = 900;
const FALLBACK_TAG_GROUP_COLOR = '#3b82f6';

type SourceKind = 'image' | 'video' | 'text' | 'audio' | 'tag' | 'node';

const KIND_LABEL: Record<SourceKind, string> = {
  image: '图像',
  video: '视频',
  text: '文本',
  audio: '音频',
  tag: '标签',
  node: '节点',
};

function resolveSourceKind(node: CanvasNode | undefined): SourceKind {
  if (!node) return 'node';
  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
      return 'image';
    case CANVAS_NODE_TYPES.aiVideo:
    case CANVAS_NODE_TYPES.video:
      return 'video';
    case CANVAS_NODE_TYPES.aiText:
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.jsonCard:
      return 'text';
    case CANVAS_NODE_TYPES.aiAudio:
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    case CANVAS_NODE_TYPES.tag:
      return 'tag';
    default:
      return 'node';
  }
}

function resolveSourcePreviewUrl(node: CanvasNode | undefined): string | null {
  if (!node) return null;
  const data = node.data as Record<string, unknown>;
  const raw =
    (data.imageUrl as string | null | undefined) ||
    (data.previewImageUrl as string | null | undefined) ||
    (data.thumbnailUrl as string | null | undefined) ||
    null;
  return typeof raw === 'string' && raw.trim() !== '' ? resolveImageDisplayUrl(raw) : null;
}

function resolveKindIcon(kind: SourceKind) {
  switch (kind) {
    case 'image':
      return ImageIcon;
    case 'video':
      return Video;
    case 'text':
      return FileText;
    case 'audio':
      return Music;
    case 'tag':
      return TagIcon;
    default:
      return Layers;
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized.split('').map((ch) => `${ch}${ch}`).join('')
      : normalized;
  const value = parseInt(full, 16);
  if (Number.isNaN(value) || (full.length !== 6 && full.length !== 3)) {
    // 非法颜色时回退到同一套 FALLBACK 颜色，而不是硬编码的蓝色，
    // 这样 borderColor（直接用 accentColor）和其余用 hexToRgba 算出来的颜色
    // 才不会出现"边框一个色、内部一个色"的撞色问题。
    return hex === FALLBACK_TAG_GROUP_COLOR
      ? `rgba(59, 130, 246, ${alpha})`
      : hexToRgba(FALLBACK_TAG_GROUP_COLOR, alpha);
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 🆕 新增：内容哈希取色（照搬 TagNode.tsx 的 getTagPalette 思路）。
 * 之前标签组没有这套逻辑，只要用户没手动设置 data.color，
 * 所有标签组不管内容是什么，全部落到同一个 FALLBACK_TAG_GROUP_COLOR，
 * 导致"内容不同也会同色"。
 *
 * 内容 key 用 displayName + 排序后的 sourceNodeId 列表——
 * 不用 customLabel，因为用户改别名不应该改变颜色；
 * 也不用 edgeId（连线本身的技术性 id 会因为断开重连而变化，
 * 但如果连的还是同一批源，颜色应当保持不变）。
 */
function hashString(str: string, salt = ''): number {
  const input = str + salt;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getGroupAutoColor(data: TagGroupNodeData): string {
  const contentKey = [
    (data.displayName || '').trim(),
    ...((data.sources || []).map((s) => s.sourceNodeId).sort()),
  ].join('|');

  // 内容为空（刚创建、还没连任何源）时，用固定颜色，
  // 避免空标签组之间反而因为哈希碰撞显得"随机"
  if (!contentKey.replace(/\|/g, '')) {
    return FALLBACK_TAG_GROUP_COLOR;
  }

  const hueHash = hashString(contentKey, '#hue');
  const satHash = hashString(contentKey, '#sat');
  const lightHash = hashString(contentKey, '#light');

  const hue = hueHash % 360;
  const sat = 55 + (satHash % 25); // 55–80%
  const light = 40 + (lightHash % 14); // 40–54%

  return hslToHex(hue, sat, light);
}

/**
 * 🆕 新增：从标签组出发，沿着下游连线正向 BFS，
 * 找出所有"消费"这个标签组引用（即 data.prompt 是字符串）的节点。
 * 中途遇到 Tag / TagGroup 节点会继续往下穿透，因为标签本身
 * 不消费引用，只是转发。
 */
function findDownstreamPromptConsumerIds(
  startId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): string[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n] as const));
  const visited = new Set<string>([startId]);
  const queue = [startId];
  const consumerIds: string[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const outgoing = edges.filter((e) => e.source === currentId);

    for (const edge of outgoing) {
      const targetNode = nodesById.get(edge.target);
      if (!targetNode || visited.has(targetNode.id)) continue;
      visited.add(targetNode.id);

      if (isTagNode(targetNode) || isTagGroupNode(targetNode)) {
        // 标签/标签组只是转发节点，继续往下游穿透
        queue.push(targetNode.id);
        continue;
      }

      const promptValue = (targetNode.data as Record<string, unknown>)?.prompt;
      if (typeof promptValue === 'string') {
        consumerIds.push(targetNode.id);
      }
      // 普通节点也可能再往下游连（比如导出节点之后还接了别的节点），
      // 但通常消费型节点（AI 图片/视频节点）已经是终点，这里不再继续穿透，
      // 避免不必要的遍历；如需支持更深链路，把 continue 换成 queue.push 即可。
    }
  }

  return consumerIds;
}

export const TagGroupNode = memo((props: any) => {
  const { id, data, selected, width, height } = props as {
    id: string;
    data: TagGroupNodeData;
    selected?: boolean;
    width?: number;
    height?: number;
  };

  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const deleteEdge = useCanvasStore((s) => s.deleteEdge);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useEdges();

  const [preview, setPreview] = useState<{ url: string; left: number; top: number } | null>(null);

  const connectedEdges = useMemo(() => edges.filter((e) => e.target === id), [edges, id]);

  // 连线变化时同步 sources（支持多上游）
  useEffect(() => {
    const currentSourceIds = new Set((data.sources || []).map((s) => s.edgeId));
    const validEdgeIds = new Set(connectedEdges.map((e) => e.id));

    let nextSources = (data.sources || []).filter((s) => validEdgeIds.has(s.edgeId));
    let changed = nextSources.length !== (data.sources || []).length;

    for (const edge of connectedEdges) {
      if (!currentSourceIds.has(edge.id)) {
        nextSources.push({
          edgeId: edge.id,
          sourceNodeId: edge.source,
          customLabel: `源 ${nextSources.length + 1}`,
          enabled: true,
        });
        changed = true;
      }
    }

    if (changed) {
      updateNodeData(id, { sources: nextSources });
    }
  }, [connectedEdges, data.sources, id, updateNodeData]);

  // 尺寸/连线变化后刷新锚点（修复边缘计算）
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, width, height, connectedEdges.length, updateNodeInternals]);

  const nodeById = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const n of nodes) map.set(n.id, n as CanvasNode);
    return map;
  }, [nodes]);

  const handleThumbEnter = useCallback((event: React.MouseEvent<HTMLElement>, url: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const SIZE = 240;
    const left = Math.min(rect.right + 10, window.innerWidth - SIZE - 16);
    const top = Math.max(16, Math.min(rect.top - 8, window.innerHeight - SIZE - 16));
    setPreview({ url, left, top });
  }, []);

  const handleThumbLeave = useCallback(() => setPreview(null), []);

  // 🆕 新增：禁用/启用某个源之后，找到所有下游消费节点，
  // 清理它们 prompt 文本里那些"查无对应引用"的死 @token——
  // 只清理"刚刚变化"的这一条源自己失效的 token，其余源不受影响
  // （因为 graphReferenceResolver 里已经保证了编号不会因为
  // 这条源被禁用而重新洗牌）。
  const pruneDownstreamDeadTokens = useCallback(() => {
    const state = useCanvasStore.getState();
    const consumerIds = findDownstreamPromptConsumerIds(id, state.nodes, state.edges);

    consumerIds.forEach((consumerId) => {
      const consumerNode = state.nodes.find((n) => n.id === consumerId);
      const prompt = (consumerNode?.data as Record<string, unknown> | undefined)?.prompt;
      if (typeof prompt !== 'string' || !prompt) return;

      const validTokens = new Set(
        collectInputReferences(consumerId, state.nodes, state.edges).map((r) => r.token)
      );
      const cleaned = pruneDeadReferenceTokens(prompt, validTokens);

      if (cleaned !== prompt) {
        state.updateNodeData(consumerId, { prompt: cleaned });
      }
    });
  }, [id]);

  const handleToggle = (edgeId: string, enabled: boolean) => {
    updateNodeData(id, {
      sources: (data.sources || []).map((s) => (s.edgeId === edgeId ? { ...s, enabled } : s)),
    });
    // 用 microtask 让 sources 的更新先落到 store 里，
    // 保证下面重新计算 collectInputReferences 时读到的是最新状态
    queueMicrotask(pruneDownstreamDeadTokens);
  };

  const handleRename = (edgeId: string, customLabel: string) => {
    updateNodeData(id, {
      sources: (data.sources || []).map((s) => (s.edgeId === edgeId ? { ...s, customLabel } : s)),
    });
  };

  const resolvedWidth = typeof width === 'number' && width > 0 ? width : TAG_GROUP_DEFAULT_WIDTH;
  const resolvedHeight = typeof height === 'number' && height > 0 ? height : TAG_GROUP_DEFAULT_HEIGHT;

  const isValidHexColor = (value: string) => /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

  const accentColor = useMemo(() => {
    if (typeof data.color === 'string' && isValidHexColor(data.color)) {
      return data.color.trim();
    }
    return getGroupAutoColor(data);
  }, [data]);

  const sources = data.sources || [];
  const borderColor = selected ? accentColor : hexToRgba(accentColor, 0.55);
  const ringColor = selected ? hexToRgba(accentColor, 0.28) : hexToRgba(accentColor, 0.14);

  return (
    <div
      className="group relative flex flex-col overflow-visible rounded-xl border bg-[var(--canvas-node-bg)] shadow-sm transition-colors duration-150"
      style={{
        width: resolvedWidth,
        height: resolvedHeight,
        minWidth: TAG_GROUP_MIN_WIDTH,
        minHeight: TAG_GROUP_MIN_HEIGHT,
        borderColor,
        boxShadow: `0 0 0 3px ${ringColor}`,
      }}
    >
      {/* 均匀底色层 */}
      <div
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{ background: hexToRgba(accentColor, 0.08) }}
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={
          <span
            className="flex h-5 w-5 items-center justify-center rounded-md border"
            style={{
              background: hexToRgba(accentColor, 0.16),
              borderColor: hexToRgba(accentColor, 0.35),
              color: accentColor,
            }}
          >
            <Layers className="h-3.5 w-3.5" />
          </span>
        }
        titleText={data.displayName || '标签组'}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {/* 内容区 */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col p-3">
        {/* ✅ 修复滚轮缩放画布：nowheel + nodrag，滚轮只滚动列表 */}
        <div
          className="ui-scrollbar nowheel nodrag flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5"
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {sources.length === 0 ? (
            <div
              className="flex min-h-[140px] flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center"
              style={{
                borderColor: hexToRgba(accentColor, 0.35),
                background: hexToRgba(accentColor, 0.05),
              }}
            >
              <Layers className="h-5 w-5" style={{ color: accentColor }} />
              <span className="text-xs text-text-muted">从左侧连接多个上游源</span>
            </div>
          ) : (
            sources.map((source) => {
              const sourceNode = nodeById.get(source.sourceNodeId);
              const kind = resolveSourceKind(sourceNode);
              const previewUrl = resolveSourcePreviewUrl(sourceNode);
              const KindIcon = resolveKindIcon(kind);

              return (
                <div
                  key={source.edgeId}
                  className={`flex items-center gap-2 rounded-lg border p-2 transition-all ${
                    source.enabled ? '' : 'opacity-45'
                  }`}
                  style={{
                    borderColor: source.enabled ? hexToRgba(accentColor, 0.24) : 'transparent',
                    background: source.enabled ? hexToRgba(accentColor, 0.06) : 'transparent',
                  }}
                >
                  <UiCheckbox
                    checked={source.enabled}
                    onCheckedChange={(checked) => handleToggle(source.edgeId, !!checked)}
                  />

                  {kind === 'image' && previewUrl ? (
                    <button
                      type="button"
                      className="h-7 w-7 shrink-0 overflow-hidden rounded-md border"
                      style={{ borderColor: hexToRgba(accentColor, 0.35) }}
                      onMouseEnter={(e) => handleThumbEnter(e, previewUrl)}
                      onMouseLeave={handleThumbLeave}
                      onClick={(e) => e.stopPropagation()}
                      title="悬停预览大图"
                    >
                      <img src={previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                    </button>
                  ) : (
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border"
                      style={{
                        borderColor: hexToRgba(accentColor, 0.35),
                        background: hexToRgba(accentColor, 0.1),
                        color: accentColor,
                      }}
                    >
                      <KindIcon className="h-3.5 w-3.5" />
                    </span>
                  )}

                  <UiInput
                    value={source.customLabel}
                    onChange={(e) => handleRename(source.edgeId, e.target.value)}
                    className="nodrag nowheel h-7 min-w-0 flex-1 text-xs"
                    placeholder="自定义别名"
                  />

                  <span
                    className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
                    style={{
                      borderColor: hexToRgba(accentColor, 0.35),
                      background: hexToRgba(accentColor, 0.1),
                      color: accentColor,
                    }}
                  >
                    {KIND_LABEL[kind]}
                  </span>

                  <button
                    type="button"
                    className="text-text-muted transition-colors hover:text-red-500"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteEdge(source.edgeId);
                    }}
                    title="断开连接"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ✅ 修复连下游：连接点提到 z-30，不再被内容层遮挡 */}
      <Handle
        type="target"
        id="target"
        position={Position.Left}
        isConnectable={true}
        className="!z-30 !h-3 !w-3 !border-2 !border-white shadow"
        style={{ background: accentColor }}
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        isConnectable={true}
        className="!z-30 !h-3 !w-3 !border-2 !border-white shadow"
        style={{ background: accentColor }}
      />

      {/* ✅ 修复宽度不能缩小：缩放手柄提到 z-30，不再被内容层盖住 */}
      <NodeResizeControl
        position="bottom-right"
        minWidth={TAG_GROUP_MIN_WIDTH}
        minHeight={TAG_GROUP_MIN_HEIGHT}
        maxWidth={TAG_GROUP_MAX_WIDTH}
        maxHeight={TAG_GROUP_MAX_HEIGHT}
        className="!z-30 !h-4 !w-4 !min-h-0 !min-w-0 !rounded-none !border-0 !bg-transparent !p-0 !opacity-0 transition-opacity duration-100 hover:!opacity-100 focus-within:!opacity-100"
      >
        <div
          className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b-2 border-r-2"
          style={{ borderColor: hexToRgba(accentColor, 0.85) }}
        />
      </NodeResizeControl>

      {/* 悬停大图预览 */}
      {preview && (
        <div
          className="pointer-events-none fixed z-[9999] rounded-lg border border-[var(--canvas-node-border)] bg-[var(--canvas-node-bg)] p-1.5 shadow-2xl"
          style={{ left: preview.left, top: preview.top }}
        >
          <img
            src={preview.url}
            alt=""
            className="h-56 w-56 rounded-md object-contain"
            style={{ background: 'rgba(0,0,0,0.06)' }}
            draggable={false}
          />
        </div>
      )}
    </div>
  );
});

TagGroupNode.displayName = 'TagGroupNode';