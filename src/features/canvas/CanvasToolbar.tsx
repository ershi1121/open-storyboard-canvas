import { memo, useCallback, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Lock,
  Unlock,
  Trash2,
  FileSpreadsheet,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { useReactFlow } from '@xyflow/react';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

interface CanvasToolbarProps {
  isLocked: boolean;
  onToggleLock: () => void;
}

const IMPORT_GRID_COLS = 4;
const IMPORT_GAP_X = 300;
const IMPORT_GAP_Y = 340;
const IMPORT_ORIGIN_X = 120;
const IMPORT_ORIGIN_Y = 120;

export const CanvasToolbar = memo(({ isLocked, onToggleLock }: CanvasToolbarProps) => {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const addNode = useCanvasStore((state) => state.addNode);
  const clearCanvas = useCanvasStore((state) => state.clearCanvas);
  const excelInputRef = useRef<HTMLInputElement>(null);

  const handleAddNode = useCallback(() => {
    const x = Math.random() * 320 + 120;
    const y = Math.random() * 260 + 120;
    addNode(CANVAS_NODE_TYPES.imageEdit, { x, y });
  }, [addNode]);

  const handleImportExcel = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
        alert('请选择 Excel 文件（.xlsx / .xls / .csv）');
        return;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });

        const prompts: string[] = [];
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          rows.forEach((row) => {
            row.forEach((cell) => {
              if (typeof cell === 'string' && cell.trim() !== '') {
                prompts.push(cell.trim());
              } else if (typeof cell === 'number') {
                prompts.push(String(cell));
              }
            });
          });
        });

        if (prompts.length === 0) {
          alert('Excel 文件中没有找到有效的提示词！');
          return;
        }

        prompts.forEach((prompt, index) => {
          const col = index % IMPORT_GRID_COLS;
          const row = Math.floor(index / IMPORT_GRID_COLS);
          addNode(
            CANVAS_NODE_TYPES.imageEdit,
            { x: IMPORT_ORIGIN_X + col * IMPORT_GAP_X, y: IMPORT_ORIGIN_Y + row * IMPORT_GAP_Y },
            { prompt }
          );
        });

        alert(`导入成功！已生成 ${prompts.length} 个节点。`);
      } catch (error) {
        console.error('Excel 解析失败:', error);
        alert('文件解析失败，请检查文件格式。');
      } finally {
        if (excelInputRef.current) {
          excelInputRef.current.value = '';
        }
      }
    },
    [addNode]
  );

  return (
    <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white/90 p-1.5 shadow-md backdrop-blur-sm">
      <button
        onClick={handleAddNode}
        disabled={isLocked}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40"
        title={t('canvas.addImage', '添加节点')}
      >
        <Plus size={18} />
      </button>

      <button
        onClick={() => excelInputRef.current?.click()}
        disabled={isLocked}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40"
        title={t('canvas.importExcel', '导入Excel提示词')}
      >
        <FileSpreadsheet size={18} />
      </button>
      <input
        ref={excelInputRef}
        type="file"
        className="hidden"
        onChange={handleImportExcel}
      />

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <button
        onClick={() => zoomIn()}
        disabled={isLocked}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        title={t('canvas.toolbar.zoomIn', '放大')}
      >
        <ZoomIn size={18} />
      </button>
      <button
        onClick={() => zoomOut()}
        disabled={isLocked}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        title={t('canvas.toolbar.zoomOut', '缩小')}
      >
        <ZoomOut size={18} />
      </button>
      <button
        onClick={() => fitView({ padding: 0.2 })}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        title={t('canvas.toolbar.fitView', '适应画布')}
      >
        <Maximize2 size={18} />
      </button>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <button
        onClick={onToggleLock}
        className="rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        title={isLocked ? t('canvas.unlock', '解锁') : t('canvas.lock', '锁定')}
      >
        {isLocked ? <Lock size={18} /> : <Unlock size={18} />}
      </button>

      <button
        onClick={clearCanvas}
        disabled={isLocked}
        className="rounded-md p-2 text-red-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
        title={t('canvas.clear', '清空画布')}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
});

CanvasToolbar.displayName = 'CanvasToolbar';