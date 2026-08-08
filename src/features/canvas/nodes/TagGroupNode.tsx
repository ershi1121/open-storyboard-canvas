import { memo, useMemo, useEffect } from 'react';
import { Handle, Position, type NodeProps, useEdges } from '@xyflow/react';
import { Layers, Trash2 } from 'lucide-react';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiCheckbox, UiInput } from '@/components/ui';
import type { TagGroupNodeData } from '@/features/canvas/domain/canvasNodes';

type TagGroupNodeProps = NodeProps & {
  id: string;
  data: TagGroupNodeData;
  selected?: boolean;
};

export const TagGroupNode = memo(({ id, data, selected }: TagGroupNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const edges = useEdges();

  // 动态监听所有连接到当前节点的入边
  const connectedEdges = useMemo(() => edges.filter((e) => e.target === id), [edges, id]);

  // 当连线发生变化时，自动同步 sources 数组
  useEffect(() => {
    const currentSourceIds = new Set((data.sources || []).map(s => s.edgeId));
    const validEdgeIds = new Set(connectedEdges.map(e => e.id));
    
    let nextSources = (data.sources || []).filter(s => validEdgeIds.has(s.edgeId));
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
      // 更新节点数据
      updateNodeData(id, { sources: nextSources });
    }
  }, [connectedEdges, data.sources, id, updateNodeData]);

  const handleToggle = (edgeId: string, enabled: boolean) => {
    updateNodeData(id, {
      sources: (data.sources || []).map(s => s.edgeId === edgeId ? { ...s, enabled } : s)
    });
  };

  const handleRename = (edgeId: string, customLabel: string) => {
    updateNodeData(id, {
      sources: (data.sources || []).map(s => s.edgeId === edgeId ? { ...s, customLabel } : s)
    });
  };

  return (
    <div
      className={`group relative min-w-[260px] max-w-[320px] overflow-visible rounded-lg border bg-[var(--canvas-node-bg)] shadow-[var(--canvas-node-shadow)] transition-colors ${
        selected ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]' : 'border-[var(--canvas-node-border)]'
      }`}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Layers className="h-4 w-4" />}
        titleText={data.displayName || '标签组'}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="p-3 flex flex-col gap-2 max-h-[300px] overflow-y-auto ui-scrollbar">
        {(!data.sources || data.sources.length === 0) ? (
          <div className="text-center text-xs text-text-muted py-6 border border-dashed border-[var(--canvas-node-border)] rounded-md">
            请从左侧连接源节点
          </div>
        ) : (
          data.sources.map((source) => (
            <div 
              key={source.edgeId} 
              className={`flex items-center gap-2 p-2 rounded-md border transition-all ${
                source.enabled ? 'bg-[var(--canvas-node-field-bg)] border-[var(--canvas-node-field-border)]' : 'bg-transparent border-transparent opacity-50'
              }`}
            >
              <UiCheckbox 
                checked={source.enabled} 
                onCheckedChange={(checked) => handleToggle(source.edgeId, !!checked)} 
              />
              <UiInput
                value={source.customLabel}
                onChange={(e) => handleRename(source.edgeId, e.target.value)}
                className="h-7 text-xs flex-1"
                placeholder="自定义别名"
              />
              <button 
                type="button" 
                className="text-text-muted hover:text-red-500 transition-colors"
                onClick={() => removeEdge(source.edgeId)}
                title="断开连接"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <Handle type="target" id="target" position={Position.Left} className="!h-3 !w-3 !border-surface-dark !bg-accent" />
      <Handle type="source" id="source" position={Position.Right} className="!h-3 !w-3 !border-surface-dark !bg-accent" />
      <NodeResizeHandle minWidth={240} minHeight={120} />
    </div>
  );
});

TagGroupNode.displayName = 'TagGroupNode';