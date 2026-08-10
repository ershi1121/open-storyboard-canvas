import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Handle,
  NodeResizeControl,
  NodeToolbar,
  Position,
  useEdges,
  useUpdateNodeInternals,
} from '@xyflow/react';
import {
  FileText,
  Image as ImageIcon,
  Layers,
  Link2,
  Music,
  Tag as TagIcon,
  Trash2,
  Video,
} from 'lucide-react';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { UiCheckbox, UiChipButton, UiInput, UiPanel } from '@/components/ui';
import { BatchConnectModal } from '@/features/canvas/ui/BatchConnectModal';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from '@/features/canvas/ui/nodeToolbarConfig';
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

const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';

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
    return hex === FALLBACK_TAG_GROUP_COLOR
      ? `rgba(59, 130, 246, ${alpha})`
      : hexToRgba(FALLBACK_TAG_GROUP_COLOR, alpha);
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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
  let r = 0, g = 0, b = 0;
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

function resolveTagGroupColorKey(data: TagGroupNodeData): string {
  const sourceIds = (data.sources || [])
    .map((s) => s.sourceNodeId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .sort();

  if (sourceIds.length > 0) {
    return `src:${sourceIds.join('|')}`;
  }

  const name = (data.displayName || '').trim();
  return name ? `text:${name}` : '';
}

/**
 * 🎨 标签组配色规则：由「连接的源节点集合」决定——
 * 连接相同的一批源才会同色；只有相同源节点才允许相同颜色。
 * 未连接源时退化为按组名计算；名称也为空时用回退色。
 */
function getGroupAutoColor(data: TagGroupNodeData, isDark: boolean): string {
  const colorKey = resolveTagGroupColorKey(data);
  if (!colorKey) {
    return FALLBACK_TAG_GROUP_COLOR;
  }

  const hueHash = hashString(colorKey, '#hue');
  const satHash = hashString(colorKey, '#sat');
  const lightHash = hashString(colorKey, '#light');
  const hue = hueHash % 360;
  const sat = 55 + (satHash % 25); // 55–80%
  const light = isDark ? 55 + ((lightHash >> 8) % 14) : 40 + (lightHash % 14);
  return hslToHex(hue, sat, light);
}

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
        queue.push(targetNode.id);
        continue;
      }
      const promptValue = (targetNode.data as Record<string, unknown>)?.prompt;
      if (typeof promptValue === 'string') {
        consumerIds.push(targetNode.id);
      }
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
  const deleteNode = useCanvasStore((s) => s.deleteNode);
  const nodes = useCanvasStore((s) => s.nodes);
  const isDark = useThemeStore((s) => s.theme) === 'dark';
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useEdges();
  const [preview, setPreview] = useState<{ url: string; left: number; top: number } | null>(null);
  const [isBatchConnectOpen, setIsBatchConnectOpen] = useState(false);

  // ✅ 新增：复制自愈保护标记
  const healingRef = useRef(false);

  const sourceNode = useCanvasStore((s) => s.nodes.find((n) => n.id === id)) as
    | CanvasNode
    | undefined;

  const connectedEdges = useMemo(() => edges.filter((e) => e.target === id), [edges, id]);

  // ✅ 新增：复制自愈——粘贴出来的标签组带着 data.sources（含 sourceNodeId），
  // 但入边不会跟着复制过来，导致标签组"丢失源"。
  // 挂载时检查一次：记录的源节点还在画布上、但入边缺失时，按旧记录补建连线，
  // 交给下面的同步逻辑接管（自定义别名/启用状态都能保留）。
  useEffect(() => {
    const state = useCanvasStore.getState() as any;
    const self = (state.nodes ?? []).find((n: any) => n.id === id);
    const saved = (self?.data?.sources ?? []) as Array<{ sourceNodeId?: string }>;
    if (saved.length === 0) return;

    const nodesList: any[] = state.nodes ?? [];
    const edgesList: any[] = state.edges ?? [];
    const items = saved
      .filter((s) => {
        const srcId = s?.sourceNodeId;
        if (!srcId) return false;
        if (!nodesList.some((n: any) => n.id === srcId)) return false;
        return !edgesList.some((e: any) => e.target === id && e.source === srcId);
      })
      .map((s) => ({
        id: `e-${s.sourceNodeId}-${id}`,
        source: s.sourceNodeId as string,
        target: id,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'disconnectableEdge',
      }));

    if (items.length === 0) return;
    healingRef.current = true;
    if (typeof state.onEdgesChange === 'function') {
      state.onEdgesChange(items.map((item) => ({ type: 'add', item })));
    } else if (typeof state.addEdge === 'function') {
      items.forEach((e) => state.addEdge(e.source, e.target));
    }
  }, [id]);

  // ✅ 修改：连线变化时同步 sources（支持多上游）+ 配合复制自愈
  useEffect(() => {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const validEdgeIds = new Set(connectedEdges.map((e) => e.id));
    const saved = data.sources || [];

    // 自愈期间：允许"源节点还在、边还没落库"的旧记录存活，避免粘贴信息被清空
    let nextSources = saved.filter(
      (s) => validEdgeIds.has(s.edgeId) || (healingRef.current && nodeIds.has(s.sourceNodeId))
    );

    // 自愈补建的边 id 与旧 edgeId 不同：回写为新边 id（保留自定义别名/启用状态）
    nextSources = nextSources.map((s) => {
      const live = connectedEdges.find((e) => e.source === s.sourceNodeId);
      return live && live.id !== s.edgeId ? { ...s, edgeId: live.id } : s;
    });

    let changed =
      nextSources.length !== saved.length ||
      nextSources.some((s, i) => s.edgeId !== saved[i]?.edgeId);

    for (const edge of connectedEdges) {
      if (!nextSources.some((s) => s.sourceNodeId === edge.source)) {
        nextSources.push({
          edgeId: edge.id,
          sourceNodeId: edge.source,
          customLabel: `源 ${nextSources.length + 1}`,
          enabled: true,
        });
        changed = true;
      }
    }

    // 自愈的边全部落库后退出保护模式（之后用户手动断连才能正常移除条目）
    if (healingRef.current) {
      const stillMissing = nextSources.some(
        (s) => !validEdgeIds.has(s.edgeId) && nodeIds.has(s.sourceNodeId)
      );
      if (!stillMissing) healingRef.current = false;
    }

    if (changed) {
      updateNodeData(id, { sources: nextSources });
    }
  }, [connectedEdges, data.sources, id, nodes, updateNodeData]);

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
    return getGroupAutoColor(data, isDark);
  }, [data, isDark]);

  const sources = data.sources || [];
  const borderColor = selected ? accentColor : hexToRgba(accentColor, 0.55);
  const ringColor = selected ? hexToRgba(accentColor, 0.28) : hexToRgba(accentColor, 0.14);

  return (
    <>
      {/* 工具栏：批量连接 + 删除 */}
      <NodeToolbar
        nodeId={id}
        isVisible={selected}
        position={NODE_TOOLBAR_POSITION}
        align={NODE_TOOLBAR_ALIGN}
        offset={NODE_TOOLBAR_OFFSET}
        className={NODE_TOOLBAR_CLASS}
      >
        <UiPanel className="flex items-center gap-1 rounded-full p-1">
          <UiChipButton
            className={`h-8 rounded-full px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              setIsBatchConnectOpen(true);
            }}
            title="批量连接"
          >
            <Link2 className="h-3.5 w-3.5" />
            批量连接
          </UiChipButton>
          <UiChipButton
            className="h-8 rounded-full border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25"
            onClick={(event) => {
              event.stopPropagation();
              deleteNode(id);
            }}
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </UiChipButton>
        </UiPanel>
      </NodeToolbar>

      {/* 批量连接弹窗 */}
      {isBatchConnectOpen && sourceNode && (
        <BatchConnectModal
          sourceNode={sourceNode}
          onClose={() => setIsBatchConnectOpen(false)}
        />
      )}

      {/* 主节点内容 */}
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
                const sourceNodeItem = nodeById.get(source.sourceNodeId);
                const kind = resolveSourceKind(sourceNodeItem);
                const previewUrl = resolveSourcePreviewUrl(sourceNodeItem);
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
    </>
  );
});

TagGroupNode.displayName = 'TagGroupNode';