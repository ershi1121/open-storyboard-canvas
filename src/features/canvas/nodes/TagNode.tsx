import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, NodeToolbar, NodeResizeControl } from '@xyflow/react';
import { Link2, Trash2 } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiChipButton, UiPanel } from '@/components/ui';
import { BatchConnectModal } from '@/features/canvas/ui/BatchConnectModal';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from '@/features/canvas/ui/nodeToolbarConfig';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';

function getTagColor(name: string, sourceId?: string | null): string {
  const key = `${(name || '').trim()}::${sourceId || ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

// 与项目连接把手一致的边对象
function buildEdgeItem(source: string, target: string) {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'disconnectableEdge',
  };
}

export const TagNode = memo((props: any) => {
  const { id, data, selected, width, height } = props;
  const name = data?.displayName || data?.label || '新标签';
  const sourceId = (data?.sourceId as string | null) || null;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [isBatchConnectOpen, setIsBatchConnectOpen] = useState(false);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const deleteNode = useCanvasStore((s) => s.deleteNode);
  // 关键：点击时向 store 上报选中态，Ctrl+C 等快捷键才能识别标签
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const edges = useCanvasStore((s) => s.edges);
  const sourceNode = useCanvasStore((s) => s.nodes.find((n) => n.id === id)) as
    | CanvasNode
    | undefined;
  const inputRef = useRef<HTMLInputElement>(null);

  // ① 实时记录上游源节点到 data.sourceId，复制时能继承
  const incomingSource = useMemo(
    () => edges.find((e) => e.target === id)?.source ?? null,
    [edges, id]
  );
  useEffect(() => {
    if (incomingSource && incomingSource !== sourceId) {
      updateNodeData(id, { sourceId: incomingSource });
    }
  }, [incomingSource, sourceId, id, updateNodeData]);

  // ② 副本自愈：复制/粘贴后若缺少来自 sourceId 的入边，自动补建
  useEffect(() => {
    if (!sourceId) return;
    const state = useCanvasStore.getState() as any;
    const already = (state.edges ?? []).some(
      (e: any) => e.target === id && e.source === sourceId
    );
    const sourceExists = (state.nodes ?? []).some((n: any) => n.id === sourceId);
    if (already || !sourceExists) return;
    if (typeof state.addEdge === 'function') {
      state.addEdge(sourceId, id);
    } else if (typeof state.onEdgesChange === 'function') {
      state.onEdgesChange([{ type: 'add', item: buildEdgeItem(sourceId, id) }]);
    }
  }, [id, sourceId]);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  // 进入重命名时自动聚焦并全选文字
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const color = getTagColor(name, sourceId);

  // 与 ImageNode 一致：真实宽高（拖拽后回传并持久化），未拖拽前按内容自适应
  const resolvedWidth = typeof width === 'number' && width > 0 ? width : undefined;
  const resolvedHeight = typeof height === 'number' && height > 0 ? height : undefined;

  const saveName = () => {
    setIsEditing(false);
    const nextName = draft.trim() || '新标签';
    setDraft(nextName);
    updateNodeData(id, { displayName: nextName, label: nextName });
  };

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

      {/* 批量连接功能框 */}
      {isBatchConnectOpen && sourceNode && (
        <BatchConnectModal
          sourceNode={sourceNode}
          onClose={() => setIsBatchConnectOpen(false)}
        />
      )}

      <div
        className="relative flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border-2 bg-white px-3 py-1.5 shadow-md hover:shadow-lg dark:bg-gray-800"
        style={{
          width: resolvedWidth,
          height: resolvedHeight,
          minHeight: 28,
          borderColor: selected ? 'var(--accent, #3b82f6)' : color,
          boxShadow: selected ? '0 0 0 2px rgba(59,130,246,0.32)' : undefined,
        }}
        onClick={() => setSelectedNode(id)}
      >
        {/* 关键修复：id="target"，让边的 targetHandle: 'target' 能找到锚点 */}
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          className="!h-4 !w-4 !border-2 !border-white"
          style={{ background: color }}
        />
        <span className="select-none text-sm">🏷️</span>
        {isEditing ? (
          <input
            ref={inputRef}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setDraft(name);
                e.currentTarget.blur();
              }
            }}
            className="w-full min-w-0 flex-1 bg-transparent text-center text-sm font-bold outline-none nodrag"
            style={{ color }}
          />
        ) : (
          <span
            onDoubleClick={() => setIsEditing(true)}
            onMouseDown={(e) => e.stopPropagation()}
            title="双击修改标签名称"
            className="min-w-0 flex-1 cursor-text truncate text-center text-sm font-bold nodrag"
            style={{ color }}
          >
            {name}
          </span>
        )}
        {/* 关键修复：id="source"，让边的 sourceHandle: 'source' 能找到锚点 */}
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          className="!h-4 !w-4 !border-2 !border-white"
          style={{ background: color }}
        />

        {/* 与 ImageNode 同款缩放手柄：可自由拉伸成正方形/长方形 */}
        <NodeResizeControl
          position="bottom-right"
          minWidth={90}
          minHeight={28}
          maxWidth={640}
          maxHeight={480}
          className="!h-5 !w-5 !min-h-0 !min-w-0 !rounded-none !border-0 !bg-transparent !p-0 !opacity-0 transition-opacity duration-100 hover:!opacity-100 focus-within:!opacity-100"
        >
          <div className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b border-r border-black/30 transition-colors dark:border-white/35" />
        </NodeResizeControl>
      </div>
    </>
  );
});

TagNode.displayName = 'TagNode';