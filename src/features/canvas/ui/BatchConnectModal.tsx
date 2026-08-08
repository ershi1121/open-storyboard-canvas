import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Link2,
  CheckCircle2,
  XCircle,
  Circle,
  Image as ImageIcon,
  FileText,
  Clapperboard,
  Video,
  Music2,
  LayoutGrid,
  Search,
  Play,
  Info,
} from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

interface BatchConnectModalProps {
  sourceNode: CanvasNode;
  onClose: () => void;
}

const EMPTY_SET = new Set<string>();

// 🌟 悬停超大预览浮层尺寸（560px 宽，媒体最高 680px / 72vh）
const HOVER_PREVIEW_WIDTH = 560;
const HOVER_PREVIEW_MAX_HEIGHT = 760;
const HOVER_DELAY_MS = 250;

// 类型兜底名称（与画布资产命名保持一致）
function getTypeLabel(type: string): string {
  switch (type) {
    case CANVAS_NODE_TYPES.upload: return '上传图';
    case CANVAS_NODE_TYPES.imageEdit: return 'AI 图片';
    case CANVAS_NODE_TYPES.exportImage: return '结果图';
    case CANVAS_NODE_TYPES.panorama: return '全景图';
    case CANVAS_NODE_TYPES.storyboardSplit: return '故事板帧';
    case CANVAS_NODE_TYPES.storyboardGen: return '故事板生成图';
    case CANVAS_NODE_TYPES.video: return '视频';
    case CANVAS_NODE_TYPES.aiVideo: return 'AI 视频';
    case CANVAS_NODE_TYPES.audio: return '音频';
    case CANVAS_NODE_TYPES.aiText: return 'AI 文本';
    case CANVAS_NODE_TYPES.textAnnotation: return '文本标注';
    case CANVAS_NODE_TYPES.jsonCard: return 'JSON 卡片';
    case CANVAS_NODE_TYPES.blueprint: return '导演台';
    case CANVAS_NODE_TYPES.group: return '组';
    default: return type || '节点';
  }
}

// 读取用户命名的节点名称
function getNodeDisplayName(node: CanvasNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data.displayName === 'string' && data.displayName.trim()) return data.displayName.trim();
  if (typeof data.sourceFileName === 'string' && data.sourceFileName.trim()) return data.sourceFileName.trim();
  if (typeof data.label === 'string' && data.label.trim()) return data.label.trim();
  return '';
}

function getNodeIconStyle(type: string): { icon: typeof Circle; color: string } {
  switch (type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.panorama:
      return { icon: ImageIcon, color: 'bg-blue-500' };
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen:
      return { icon: Clapperboard, color: 'bg-teal-500' };
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.aiVideo:
      return { icon: Video, color: 'bg-purple-500' };
    case CANVAS_NODE_TYPES.audio:
      return { icon: Music2, color: 'bg-pink-500' };
    case CANVAS_NODE_TYPES.aiText:
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.jsonCard:
      return { icon: FileText, color: 'bg-green-500' };
    case CANVAS_NODE_TYPES.blueprint:
      return { icon: LayoutGrid, color: 'bg-orange-500' };
    default:
      return { icon: Circle, color: 'bg-gray-500' };
  }
}

function pickText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

// 解析节点宽高比（如 "9:16"），用于按比例完整显示预览图
function parseAspectRatio(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const w = Number.parseFloat(parts[0]);
  const h = Number.parseFloat(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

// 源节点预览容器尺寸：竖图定高、横图定宽，永远不裁切
function getSourcePreviewStyle(node: CanvasNode): React.CSSProperties {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const ratio = parseAspectRatio(data.aspectRatio);
  if (!ratio) return { width: '100%', height: '140px' };
  if (ratio >= 1) {
    return { width: '100%', aspectRatio: `${ratio}`, maxHeight: '190px' };
  }
  return { height: '170px', aspectRatio: `${ratio}`, margin: '0 auto' };
}

// 预览信息：有图显图，没图显提示词；视频额外带可播放的视频源
interface NodePreviewInfo {
  kind: 'image' | 'video' | 'text' | 'none';
  src?: string;
  videoSrc?: string;
  text?: string;
}

function getNodePreviewInfo(node: CanvasNode): NodePreviewInfo {
  const data = (node.data ?? {}) as Record<string, any>;
  const type = node.type as string;

  // 图片类：优先缩略图；未生成时回退显示 prompt
  if (
    type === CANVAS_NODE_TYPES.upload ||
    type === CANVAS_NODE_TYPES.imageEdit ||
    type === CANVAS_NODE_TYPES.exportImage ||
    type === CANVAS_NODE_TYPES.panorama
  ) {
    const raw = pickText(data.previewImageUrl, data.imageUrl);
    const text = pickText(data.prompt);
    if (raw) return { kind: 'image', src: resolveImageDisplayUrl(raw), text };
    if (text) return { kind: 'text', text };
    return { kind: 'none' };
  }

  // 故事板类：取第一帧做封面
  if (type === CANVAS_NODE_TYPES.storyboardSplit || type === CANVAS_NODE_TYPES.storyboardGen) {
    const frames = Array.isArray(data.frames) ? data.frames : [];
    const first = frames.find((frame: any) => frame && pickText(frame.imageUrl));
    if (first) {
      return { kind: 'image', src: resolveImageDisplayUrl(pickText(first.previewImageUrl, first.imageUrl)) };
    }
    return { kind: 'none' };
  }

  // 视频类：封面 + 可播放视频源 + prompt
  if (type === CANVAS_NODE_TYPES.video || type === CANVAS_NODE_TYPES.aiVideo) {
    const raw = pickText(data.thumbnailUrl, data.previewImageUrl, data.imageUrl);
    const videoRaw = pickText(data.localVideoUrl, data.videoUrl);
    const text = pickText(data.prompt, data.sourcePrompt);
    return {
      kind: 'video',
      src: raw ? resolveImageDisplayUrl(raw) : undefined,
      videoSrc: videoRaw ? resolveImageDisplayUrl(videoRaw) : undefined,
      text,
    };
  }

  // 文本类：内容摘要
  if (
    type === CANVAS_NODE_TYPES.aiText ||
    type === CANVAS_NODE_TYPES.textAnnotation ||
    type === CANVAS_NODE_TYPES.jsonCard
  ) {
    let text = pickText(data.content, data.prompt, data.rawContent);
    if (!text && data.parsedJson !== null && data.parsedJson !== undefined) {
      try { text = JSON.stringify(data.parsedJson); } catch { text = ''; }
    }
    if (text) return { kind: 'text', text };
  }

  return { kind: 'none' };
}

// 分类筛选：图片资产 与 AI 生成 拆分
const CATEGORY_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'aiImage', label: 'AI 生成' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'text', label: '文本' },
  { key: 'other', label: '其他' },
] as const;
type CategoryKey = (typeof CATEGORY_FILTERS)[number]['key'];

function getNodeCategory(type: string): Exclude<CategoryKey, 'all'> {
  switch (type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.panorama:
    case CANVAS_NODE_TYPES.storyboardSplit:
      return 'image';
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.storyboardGen:
      return 'aiImage';
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.aiVideo:
      return 'video';
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    case CANVAS_NODE_TYPES.aiText:
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.jsonCard:
      return 'text';
    default:
      return 'other';
  }
}

interface HoverPreviewState {
  nodeId: string;
  left: number;
  top: number;
}

export function BatchConnectModal({ sourceNode, onClose }: BatchConnectModalProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // 源节点可在弹窗内切换（右侧拖拽到左侧）
  const [sourceId, setSourceId] = useState(sourceNode.id);
  const currentSourceNode = useMemo(
    () => nodes.find((n) => n.id === sourceId) ?? sourceNode,
    [nodes, sourceId, sourceNode]
  );

  // 每个源节点各自保留待操作的勾选状态
  const [togglesBySource, setTogglesBySource] = useState<Record<string, Set<string>>>({});
  const toggledIds = togglesBySource[sourceId] ?? EMPTY_SET;

  const [isDragging, setIsDragging] = useState(false);
  const [dragLine, setDragLine] = useState({ x1: 0, y1: 0, x2: 0, y2: 0 });
  const [dragOverSource, setDragOverSource] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey>('all');
  // 悬停超大预览浮层
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const sourceHandleRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
  }, []);

  // 悬停进入：延迟弹出超大浮层；side 决定浮层出现在锚点左侧还是右侧
  const handleHoverEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, node: CanvasNode, side: 'left' | 'right') => {
      const info = getNodePreviewInfo(node);
      if (!info.src && !info.videoSrc) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const left =
        side === 'right'
          ? Math.min(window.innerWidth - HOVER_PREVIEW_WIDTH - 8, rect.right + 16)
          : Math.max(8, rect.left - HOVER_PREVIEW_WIDTH - 16);
      const top = Math.min(
        Math.max(8, rect.top + rect.height / 2 - HOVER_PREVIEW_MAX_HEIGHT / 2),
        Math.max(8, window.innerHeight - HOVER_PREVIEW_MAX_HEIGHT - 8)
      );
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = window.setTimeout(() => {
        setHoverPreview({ nodeId: node.id, left, top });
      }, HOVER_DELAY_MS);
    },
    []
  );

  const handleHoverLeave = useCallback(() => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setHoverPreview(null);
  }, []);

  // 分类数量统计（不含当前源节点）
  const categoryCounts = useMemo(() => {
    const counts: Record<Exclude<CategoryKey, 'all'>, number> = {
      image: 0, aiImage: 0, video: 0, audio: 0, text: 0, other: 0,
    };
    nodes.forEach((n) => {
      if (n.id === currentSourceNode.id) return;
      counts[getNodeCategory(n.type)] += 1;
    });
    return counts;
  }, [nodes, currentSourceNode.id]);

  const totalListCount = useMemo(
    () => Object.values(categoryCounts).reduce((a, b) => a + b, 0),
    [categoryCounts]
  );

  // 目标节点列表：分类过滤 + 名称/ID/提示词搜索
  const targetNodes = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return nodes.filter((n) => {
      if (n.id === currentSourceNode.id) return false;
      if (categoryFilter !== 'all' && getNodeCategory(n.type) !== categoryFilter) return false;
      if (!keyword) return true;
      const name = getNodeDisplayName(n) || getTypeLabel(n.type);
      const previewText = getNodePreviewInfo(n).text ?? '';
      return (
        name.toLowerCase().includes(keyword) ||
        n.id.toLowerCase().includes(keyword) ||
        previewText.toLowerCase().includes(keyword)
      );
    });
  }, [nodes, currentSourceNode.id, searchText, categoryFilter]);

  const existingConnections = useMemo(() => {
    const connected = new Set<string>();
    edges.forEach((edge) => {
      if (edge.source === currentSourceNode.id) connected.add(edge.target);
    });
    return connected;
  }, [edges, currentSourceNode.id]);

  const pendingAdds = useMemo(
    () => Array.from(toggledIds).filter((id) => !existingConnections.has(id)).length,
    [toggledIds, existingConnections]
  );
  const pendingRemoves = useMemo(
    () => Array.from(toggledIds).filter((id) => existingConnections.has(id)).length,
    [toggledIds, existingConnections]
  );

  // 所有源节点的总待操作数（底部统计）
  const totalPending = useMemo(() => {
    let adds = 0;
    let removes = 0;
    let sources = 0;
    Object.entries(togglesBySource).forEach(([src, targets]) => {
      if (!targets || targets.size === 0) return;
      sources += 1;
      targets.forEach((target) => {
        const exists = edges.some((e) => e.source === src && e.target === target);
        if (exists) removes += 1;
        else adds += 1;
      });
    });
    return { adds, removes, sources };
  }, [togglesBySource, edges]);

  const toggleConnection = useCallback((targetId: string) => {
    setTogglesBySource((prev) => {
      const current = prev[sourceId] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return { ...prev, [sourceId]: next };
    });
  }, [sourceId]);

  // 拖拽右侧节点到左侧：切换源节点
  const changeSource = useCallback((nextId: string) => {
    setSourceId((prev) => (prev === nextId ? prev : nextId));
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setHoverPreview(null);
    const rect = containerRef.current?.getBoundingClientRect();
    const handleRect = sourceHandleRef.current?.getBoundingClientRect();
    if (rect && handleRect) {
      setDragLine({
        x1: handleRect.left - rect.left + handleRect.width / 2,
        y1: handleRect.top - rect.top + handleRect.height / 2,
        x2: e.clientX - rect.left,
        y2: e.clientY - rect.top,
      });
    }
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setDragLine((prev) => ({ ...prev, x2: e.clientX - rect.left, y2: e.clientY - rect.top }));
    }
  }, [isDragging]);

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      setIsDragging(false);
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const nodeElement = target?.closest('[data-batch-node-id]');
      if (nodeElement) {
        const targetId = nodeElement.getAttribute('data-batch-node-id');
        if (targetId && targetId !== currentSourceNode.id) toggleConnection(targetId);
      }
    },
    [isDragging, currentSourceNode.id, toggleConnection]
  );

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // 确认：对所有源节点的待操作统一生效
  const handleConfirm = () => {
    Object.entries(togglesBySource).forEach(([src, targets]) => {
      targets.forEach((targetId) => {
        const edge = edges.find((e) => e.source === src && e.target === targetId);
        if (edge) deleteEdge(edge.id);
        else addEdge(src, targetId);
      });
    });
    onClose();
  };

  const sourceName = getNodeDisplayName(currentSourceNode) || getTypeLabel(currentSourceNode.type);
  const sourceTypeLabel = getTypeLabel(currentSourceNode.type);
  const sourceIconStyle = getNodeIconStyle(currentSourceNode.type);
  const SourceIcon = sourceIconStyle.icon;
  const sourcePreview = getNodePreviewInfo(currentSourceNode);

  // 悬停浮层渲染数据
  const hoverNode = hoverPreview ? nodes.find((n) => n.id === hoverPreview.nodeId) ?? null : null;
  const hoverInfo = hoverNode ? getNodePreviewInfo(hoverNode) : null;
  const showHoverPreview = Boolean(hoverPreview && hoverNode && hoverInfo && (hoverInfo.src || hoverInfo.videoSrc));

  return createPortal(
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={containerRef}
        className="bg-[var(--canvas-node-bg,#1e1e1e)] border border-[var(--canvas-node-border,#333)] rounded-xl shadow-2xl w-[900px] h-[640px] flex flex-col overflow-hidden relative text-[var(--canvas-rail-button-text,white)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--canvas-node-border,#333)] bg-[var(--canvas-rail-button-bg,#252525)]">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Link2 className="w-5 h-5 text-blue-500" />
            批量连接
          </h2>
          <button onClick={onClose} className="hover:text-blue-500 transition-colors opacity-70 hover:opacity-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="relative flex min-h-0 flex-1">
          {/* Left Side: 源节点 + 操作说明 */}
          <div
            className={`w-1/3 flex flex-col p-4 relative border-r border-[var(--canvas-node-border,#333)] bg-[var(--canvas-rail-button-bg,#181818)] transition-colors ${
              dragOverSource ? 'bg-blue-500/10' : ''
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!dragOverSource) setDragOverSource(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSource(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const droppedId = e.dataTransfer.getData('text/plain');
              setDragOverSource(false);
              if (droppedId && droppedId !== sourceId) changeSource(droppedId);
            }}
          >
            {/* 源节点区域（居中） */}
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
              <div className="mb-2 opacity-60 text-xs">源节点（拖拽右侧圆点）</div>

              <div
                className={`w-52 p-3 rounded-lg border shadow-lg flex flex-col items-center transition-all ${
                  dragOverSource
                    ? 'border-blue-500 ring-2 ring-blue-500/40 bg-blue-500/10'
                    : 'border-[var(--canvas-node-border,#333)] bg-[var(--canvas-node-bg,#252525)]'
                }`}
                onMouseEnter={(e) => handleHoverEnter(e, currentSourceNode, 'right')}
                onMouseLeave={handleHoverLeave}
              >
                {sourcePreview.src ? (
                  <div
                    className="mb-2 overflow-hidden rounded-md border border-black/10 bg-black/10 flex items-center justify-center relative w-full"
                    style={getSourcePreviewStyle(currentSourceNode)}
                  >
                    <img
                      src={sourcePreview.src}
                      alt=""
                      className="max-h-full max-w-full object-contain"
                      draggable={false}
                    />
                    {sourcePreview.kind === 'video' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                        <Play className="h-7 w-7 text-white" />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={`mb-2 w-12 h-12 rounded-lg flex items-center justify-center ${sourceIconStyle.color}`}>
                    <SourceIcon className="w-6 h-6 text-white" />
                  </div>
                )}
                <div className="font-medium text-center truncate w-full text-sm" title={sourceName}>
                  {sourceName}
                </div>
                <div className="text-xs opacity-50 mt-0.5 truncate w-full text-center">{sourceTypeLabel}</div>
                {sourcePreview.text && (
                  <div
                    className="mt-1.5 w-full max-h-[32px] overflow-hidden break-all whitespace-pre-wrap text-center text-[10px] leading-relaxed opacity-60"
                    title={sourcePreview.text}
                  >
                    {sourcePreview.text}
                  </div>
                )}
              </div>
            </div>

            {/* 🌟 左下方操作说明卡片 */}
            <div className="mt-3 w-full shrink-0 rounded-lg border border-[var(--canvas-node-border,#333)] bg-[var(--canvas-node-bg,#1e1e1e)]/60 p-2.5">
              <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium opacity-80">
                <Info className="w-3 h-3 text-blue-500" />
                操作说明
              </div>
              <ul className="space-y-1 text-[10px] leading-snug opacity-60">
                <li>· 拖拽蓝色圆点到右侧节点 = 连接 / 断开</li>
                <li>· 点击右侧节点卡片 = 切换连接状态</li>
                <li>· 将右侧节点拖到左侧 = 切换源节点（支持多源批量）</li>
                <li>· 悬停源节点 / 右侧卡片 = 查看超大图 / 视频预览</li>
                <li>· 搜索框 = 按名称或提示词关键词查找</li>
                <li>· 分类标签 = 按 图片 / AI 生成 / 视频 等筛选</li>
              </ul>
            </div>

            {/* 拖拽起点 */}
            <div
              ref={sourceHandleRef}
              className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-blue-500 rounded-full border-2 border-[var(--canvas-node-bg,#1e1e1e)] cursor-crosshair shadow-lg hover:scale-110 transition-transform flex items-center justify-center z-10"
              onMouseDown={handleMouseDown}
              title="按住拖动到右侧节点"
            >
              <div className="w-2 h-2 bg-white rounded-full" />
            </div>

            {dragOverSource && (
              <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                <div className="rounded-full bg-blue-500 text-white text-sm px-4 py-2 shadow-lg">
                  松开鼠标，设为源节点
                </div>
              </div>
            )}
          </div>

          {/* Right Side: Target Nodes List */}
          <div className="flex min-h-0 w-2/3 flex-col bg-[var(--canvas-node-bg,#121212)]">
            {/* 搜索栏 */}
            <div className="px-4 pt-3 pb-2 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 opacity-50 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="搜索名称或提示词内容，如：猫 / AI 图片 12"
                  className="w-full h-8 pl-8 pr-3 rounded-md bg-[var(--canvas-rail-button-bg,#252525)] border border-[var(--canvas-node-border,#333)] text-sm text-[var(--canvas-rail-button-text,white)] placeholder:opacity-50 outline-none focus:border-blue-500"
                />
              </div>
              <span className="opacity-60 text-sm whitespace-nowrap">
                已连 {existingConnections.size}｜新增 {pendingAdds}｜断开 {pendingRemoves}
              </span>
            </div>

            {/* 分类筛选标签 */}
            <div className="flex items-center gap-1.5 flex-wrap px-4 pb-2">
              {CATEGORY_FILTERS.map((filter) => {
                const count = filter.key === 'all' ? totalListCount : categoryCounts[filter.key];
                const active = categoryFilter === filter.key;
                return (
                  <button
                    key={filter.key}
                    onClick={() => setCategoryFilter(filter.key)}
                    disabled={filter.key !== 'all' && count === 0}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      active
                        ? 'border-blue-500 bg-blue-500/15 text-blue-500 font-medium'
                        : 'border-[var(--canvas-node-border,#333)] bg-[var(--canvas-rail-button-bg,#252525)] opacity-70 hover:opacity-100 hover:border-blue-500/50'
                    }`}
                  >
                    {filter.label} {count}
                  </button>
                );
              })}
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
              onScroll={() => setHoverPreview(null)}
            >
              <div className="grid grid-cols-2 gap-3">
                {targetNodes.map((node) => {
                  const iconStyle = getNodeIconStyle(node.type);
                  const Icon = iconStyle.icon;
                  const displayName = getNodeDisplayName(node);
                  const typeLabel = getTypeLabel(node.type);
                  const isExisting = existingConnections.has(node.id);
                  const isToggled = toggledIds.has(node.id);
                  const isConnected = isExisting !== isToggled;
                  const willDisconnect = isExisting && isToggled;
                  const preview = getNodePreviewInfo(node);

                  return (
                    <div
                      key={node.id}
                      data-batch-node-id={node.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', node.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setHoverPreview(null);
                      }}
                      onMouseEnter={(e) => handleHoverEnter(e, node, 'left')}
                      onMouseLeave={handleHoverLeave}
                      className={`p-2.5 rounded-lg border flex items-start gap-3 cursor-pointer transition-all ${
                        willDisconnect
                          ? 'border-red-500 bg-red-500/10'
                          : isConnected
                            ? 'border-blue-500 bg-blue-500/10 shadow-inner'
                            : 'border-[var(--canvas-node-border,#333)] bg-[var(--canvas-rail-button-bg,#252525)] hover:border-blue-500/50'
                      }`}
                      onClick={() => toggleConnection(node.id)}
                      title={`${displayName || typeLabel}（点击切换连接 · 拖到左侧设为源节点 · 悬停查看大图）`}
                    >
                      {/* 缩略图完整显示 */}
                      <div className="relative w-12 h-12 shrink-0 overflow-hidden rounded-md border border-black/10 bg-black/10 flex items-center justify-center">
                        {preview.src ? (
                          <img
                            src={preview.src}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            className="max-h-full max-w-full object-contain"
                          />
                        ) : (
                          <div className={`w-full h-full flex items-center justify-center ${iconStyle.color}`}>
                            <Icon className="w-5 h-5 text-white" />
                          </div>
                        )}
                        {preview.kind === 'video' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                            <Play className="w-4 h-4 text-white" />
                          </div>
                        )}
                      </div>

                      {/* 名称 + 提示词/内容摘要 */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{displayName || typeLabel}</div>
                        {preview.text ? (
                          <div
                            className="mt-0.5 max-h-[34px] overflow-hidden break-all whitespace-pre-wrap text-xs leading-relaxed opacity-60"
                            title={preview.text}
                          >
                            {preview.text}
                          </div>
                        ) : (
                          <div className="mt-0.5 truncate text-xs opacity-50">
                            {displayName ? typeLabel : `ID: ${node.id.slice(0, 8)}`}
                            {willDisconnect ? ' · 将断开' : isExisting ? ' · 已连接' : ''}
                          </div>
                        )}
                      </div>

                      {/* 状态图标 */}
                      <div className="shrink-0 mt-1">
                        {willDisconnect ? (
                          <XCircle className="w-5 h-5 text-red-400" />
                        ) : isConnected ? (
                          <CheckCircle2 className="w-5 h-5 text-blue-500" />
                        ) : (
                          <div className="w-4 h-4 border-2 border-current opacity-30 rounded-full" />
                        )}
                      </div>
                    </div>
                  );
                })}
                {targetNodes.length === 0 && (
                  <div className="col-span-2 py-10 text-center text-sm opacity-50">
                    没有匹配「{searchText}」的节点
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SVG 画线层 */}
          <svg className="absolute inset-0 pointer-events-none z-20" width="100%" height="100%">
            {isDragging && (
              <line
                x1={dragLine.x1}
                y1={dragLine.y1}
                x2={dragLine.x2}
                y2={dragLine.y2}
                stroke="#3b82f6"
                strokeWidth="2"
                strokeDasharray="4 4"
              />
            )}
          </svg>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--canvas-node-border,#333)] flex items-center justify-between bg-[var(--canvas-rail-button-bg,#252525)]">
          <div className="text-sm opacity-70">
            将新增 <span className="text-blue-500 font-bold">{totalPending.adds}</span> 条连接，断开{' '}
            <span className="text-red-400 font-bold">{totalPending.removes}</span> 条连接
            {totalPending.sources > 1 && (
              <span className="ml-1 opacity-80">（{totalPending.sources} 个源节点）</span>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md opacity-80 hover:opacity-100 hover:bg-black/10 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={totalPending.adds + totalPending.removes === 0}
              className="px-6 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors shadow-lg flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Link2 className="w-4 h-4" />
              确认连接
            </button>
          </div>
        </div>
      </div>

      {/* 🌟 悬停超大预览浮层（560px 宽，媒体最高 680px / 72vh） */}
      {showHoverPreview && hoverPreview && hoverNode && hoverInfo && (
        <div
          className="pointer-events-none fixed z-[1600] w-[560px] overflow-hidden rounded-lg border border-[var(--canvas-node-border,#333)] bg-[var(--canvas-node-bg,#1e1e1e)] shadow-2xl"
          style={{ left: hoverPreview.left, top: hoverPreview.top }}
        >
          <div className="flex items-center justify-center bg-black/20">
            {hoverInfo.kind === 'video' && hoverInfo.videoSrc ? (
              <video
                src={hoverInfo.videoSrc}
                poster={hoverInfo.src}
                autoPlay
                muted
                loop
                playsInline
                className="max-h-[min(680px,72vh)] w-full object-contain"
              />
            ) : (
              <img
                src={hoverInfo.src}
                alt=""
                className="max-h-[min(680px,72vh)] w-full object-contain"
                draggable={false}
              />
            )}
          </div>
          <div className="px-3 py-2 text-[var(--canvas-rail-button-text,white)]">
            <div className="text-sm font-medium truncate">
              {getNodeDisplayName(hoverNode) || getTypeLabel(hoverNode.type)}
              <span className="ml-2 text-[10px] opacity-50">{getTypeLabel(hoverNode.type)}</span>
            </div>
            {hoverInfo.text && (
              <div className="mt-1 max-h-[60px] overflow-hidden break-all whitespace-pre-wrap text-xs leading-relaxed opacity-60">
                {hoverInfo.text}
              </div>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}