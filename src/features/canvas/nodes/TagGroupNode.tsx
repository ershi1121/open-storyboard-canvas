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
  type CanvasNode,
  type TagGroupNodeData,
} from '@/features/canvas/domain/canvasNodes';

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

  const handleToggle = (edgeId: string, enabled: boolean) => {
    updateNodeData(id, {
      sources: (data.sources || []).map((s) => (s.edgeId === edgeId ? { ...s, enabled } : s)),
    });
  };

  const handleRename = (edgeId: string, customLabel: string) => {
    updateNodeData(id, {
      sources: (data.sources || []).map((s) => (s.edgeId === edgeId ? { ...s, customLabel } : s)),
    });
  };

  const resolvedWidth = typeof width === 'number' && width > 0 ? width : TAG_GROUP_DEFAULT_WIDTH;
  const resolvedHeight = typeof height === 'number' && height > 0 ? height : TAG_GROUP_DEFAULT_HEIGHT;

  const isValidHexColor = (value: string) => /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

  const accentColor =
    typeof data.color === 'string' && isValidHexColor(data.color)
      ? data.color.trim()
      : FALLBACK_TAG_GROUP_COLOR;

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