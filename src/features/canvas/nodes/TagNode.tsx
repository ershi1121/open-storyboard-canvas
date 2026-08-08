import { memo, useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';

function getTagColor(name: string, sourceId?: string | null): string {
  const key = `${(name || '').trim()}::${sourceId || ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

export const TagNode = memo((props: any) => {
  const { id, data } = props;
  const name = data?.displayName || data?.label || '新标签';
  const sourceId = data?.sourceId || null;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  const color = getTagColor(name, sourceId);

  const saveName = () => {
    setIsEditing(false);
    const nextName = draft.trim() || '新标签';
    setDraft(nextName);
    updateNodeData(id, { displayName: nextName, label: nextName });
  };

  return (
    <div
      className="flex min-w-[130px] items-center gap-2 whitespace-nowrap rounded-full border-2 bg-white px-4 py-2 shadow-md transition-all hover:shadow-lg dark:bg-gray-800"
      style={{ borderColor: color, minHeight: '36px' }}
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
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveName();
          }}
          className="w-full bg-transparent text-sm font-bold outline-none"
          style={{ color }}
        />
      ) : (
        <span
          onDoubleClick={() => setIsEditing(true)}
          title="双击修改标签名称"
          className="cursor-text select-none text-sm font-bold"
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
    </div>
  );
});

TagNode.displayName = 'TagNode';