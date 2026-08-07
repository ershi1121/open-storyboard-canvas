import { memo, useCallback, useRef, type ChangeEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Globe2, LayoutGrid, Images, Video, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';

import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

interface SideToolbarItem {
  type: CanvasNodeType;
  labelKey: string;
  titleKey: string;
  icon: React.ComponentType<{ className?: string }>;
  data?: Partial<CanvasNodeData>;
}

function TextIcon({ className }: { className?: string }) {
  return <span className={className}>T</span>;
}

const TOOLBAR_ITEMS: SideToolbarItem[] = [
  {
    type: CANVAS_NODE_TYPES.aiText,
    labelKey: 'node.menu.aiTextGeneration',
    titleKey: 'canvasToolbar.addAiText',
    icon: TextIcon,
  },
  {
    type: CANVAS_NODE_TYPES.imageEdit,
    labelKey: 'node.menu.aiImageGeneration',
    titleKey: 'canvasToolbar.addAiImage',
    icon: ImagePlus,
  },
  {
    type: CANVAS_NODE_TYPES.aiVideo,
    labelKey: 'node.menu.aiVideoGeneration',
    titleKey: 'canvasToolbar.addAiVideo',
    icon: Video,
  },
  {
    type: CANVAS_NODE_TYPES.panorama,
    labelKey: 'node.menu.panorama',
    titleKey: 'canvasToolbar.addPanorama',
    icon: Globe2,
  },
  {
    type: CANVAS_NODE_TYPES.blueprint,
    labelKey: 'node.menu.blueprint',
    titleKey: 'canvasToolbar.createDirectorStudio',
    icon: LayoutGrid,
    data: { openDirectorStudioOnCreate: true },
  },
];

const IMPORT_GRID_COLS = 4;
const IMPORT_GAP_X = 300;
const IMPORT_GAP_Y = 340;

const RAIL_BUTTON_CLASS =
  'flex w-16 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent';

function parseRowRange(input: string, maxRows: number): { start: number; end: number } | null {
  const text = (input || '').trim();
  if (!text) return null;
  const toNum = (part: string): number => {
    const p = part.trim();
    if (!/^\d+$/.test(p)) return Number.NaN;
    return parseInt(p, 10);
  };
  const parts = text.split(/[-~～—]/);
  let start: number;
  let end: number;
  if (parts.length === 1) {
    start = toNum(parts[0]);
    end = start;
  } else if (parts.length === 2) {
    start = toNum(parts[0]);
    end = toNum(parts[1]);
  } else {
    return null;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  start = Math.min(Math.max(1, start), maxRows);
  end = Math.min(Math.max(1, end), maxRows);
  return { start, end };
}

function columnLabelToNumber(label: string): number {
  let number = 0;
  for (const ch of label) {
    if (ch < 'A' || ch > 'Z') return Number.NaN;
    number = number * 26 + (ch.charCodeAt(0) - 64);
  }
  return number;
}

function parseColumnRange(input: string, maxCols: number): { start: number; end: number } | null {
  const text = (input || '').trim().toUpperCase();
  if (!text) return null;
  const toNum = (part: string): number => {
    const p = part.trim();
    if (/^\d+$/.test(p)) return parseInt(p, 10);
    if (/^[A-Z]+$/.test(p)) return columnLabelToNumber(p);
    return Number.NaN;
  };
  const parts = text.split(/[-~～—]/);
  let start: number;
  let end: number;
  if (parts.length === 1) {
    start = toNum(parts[0]);
    end = start;
  } else if (parts.length === 2) {
    start = toNum(parts[0]);
    end = toNum(parts[1]);
  } else {
    return null;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  start = Math.min(Math.max(1, start), maxCols);
  end = Math.min(Math.max(1, end), maxCols);
  return { start, end };
}

interface CanvasSideToolbarProps {
  onOpenAssets?: (buttonRect: DOMRect) => void;
}

export const CanvasSideToolbar = memo(({ onOpenAssets }: CanvasSideToolbarProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const addNode = useCanvasStore((s) => s.addNode);
  const excelInputRef = useRef<HTMLInputElement>(null);

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

  const handleImportExcel = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const totalRows = rows.length;
        const totalCols = rows.reduce((max, row) => Math.max(max, row.length), 0);

        if (totalRows === 0 || totalCols === 0) {
          alert(`文件「${file.name}」的工作表是空的，没有找到任何内容。`);
          return;
        }

        const rowInput = window.prompt(
          `工作表「${sheetName}」共 ${totalRows} 行。\n` +
            '请输入要导入的行范围（例如：2-10 或 5）。\n' +
            '留空 = 导入全部行。',
          ''
        );
        if (rowInput === null) return;

        const colInput = window.prompt(
          `该表共 ${totalCols} 列。\n` +
            '请输入要导入的列范围（例如：1-3 或 A-C 或 B）。\n' +
            '留空 = 导入全部列。',
          ''
        );
        if (colInput === null) return;

        const rowRange = parseRowRange(rowInput, totalRows);
        const colRange = parseColumnRange(colInput, totalCols);

        const prompts: string[] = [];
        rows.forEach((row, rowIndex) => {
          const rowNumber = rowIndex + 1;
          if (rowRange && (rowNumber < rowRange.start || rowNumber > rowRange.end)) return;
          row.forEach((cell, colIndex) => {
            const colNumber = colIndex + 1;
            if (colRange && (colNumber < colRange.start || colNumber > colRange.end)) return;
            if (typeof cell === 'string' && cell.trim() !== '') {
              prompts.push(cell.trim());
            } else if (typeof cell === 'number') {
              prompts.push(String(cell));
            }
          });
        });

        if (prompts.length === 0) {
          alert('在所选范围内没有找到有效的提示词。\n请确认单元格里有文字内容。');
          return;
        }

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

        prompts.forEach((prompt, index) => {
          const col = index % IMPORT_GRID_COLS;
          const row = Math.floor(index / IMPORT_GRID_COLS);
          addNode(
            CANVAS_NODE_TYPES.imageEdit,
            { x: origin.x + col * IMPORT_GAP_X, y: origin.y + row * IMPORT_GAP_Y },
            { prompt }
          );
        });

        alert(`导入成功！已根据提示词生成 ${prompts.length} 个 AI 图片节点。`);
      } catch (error) {
        console.error('Excel 解析失败:', error);
        alert(
          `无法解析文件「${file.name}」。\n` +
            '请选择表格文件（.xlsx / .xls / .csv）。\n' +
            '如果你用的是 WPS，请先另存为 .xlsx 格式再导入。'
        );
      } finally {
        if (excelInputRef.current) {
          excelInputRef.current.value = '';
        }
      }
    },
    [addNode, reactFlow]
  );

  return (
    <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 rounded-xl border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] p-1.5 shadow-lg">
      <button
        onClick={(event) => onOpenAssets?.(event.currentTarget.getBoundingClientRect())}
        className={RAIL_BUTTON_CLASS}
        title={t('canvasToolbar.assets')}
      >
        <Images className="h-5 w-5" />
        <span>{t('canvasToolbar.assets')}</span>
      </button>

      {TOOLBAR_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            onClick={() => handleAdd(item.type, item.data)}
            className={RAIL_BUTTON_CLASS}
            title={t(item.titleKey)}
          >
            <Icon className="h-5 w-5" />
            <span>{t(item.labelKey)}</span>
          </button>
        );
      })}

      <button
        onClick={() => excelInputRef.current?.click()}
        className={RAIL_BUTTON_CLASS}
        title={t('canvasToolbar.importExcel', '批量导入Excel提示词')}
      >
        <FileSpreadsheet className="h-5 w-5" />
        <span>{t('canvasToolbar.importExcel', '导入Excel')}</span>
      </button>
      <input
        ref={excelInputRef}
        type="file"
        className="hidden"
        onChange={handleImportExcel}
      />
    </div>
  );
});

CanvasSideToolbar.displayName = 'CanvasSideToolbar';