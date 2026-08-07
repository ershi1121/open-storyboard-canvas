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
} from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface BatchConnectModalProps {
  sourceNode: CanvasNode;
  onClose: () => void;
}

// 类型兜底名称（与画布资产命名保持一致）
function getTypeLabel(type: string): string {
  switch (type) {
    case CANVAS_NODE_TYPES.upload:
      return '上传图';
    case CANVAS_NODE_TYPES.imageEdit:
      return 'AI 图片';
    case CANVAS_NODE_TYPES.exportImage:
      return '结果图';
    case CANVAS_NODE_TYPES.panorama:
      return '全景图';
    case CANVAS_NODE_TYPES.storyboardSplit:
      return '故事板帧';
    case CANVAS_NODE_TYPES.storyboardGen:
      return '故事板生成图';
    case CANVAS_NODE_TYPES.video:
      return '视频';
    case CANVAS_NODE_TYPES.aiVideo:
      return 'AI 视频';
    case CANVAS_NODE_TYPES.audio:
      return '音频';
    case CANVAS_NODE_TYPES.aiText:
      return 'AI 文本';
    case CANVAS_NODE_TYPES.textAnnotation:
      return '文本标注';
    case CANVAS_NODE_TYPES.jsonCard:
      return 'JSON 卡片';
    case CANVAS_NODE_TYPES.blueprint:
      return '导演台';
    case CANVAS_NODE_TYPES.group:
      return '组';
    default:
      return type || '节点';
  }
}

// 读取用户命名的节点名称（canvasStore 自动命名写入的 displayName）
function getNodeDisplayName(node: CanvasNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data.displayName === 'string' && data.displayName.trim()) {
    return data.displayName.trim();
  }
  if (typeof data.sourceFileName === 'string' && data.sourceFileName.trim()) {
    return data.sourceFileName.trim();
  }
  if (typeof data.label === 'string' && data.label.trim()) {
    return data.label.trim();
  }
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

export function BatchConnectModal({ sourceNode, onClose }: BatchConnectModalProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // 本次弹窗中被用户点击/拖拽过、状态需要“取反”的节点
  const [toggledIds, setToggledIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [dragLine, setDragLine] = useState({ x1: 0, y1: 0, x2: 0, y2: 0 });
  const [searchText, setSearchText] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const sourceHandleRef = useRef<HTMLDivElement>(null);

  // 目标节点列表：保持画布创建顺序（即命名顺序），并支持按名称搜索
  const targetNodes = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return nodes.filter((n) => {
      if (n.id === sourceNode.id) return false;
      if (!keyword) return true;
      const name = getNodeDisplayName(n) || getTypeLabel(n.type);
      return name.toLowerCase().includes(keyword) || n.id.toLowerCase().includes(keyword);
    });
  }, [nodes, sourceNode.id, searchText]);

  // 当前真实已存在的连线
  const existingConnections = useMemo(() => {
    const connected = new Set<string>();
    edges.forEach((edge) => {
      if (edge.source === sourceNode.id) {
        connected.add(edge.target);
      }
    });
    return connected;
  }, [edges, sourceNode.id]);

  const pendingAdds = useMemo(
    () => Array.from(toggledIds).filter((id) => !existingConnections.has(id)).length,
    [toggledIds, existingConnections]
  );
  const pendingRemoves = useMemo(
    () => Array.from(toggledIds).filter((id) => existingConnections.has(id)).length,
    [toggledIds, existingConnections]
  );

  // 点击 / 拖拽落点：翻转该节点的连接状态
  const toggleConnection = useCallback((targetId: string) => {
    setToggledIds((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) {
        next.delete(targetId);
      } else {
        next.add(targetId);
      }
      return next;
    });
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
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
      setDragLine((prev) => ({
        ...prev,
        x2: e.clientX - rect.left,
        y2: e.clientY - rect.top,
      }));
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
        if (targetId && targetId !== sourceNode.id) {
          toggleConnection(targetId);
        }
      }
    },
    [isDragging, sourceNode.id, toggleConnection]
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

  // 确认：新增的调用 addEdge，要断开的调用 deleteEdge
  const handleConfirm = () => {
    toggledIds.forEach((targetId) => {
      if (existingConnections.has(targetId)) {
        const edge = edges.find(
          (e) => e.source === sourceNode.id && e.target === targetId
        );
        if (edge) deleteEdge(edge.id);
      } else {
        addEdge(sourceNode.id, targetId);
      }
    });
    onClose();
  };

  const sourceName = getNodeDisplayName(sourceNode) || getTypeLabel(sourceNode.type);
  const sourceTypeLabel = getTypeLabel(sourceNode.type);
  const sourceIconStyle = getNodeIconStyle(sourceNode.type);
  const SourceIcon = sourceIconStyle.icon;

  return createPortal(
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={containerRef}
        className="bg-[#1e1e1e] border border-[#333] rounded-xl shadow-2xl w-[900px] h-[600px] flex flex-col overflow-hidden relative text-white"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#333] bg-[#252525]">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Link2 className="w-5 h-5 text-blue-400" />
            批量连接
          </h2>
          <button onClick={onClose} className="hover:text-white transition-colors text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area（min-h-0 让内部滚动生效） */}
        <div className="relative flex min-h-0 flex-1">
          {/* Left Side: Source Node */}
          <div className="w-1/3 bg-[#181818] flex flex-col items-center justify-center p-6 relative border-r border-[#333]">
            <div className="mb-4 text-gray-400 text-sm">源节点（拖拽右侧圆点）</div>
            <div className="w-48 p-4 rounded-lg border border-[#333] bg-[#252525] shadow-lg flex flex-col items-center">
              <div className={`w-12 h-12 rounded-full ${sourceIconStyle.color} flex items-center justify-center mb-3`}>
                <SourceIcon className="w-6 h-6 text-white" />
              </div>
              <div className="font-medium text-center truncate w-full" title={sourceName}>
                {sourceName}
              </div>
              <div className="text-xs text-gray-500 mt-1 truncate w-full text-center">
                {sourceTypeLabel}
              </div>
            </div>

            {/* 拖拽起点 */}
            <div
              ref={sourceHandleRef}
              className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-blue-500 rounded-full border-2 border-white cursor-crosshair shadow-lg hover:scale-110 transition-transform flex items-center justify-center z-10"
              onMouseDown={handleMouseDown}
              title="按住拖动到右侧节点"
            >
              <div className="w-2 h-2 bg-white rounded-full" />
            </div>

            <div className="mt-8 text-center text-xs text-gray-500">
              拖拽或点击可切换连接状态<br />已连接的节点点击后将断开
            </div>
          </div>

          {/* Right Side: Target Nodes List（min-h-0 关键修复） */}
          <div className="flex min-h-0 w-2/3 flex-col bg-[#121212]">
            <div className="px-4 pt-3 pb-2 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="按名称搜索，如：AI 图片 12"
                  className="w-full h-8 pl-8 pr-3 rounded-md bg-[#252525] border border-[#333] text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
                />
              </div>
              <span className="text-gray-400 text-sm whitespace-nowrap">
                已连 {existingConnections.size}｜新增 {pendingAdds}｜断开 {pendingRemoves}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <div className="grid grid-cols-2 gap-3">
                {targetNodes.map((node) => {
                  const iconStyle = getNodeIconStyle(node.type);
                  const Icon = iconStyle.icon;
                  const displayName = getNodeDisplayName(node);
                  const typeLabel = getTypeLabel(node.type);
                  const isExisting = existingConnections.has(node.id);
                  const isToggled = toggledIds.has(node.id);
                  // 确认后的最终状态 = 现有状态 XOR 是否被翻转
                  const isConnected = isExisting !== isToggled;
                  const willDisconnect = isExisting && isToggled;

                  return (
                    <div
                      key={node.id}
                      data-batch-node-id={node.id}
                      className={`p-3 rounded-lg border flex items-center gap-3 cursor-pointer transition-all ${
                        willDisconnect
                          ? 'border-red-500 bg-red-500/10'
                          : isConnected
                            ? 'border-blue-500 bg-blue-500/10 shadow-inner'
                            : 'border-[#333] bg-[#252525] hover:border-blue-500/50'
                      }`}
                      onClick={() => toggleConnection(node.id)}
                      title={displayName || typeLabel}
                    >
                      <div className={`w-8 h-8 rounded-full ${iconStyle.color} flex items-center justify-center flex-shrink-0`}>
                        <Icon className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <div className="text-sm font-medium truncate">
                          {displayName || typeLabel}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {displayName ? typeLabel : `ID: ${node.id.slice(0, 8)}`}
                          {willDisconnect ? ' · 将断开' : isExisting ? ' · 已连接' : ''}
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {willDisconnect ? (
                          <XCircle className="w-5 h-5 text-red-400" />
                        ) : isConnected ? (
                          <CheckCircle2 className="w-5 h-5 text-blue-400" />
                        ) : (
                          <div className="w-4 h-4 border-2 border-gray-600 rounded-full opacity-50" />
                        )}
                      </div>
                    </div>
                  );
                })}
                {targetNodes.length === 0 && (
                  <div className="col-span-2 py-10 text-center text-sm text-gray-500">
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
        <div className="px-6 py-4 border-t border-[#333] flex items-center justify-between bg-[#252525]">
          <div className="text-sm text-gray-400">
            将新增 <span className="text-blue-400 font-bold">{pendingAdds}</span> 条连接，断开{' '}
            <span className="text-red-400 font-bold">{pendingRemoves}</span> 条连接
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md text-gray-300 hover:bg-[#333] transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              className="px-6 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors shadow-lg flex items-center gap-2"
            >
              <Link2 className="w-4 h-4" />
              确认连接
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}