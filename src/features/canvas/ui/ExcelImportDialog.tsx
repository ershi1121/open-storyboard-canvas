import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronUp, FileSpreadsheet, X } from 'lucide-react';
import * as XLSX from 'xlsx';

export interface ExcelImportSelection {
  prompts: string[];
  orientation: 'column' | 'row';
  label: string;
}

interface CellItem {
  text: string;
  ref: string;
}

interface GroupInfo {
  index: number;
  label: string;
  items: CellItem[];
}

interface SheetData {
  name: string;
  columns: GroupInfo[];
  rows: GroupInfo[];
}

interface ExcelImportDialogProps {
  file: File;
  onCancel: () => void;
  onConfirm: (selection: ExcelImportSelection) => void;
}

function columnLabel(index: number): string {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function cellText(cell: unknown): string {
  if (typeof cell === 'string' && cell.trim() !== '') return cell.trim();
  if (typeof cell === 'number') return String(cell);
  return '';
}

function parseWorkbook(workbook: XLSX.WorkBook): SheetData[] {
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const colMap = new Map<number, CellItem[]>();
    const rowMap = new Map<number, CellItem[]>();
    rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        const text = cellText(cell);
        if (!text) return;
        const ref = `${columnLabel(c)}${r + 1}`;
        if (!colMap.has(c)) colMap.set(c, []);
        colMap.get(c)!.push({ text, ref });
        if (!rowMap.has(r)) rowMap.set(r, []);
        rowMap.get(r)!.push({ text, ref });
      });
    });
    const columns = Array.from(colMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, items]) => ({ index, label: columnLabel(index), items }));
    const rowList = Array.from(rowMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, items]) => ({ index, label: String(index + 1), items }));
    return { name, columns, rows: rowList };
  });
}

const MODE_OFF =
  'flex items-center gap-1.5 rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-3 py-1.5 text-xs text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60';
const MODE_ON = 'flex items-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-xs text-white';
const SMALL_BTN =
  'rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-1 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40';
const BADGE_CLASS =
  'shrink-0 rounded border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--canvas-rail-button-text)]';
const TEXT_CLASS = 'break-all whitespace-pre-wrap text-xs leading-relaxed text-[var(--canvas-rail-button-text)]';

export function ExcelImportDialog({ file, onCancel, onConfirm }: ExcelImportDialogProps) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [error, setError] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mode, setMode] = useState<'column' | 'row'>('column');
  const [selectedCol, setSelectedCol] = useState(0);
  const [selectedRow, setSelectedRow] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const lastClickedRef = useRef<number | null>(null);

  function applyAutoDetect(sheet: SheetData) {
    const maxCol = sheet.columns.reduce((m, c) => Math.max(m, c.items.length), 0);
    const maxRow = sheet.rows.reduce((m, r) => Math.max(m, r.items.length), 0);
    setMode(maxCol >= maxRow ? 'column' : 'row');
    const bestCol = sheet.columns.reduce((a, b) => (b.items.length > a.items.length ? b : a), sheet.columns[0]);
    const bestRow = sheet.rows.reduce((a, b) => (b.items.length > a.items.length ? b : a), sheet.rows[0]);
    setSelectedCol(bestCol.index);
    setSelectedRow(bestRow.index);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buffer = await file.arrayBuffer();
        let workbook: XLSX.WorkBook;
        if (/\.csv$/i.test(file.name)) {
          // CSV 编码兼容：先按 UTF-8 读，出现乱码就改用 GBK（中文 Excel 常见编码）
          let text = new TextDecoder('utf-8').decode(buffer);
          if (text.includes('\uFFFD')) {
            try {
              text = new TextDecoder('gbk').decode(buffer);
            } catch {
              /* 保持 utf-8 */
            }
          }
          workbook = XLSX.read(text, { type: 'string' });
        } else {
          workbook = XLSX.read(buffer, { type: 'array' });
        }
        const parsed = parseWorkbook(workbook).filter((s) => s.columns.length > 0);
        if (cancelled) return;
        if (parsed.length === 0) {
          setError('没有检测到任何有效文字内容，请确认表格里填写了提示词。');
          return;
        }
        setSheets(parsed);
        applyAutoDetect(parsed[0]);
      } catch {
        if (!cancelled) setError('文件解析失败，请选择表格文件（.xlsx / .xls / .csv）。');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const sheet = sheets ? sheets[sheetIndex] : null;

  const activeGroup: GroupInfo | null = useMemo(() => {
    if (!sheet) return null;
    if (mode === 'column') {
      return sheet.columns.find((c) => c.index === selectedCol) ?? sheet.columns[0] ?? null;
    }
    return sheet.rows.find((r) => r.index === selectedRow) ?? sheet.rows[0] ?? null;
  }, [sheet, mode, selectedCol, selectedRow]);

  // 切换工作表 / 列 / 行 / 方向时，自动清空勾选和展开状态
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    lastClickedRef.current = null;
  }, [activeGroup]);

  // Ctrl+A 全选
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (activeGroup) setSelected(new Set(activeGroup.items.map((_, i) => i)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeGroup]);

  const handleItemClick = (index: number, e: ReactMouseEvent) => {
    if (e.shiftKey && lastClickedRef.current !== null) {
      const start = Math.min(lastClickedRef.current, index);
      const end = Math.max(lastClickedRef.current, index);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) next.add(i);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
      lastClickedRef.current = index;
    }
  };

  const handleToggleExpand = (index: number, e: ReactMouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // 不选 = 全部导入；选了 = 只导入勾选的，且严格按表格先后顺序
  const itemsToImport = useMemo(() => {
    if (!activeGroup) return [];
    if (selected.size === 0) return activeGroup.items;
    return activeGroup.items.filter((_, i) => selected.has(i));
  }, [activeGroup, selected]);

  const handleSheetChange = (nextIndex: number) => {
    setSheetIndex(nextIndex);
    const s = sheets?.[nextIndex];
    if (s) applyAutoDetect(s);
  };

  const handleConfirm = () => {
    if (!activeGroup || itemsToImport.length === 0) return;
    onConfirm({
      prompts: itemsToImport.map((i) => i.text),
      orientation: mode,
      label: mode === 'column' ? `列 ${activeGroup.label}` : `行 ${activeGroup.label}`,
    });
  };

  const renderCheckbox = (checked: boolean) => (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked ? 'border-accent bg-accent text-white' : 'border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)]'
      }`}
    >
      {checked && <Check className="h-3 w-3" />}
    </span>
  );

  const renderExpandButton = (index: number) => (
    <button
      onClick={(e) => handleToggleExpand(index, e)}
      title={expanded.has(index) ? '收起' : '展开完整内容'}
      className="ml-auto shrink-0 rounded p-0.5 text-[var(--canvas-rail-button-text)] opacity-60 transition-colors hover:bg-accent/15 hover:text-accent"
    >
      {expanded.has(index) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-[600px] max-w-[92vw] flex-col rounded-xl border border-[var(--canvas-node-border)] bg-[var(--canvas-node-bg)] shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-[var(--canvas-node-border)] px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--canvas-rail-button-text)]">
            <FileSpreadsheet className="h-4 w-4" />
            <span>Excel 导入检测 · {file.name}</span>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-[var(--canvas-rail-button-text)] opacity-70 transition-colors hover:bg-accent/15 hover:text-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>
          ) : !sheet ? (
            <div className="px-1 py-2 text-sm text-[var(--canvas-rail-button-text)] opacity-70">正在检测文件内容…</div>
          ) : (
            <>
              {/* 工作表选择（多个工作表时才显示） */}
              {sheets && sheets.length > 1 && (
                <div className="flex items-center gap-2 text-xs text-[var(--canvas-rail-button-text)]">
                  <span className="shrink-0">工作表：</span>
                  <select
                    value={sheetIndex}
                    onChange={(e) => handleSheetChange(Number(e.target.value))}
                    className="flex-1 rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-1.5 text-xs text-[var(--canvas-rail-button-text)]"
                  >
                    {sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* 方向切换 */}
              <div className="flex gap-2">
                <button onClick={() => setMode('column')} className={mode === 'column' ? MODE_ON : MODE_OFF}>
                  <ArrowDown className="h-3.5 w-3.5" />
                  按列导入（竖向）
                </button>
                <button onClick={() => setMode('row')} className={mode === 'row' ? MODE_ON : MODE_OFF}>
                  <ArrowRight className="h-3.5 w-3.5" />
                  按行导入（横向）
                </button>
              </div>

              {/* 下拉选择框 */}
              <div className="flex items-center gap-2 text-xs text-[var(--canvas-rail-button-text)]">
                <span className="shrink-0">{mode === 'column' ? '选择列：' : '选择行：'}</span>
                {mode === 'column' ? (
                  <select
                    value={activeGroup?.index ?? 0}
                    onChange={(e) => setSelectedCol(Number(e.target.value))}
                    className="flex-1 rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-1.5 text-xs text-[var(--canvas-rail-button-text)]"
                  >
                    {sheet.columns.map((c) => (
                      <option key={c.index} value={c.index}>
                        列 {c.label} —— 检测到 {c.items.length} 条提示词
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={activeGroup?.index ?? 0}
                    onChange={(e) => setSelectedRow(Number(e.target.value))}
                    className="flex-1 rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-1.5 text-xs text-[var(--canvas-rail-button-text)]"
                  >
                    {sheet.rows.map((r) => (
                      <option key={r.index} value={r.index}>
                        行 {r.label} —— 检测到 {r.items.length} 条提示词
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* 选择操作栏 */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => activeGroup && setSelected(new Set(activeGroup.items.map((_, i) => i)))}
                  className={SMALL_BTN}
                >
                  全选 (Ctrl+A)
                </button>
                <button onClick={() => setSelected(new Set())} disabled={selected.size === 0} className={SMALL_BTN}>
                  清空选择
                </button>
                <span className="text-[10px] text-[var(--canvas-rail-button-text)] opacity-60">
                  单击点选 · Shift+单击连选 · 不勾选 = 全部导入
                </span>
              </div>

              {/* 可视化预览：列=竖向，行=横向；默认每条2行，点箭头展开 */}
              {mode === 'column' ? (
                <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] p-2">
                  {(activeGroup?.items ?? []).map((item, i) => (
                    <div
                      key={item.ref}
                      onClick={(e) => handleItemClick(i, e)}
                      title="单击点选/取消 · Shift+单击连选"
                      className={`flex cursor-pointer select-none items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                        selected.has(i)
                          ? 'border-accent bg-accent/15'
                          : 'border-[var(--canvas-node-border)] bg-[var(--canvas-node-bg)] hover:border-accent/50'
                      }`}
                    >
                      <span className="mt-0.5">{renderCheckbox(selected.has(i))}</span>
                      <span className="mt-1 w-6 shrink-0 text-center text-[10px] text-[var(--canvas-rail-button-text)] opacity-70">
                        {i + 1}
                      </span>
                      <span className={`mt-1 ${BADGE_CLASS}`}>{item.ref}</span>
                      <span className={`min-w-0 flex-1 ${TEXT_CLASS} ${expanded.has(i) ? '' : 'max-h-[40px] overflow-hidden'}`}>
                        {item.text}
                      </span>
                      {renderExpandButton(i)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex gap-1.5 overflow-x-auto rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] p-2">
                  {(activeGroup?.items ?? []).map((item, i) => (
                    <div
                      key={item.ref}
                      onClick={(e) => handleItemClick(i, e)}
                      title="单击点选/取消 · Shift+单击连选"
                      className={`flex w-36 shrink-0 cursor-pointer select-none flex-col gap-1 rounded-md border px-2 py-1.5 transition-colors ${
                        selected.has(i)
                          ? 'border-accent bg-accent/15'
                          : 'border-[var(--canvas-node-border)] bg-[var(--canvas-node-bg)] hover:border-accent/50'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        {renderCheckbox(selected.has(i))}
                        <span className={BADGE_CLASS}>{item.ref}</span>
                        {renderExpandButton(i)}
                      </div>
                      <span className={`${TEXT_CLASS} ${expanded.has(i) ? '' : 'max-h-[40px] overflow-hidden'}`}>{item.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between border-t border-[var(--canvas-node-border)] px-4 py-3">
          <span className="text-xs text-[var(--canvas-rail-button-text)] opacity-70">
            {activeGroup
              ? selected.size === 0
                ? `未勾选，将按顺序导入全部 ${activeGroup.items.length} 条`
                : `已勾选 ${selected.size} / ${activeGroup.items.length} 条，将按表格先后顺序生成`
              : ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-rail-button-bg)] px-3 py-1.5 text-xs text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={itemsToImport.length === 0}
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              开始导入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}