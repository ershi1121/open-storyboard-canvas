import { memo, useCallback, useRef, useState, type ChangeEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  ImagePlus,
  Globe2,
  LayoutGrid,
  Images,
  Video,
  FileSpreadsheet,
  Tags,
} from 'lucide-react';
import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { ExcelImportDialog, type ExcelImportSelection } from '@/features/canvas/ui/ExcelImportDialog';
import { UiModal, UiInput, UiButton } from '@/components/ui';

type SideToolbarItem = {
  type: CanvasNodeType;
  icon: typeof ImagePlus;
  titleKey: string;
  labelKey: string;
  fallbackTitle: string;
  fallbackLabel: string;
  data?: Partial<CanvasNodeData>;
};

const TOOLBAR_ITEMS: SideToolbarItem[] = [
  {
    type: CANVAS_NODE_TYPES.imageEdit,
    icon: ImagePlus,
    titleKey: 'canvasToolbar.addImageTitle',
    labelKey: 'canvasToolbar.addImage',
    fallbackTitle: '添加 AI 图片节点',
    fallbackLabel: 'AI 图片',
  },
  {
    type: CANVAS_NODE_TYPES.panorama,
    icon: Globe2,
    titleKey: 'canvasToolbar.addPanoramaTitle',
    labelKey: 'canvasToolbar.addPanorama',
    fallbackTitle: '添加全景图节点',
    fallbackLabel: '添加全景图节点',
  },
  {
    type: CANVAS_NODE_TYPES.blueprint,
    icon: LayoutGrid,
    titleKey: 'canvasToolbar.addDirectorTitle',
    labelKey: 'canvasToolbar.addDirector',
    fallbackTitle: '添加导演台节点',
    fallbackLabel: '导演台',
  },
  {
    type: CANVAS_NODE_TYPES.aiVideo,
    icon: Video,
    titleKey: 'canvasToolbar.addVideoTitle',
    labelKey: 'canvasToolbar.addVideo',
    fallbackTitle: '添加 AI 视频节点',
    fallbackLabel: 'AI 视频',
  },
];

const IMPORT_GRID_COLS = 4;
const IMPORT_GAP_X = 300;
const IMPORT_GAP_Y = 340;

const RAIL_BUTTON_CLASS =
  'flex w-16 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent';

// ✅ 新增：转义正则特殊字符
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ✅ 新增：按项目约定生成递增名称。
 * 扫描同类型节点，找出「base」或「base N」的最大序号，返回 base (max+1)。
 * 例如已有「标签组 1」「标签组 3」，再建就得到「标签组 4」。
 */
function nextSerialName(
  nodes: Array<{ type?: string; data?: unknown }>,
  type: string,
  base: string
): string {
  const pattern = new RegExp(`^${escapeRegExp(base)}(?:\\s*(\\d+))?$`);
  let max = 0;
  for (const node of nodes) {
    if (node.type !== type) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const name =
      (typeof data.displayName === 'string' && data.displayName.trim()) ||
      (typeof data.label === 'string' && data.label.trim()) ||
      '';
    if (!name) continue;
    const match = name.match(pattern);
    if (!match) continue;
    max = Math.max(max, match[1] ? parseInt(match[1], 10) : 1);
  }
  return `${base} ${max + 1}`;
}

interface CanvasSideToolbarProps {
  onOpenAssets?: (buttonRect: DOMRect) => void;
}

export const CanvasSideToolbar = memo(({ onOpenAssets }: CanvasSideToolbarProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const addNode = useCanvasStore((s) => s.addNode);
  const nodes = useCanvasStore((s) => s.nodes); // ✅ 新增：用于计算递增名称
  const excelInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);

  // 新建标签 / 标签组弹窗状态
  const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
  const [createType, setCreateType] = useState<'tag' | 'tagGroup'>('tag');
  const [newTagName, setNewTagName] = useState('');

  const handleAdd = useCallback(
    (type: CanvasNodeType, data?: Partial<CanvasNodeData>) => {
      let position = { x: 240, y: 160 };
      try {
        const vp = reactFlow.getViewport();
        const container = document.querySelector('.react-flow') as HTMLElement | null;
        if (container) {
          const rect = container.getBoundingClientRect();
          const screenCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          const flowPos = reactFlow.screenToFlowPosition(screenCenter);
          position = {
            x: flowPos.x + (Math.random() - 0.5) * 120,
            y: flowPos.y + (Math.random() - 0.5) * 120,
          };
        } else {
          position = { x: -vp.x / vp.zoom + 120, y: -vp.y / vp.zoom + 120 };
        }
      } catch {
        /* fallback position already set */
      }
      addNode(type, position, data);
    },
    [addNode, reactFlow]
  );

  // 打开新建标签弹窗
  const handleOpenCreateTag = useCallback(() => {
    setNewTagName('');
    setCreateType('tag');
    setIsCreateTagOpen(true);
  }, []);

  // 确认创建标签
  const handleConfirmCreateTag = useCallback(() => {
    if (!newTagName.trim()) return;
    let position = { x: 240, y: 160 };
    try {
      const container = document.querySelector('.react-flow') as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        const flowPos = reactFlow.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        position = {
          x: flowPos.x + (Math.random() - 0.5) * 80,
          y: flowPos.y + (Math.random() - 0.5) * 80,
        };
      }
    } catch {
      /* fallback position already set */
    }

    // ✅ 新增：名称按创建顺序递增
    const serialName = nextSerialName(nodes, CANVAS_NODE_TYPES.tag, newTagName.trim());

    addNode(CANVAS_NODE_TYPES.tag, position, {
      displayName: serialName,
      label: serialName,
      sourceId: null,
    });
    setIsCreateTagOpen(false);
  }, [addNode, reactFlow, newTagName, nodes]);

  // 确认创建标签组
  const handleConfirmCreateTagGroup = useCallback(() => {
    const displayName = newTagName.trim();
    if (!displayName) return;
    let position = { x: 240, y: 160 };
    try {
      const container = document.querySelector('.react-flow') as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        const flowPos = reactFlow.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        position = {
          x: flowPos.x + (Math.random() - 0.5) * 80,
          y: flowPos.y + (Math.random() - 0.5) * 80,
        };
      }
    } catch {
      /* fallback position already set */
    }

    // ✅ 新增：名称按创建顺序递增
    const serialName = nextSerialName(nodes, CANVAS_NODE_TYPES.tagGroup, displayName);

    addNode(CANVAS_NODE_TYPES.tagGroup, position, {
      displayName: serialName,
      sources: [],
    });
    setIsCreateTagOpen(false);
  }, [addNode, reactFlow, newTagName, nodes]);

  // 统一确认创建
  const handleConfirmCreate = useCallback(() => {
    if (createType === 'tagGroup') {
      handleConfirmCreateTagGroup();
    } else {
      handleConfirmCreateTag();
    }
  }, [createType, handleConfirmCreateTag, handleConfirmCreateTagGroup]);

  const handlePickFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setImportFile(file);
    event.target.value = '';
  }, []);

  const handleConfirmImport = useCallback(
    async (selection: ExcelImportSelection) => {
      setImportFile(null);
      let origin = { x: 120, y: 120 };
      try {
        const container = document.querySelector('.react-flow') as HTMLElement | null;
        if (container) {
          const rect = container.getBoundingClientRect();
          const flowPos = reactFlow.screenToFlowPosition({
            x: rect.left + 140,
            y: rect.top + 120,
          });
          origin = { x: flowPos.x, y: flowPos.y };
        }
      } catch {
        /* keep default origin */
      }
      const { prompts } = selection;
      for (let index = 0; index < prompts.length; index++) {
        const col = index % IMPORT_GRID_COLS;
        const row = Math.floor(index / IMPORT_GRID_COLS);
        addNode(
          CANVAS_NODE_TYPES.imageEdit,
          { x: origin.x + col * IMPORT_GAP_X, y: origin.y + row * IMPORT_GAP_Y },
          { prompt: prompts[index] }
        );
        if (index < prompts.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      alert(`导入成功！已按「${selection.label}」的顺序生成 ${prompts.length} 个 AI 图片节点。`);
    },
    [addNode, reactFlow]
  );

  return (
    <>
      <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 rounded-xl border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] p-1.5 shadow-lg">
        <button
          onClick={(event) => onOpenAssets?.(event.currentTarget.getBoundingClientRect())}
          className={RAIL_BUTTON_CLASS}
          title={t('canvasToolbar.assetsTitle', '资产')}
        >
          <Images className="h-5 w-5" />
          <span>{t('canvasToolbar.assets', '资产')}</span>
        </button>
        {TOOLBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.type}
              onClick={() => handleAdd(item.type, item.data)}
              className={RAIL_BUTTON_CLASS}
              title={t(item.titleKey, item.fallbackTitle)}
            >
              <Icon className="h-5 w-5" />
              <span>{t(item.labelKey, item.fallbackLabel)}</span>
            </button>
          );
        })}
        <button
          onClick={handleOpenCreateTag}
          className={RAIL_BUTTON_CLASS}
          title={t('canvasToolbar.createTagTitle', '新建标签 / 标签组')}
        >
          <Tags className="h-5 w-5" />
          <span>{t('canvasToolbar.createTag', '标签')}</span>
        </button>
        <button
          onClick={() => excelInputRef.current?.click()}
          className={RAIL_BUTTON_CLASS}
          title={t('canvasToolbar.importExcelTitle', '批量导入Excel提示词')}
        >
          <FileSpreadsheet className="h-5 w-5" />
          <span>{t('canvasToolbar.importExcel', '导入Excel')}</span>
        </button>
        <input
          ref={excelInputRef}
          type="file"
          accept=".xlsx,.xlsm,.xlsb,.xls,.csv,.ods,.txt"
          className="hidden"
          onChange={handlePickFile}
        />
      </div>

      {importFile && (
        <ExcelImportDialog
          file={importFile}
          onCancel={() => setImportFile(null)}
          onConfirm={handleConfirmImport}
        />
      )}

      {/* 新建标签 / 标签组弹窗 */}
      <UiModal
        isOpen={isCreateTagOpen}
        title="新建标签 / 标签组"
        onClose={() => setIsCreateTagOpen(false)}
        widthClassName="w-[420px]"
      >
        <div className="flex flex-col gap-4 p-4">
          {/* 类型切换 */}
          <div className="flex items-center gap-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-1">
            <button
              type="button"
              onClick={() => setCreateType('tag')}
              className={`h-8 flex-1 rounded-md text-xs font-medium transition-colors ${
                createType === 'tag'
                  ? 'bg-[var(--canvas-node-menu-active)] text-accent shadow-sm'
                  : 'text-text-muted hover:text-text-dark'
              }`}
            >
              标签胶囊
            </button>
            <button
              type="button"
              onClick={() => setCreateType('tagGroup')}
              className={`h-8 flex-1 rounded-md text-xs font-medium transition-colors ${
                createType === 'tagGroup'
                  ? 'bg-[var(--canvas-node-menu-active)] text-accent shadow-sm'
                  : 'text-text-muted hover:text-text-dark'
              }`}
            >
              标签组
            </button>
          </div>

          {/* 名称 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-muted">
              {createType === 'tag' ? '标签名称' : '标签组名称'}
            </label>
            <UiInput
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder={
                createType === 'tag'
                  ? '例如：主角参考、场景氛围'
                  : '例如：角色标签组、场景标签组'
              }
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmCreate();
              }}
            />
            {/* ✅ 新增：提示最终名称会自动加序号 */}
            <span className="text-[10px] text-text-muted opacity-70">
              创建后将自动按顺序编号，如「{newTagName.trim() || '名称'} 1」；颜色由名称自动生成。
            </span>
          </div>

          {/* 标签组说明 */}
          {createType === 'tagGroup' && (
            <div className="rounded-lg border border-dashed border-[var(--canvas-node-border)] bg-[var(--canvas-node-field-bg)] px-3 py-3 text-xs leading-5 text-text-muted">
              将创建一个卡片式标签组节点，支持连接多个上游源，并可自由缩放。
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <UiButton variant="muted" onClick={() => setIsCreateTagOpen(false)}>
            取消
          </UiButton>
          <UiButton
            variant="primary"
            onClick={handleConfirmCreate}
            disabled={!newTagName.trim()}
          >
            确认创建
          </UiButton>
        </div>
      </UiModal>
    </>
  );
});

CanvasSideToolbar.displayName = 'CanvasSideToolbar';