import { memo, useCallback, useRef, useState, type ChangeEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Globe2, LayoutGrid, Images, Video, FileSpreadsheet, Tags } from 'lucide-react';
import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { ExcelImportDialog, type ExcelImportSelection } from '@/features/canvas/ui/ExcelImportDialog';

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

interface CanvasSideToolbarProps {
  onOpenAssets?: (buttonRect: DOMRect) => void;
}

export const CanvasSideToolbar = memo(({ onOpenAssets }: CanvasSideToolbarProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const addNode = useCanvasStore((s) => s.addNode);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);

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

  const handleCreateTag = useCallback(() => {
    const inputName = window.prompt('请输入标签名称', '新标签');
    if (inputName === null) return;
    const name = inputName.trim() || '新标签';

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

    addNode(CANVAS_NODE_TYPES.tag, position, {
      displayName: name,
      label: name,
      sourceId: null,
    });
  }, [addNode, reactFlow]);

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
          onClick={handleCreateTag}
          className={RAIL_BUTTON_CLASS}
          title={t('canvasToolbar.createTagTitle', '新建标签')}
        >
          <Tags className="h-5 w-5" />
          <span>{t('canvasToolbar.createTag', '新建标签')}</span>
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
    </>
  );
});

CanvasSideToolbar.displayName = 'CanvasSideToolbar';