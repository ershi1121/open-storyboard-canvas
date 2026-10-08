import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  Type,
} from 'lucide-react';

import { COLOR_CHIP_CLASS, getLayerAccentColor, readableTextColor } from './layerAccent';

import {
  TEXT_ALIGN_PRESETS,
  TEXT_COLOR_PRESETS,
  TEXT_DIRECTION_PRESETS,
  TEXT_FONT_PRESETS,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  TEXT_MAX_LAYERS,
  TEXT_NUMBER_TOKEN,
  TEXT_POSITION_NUDGE_STEP,
  TEXT_STROKE_MAX,
  createTextLayer,
  resolveTextContent,
  type TextAlign,
  type TextLayer,
} from '@/features/canvas/tools/text';

/** 十六进制颜色校验（6 位）。 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function clampRound(value: number, min: number, max: number): number {
  // 结果四舍五入到 2 位小数，否则 0.1 连加几次会变成 0.30000000000000004。
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  nudgeStep?: number;
  onChange: (value: number) => void;
  hint?: string;
}

/** 滑杆 + 数值 + 上下微调箭头。滑杆负责粗调，箭头负责小步进精调。 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  nudgeStep,
  onChange,
  hint,
}: SliderRowProps) {
  const nudge = (delta: number) => onChange(clampRound(value + delta, min, max));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-text-dark">{label}</span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="tabular-nums text-xs text-text-muted">
            {value.toFixed(Number.isInteger(value) ? 0 : 1)}
            {suffix}
          </span>
          {nudgeStep !== undefined && (
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => nudge(nudgeStep)}
                disabled={value >= max}
                title={`增加 ${nudgeStep}${suffix}`}
                className="flex h-3.5 items-center justify-center text-text-muted transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-muted"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => nudge(-nudgeStep)}
                disabled={value <= min}
                title={`减少 ${nudgeStep}${suffix}`}
                className="flex h-3.5 items-center justify-center text-text-muted transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-muted"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full cursor-pointer accent-accent"
      />
      {hint && <div className="mt-0.5 text-xs leading-relaxed text-text-muted/80">{hint}</div>}
    </div>
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

/** 颜色 = 取色器 + hex 手输 + 预设色块。hex 敲到一半不规范化，避免回弹。 */
function ColorField({ label, value, onChange }: ColorFieldProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div>
      <div className="mb-1 text-xs text-text-dark">{label}</div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-[rgba(128,128,128,0.7)] bg-bg-dark/80 p-1"
        />
        <input
          type="text"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (HEX_COLOR_PATTERN.test(next.trim())) {
              onChange(next.trim().toUpperCase());
            }
          }}
          onBlur={() => setDraft(value)}
          className="h-8 w-[92px] rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm uppercase text-text-dark outline-none"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {TEXT_COLOR_PRESETS.map((preset) => {
          const active = value.toUpperCase() === preset;
          return (
            <button
              key={preset}
              type="button"
              title={preset}
              onClick={() => onChange(preset)}
              style={{ backgroundColor: preset }}
              className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
                active ? 'border-accent ring-2 ring-accent/50' : 'border-[rgba(128,128,128,0.7)]'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

const ALIGN_ICONS: Record<TextAlign, typeof AlignLeft> = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
};

interface TextLayerRowProps {
  layer: TextLayer;
  index: number;
  open: boolean;
  orderIndex: number;
  onToggle: () => void;
  onChange: (patch: Partial<TextLayer>) => void;
  onRemove: () => void;
}

/** 一个文字层。标题行显示颜色块 + 内容预览 + 方向，展开才出全部参数。 */
function TextLayerRow({
  layer,
  index,
  open,
  orderIndex,
  onToggle,
  onChange,
  onRemove,
}: TextLayerRowProps) {
  const sample = useMemo(() => {
    const text = resolveTextContent(layer, orderIndex);
    const flat = text.replace(/\n/g, ' ');
    return flat.trim() || '（空）';
  }, [layer, orderIndex]);

  const lineHeightLabel = layer.direction === 'vertical' ? '字距 / 列距' : '行距';

  const accent = getLayerAccentColor(index);
  const onColor = readableTextColor(accent);
  return (
    <div
      className="overflow-hidden rounded-lg border border-[rgba(128,128,128,0.7)]"
      style={{ backgroundColor: accent }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5" style={{ color: onColor }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-current transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <span
            className={`h-4 w-4 shrink-0 ${COLOR_CHIP_CLASS}`}
            style={{ backgroundColor: layer.color }}
          />
          <span className="shrink-0 text-xs text-current">文字 {index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-current opacity-90">{sample}</span>
          {layer.direction === 'vertical' && (
            <span className="shrink-0 rounded bg-black/10 px-1 py-px text-[10px] text-current">
              竖排
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onChange({ visible: !layer.visible })}
          title={layer.visible ? '隐藏这一层' : '显示这一层'}
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/10 ${
            layer.visible ? 'text-current' : 'text-amber-400'
          }`}
        >
          {layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="删除这一层"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-current transition-colors hover:bg-black/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="mx-1.5 mb-1.5 space-y-3 rounded-lg bg-[var(--ui-surface-panel)] px-2 py-2.5">
          <div className="flex items-center gap-1.5">
            <span
              className={`h-4 w-4 shrink-0 ${COLOR_CHIP_CLASS}`}
              style={{ backgroundColor: layer.color }}
            />
            <span className="text-xs font-medium text-text-dark">文字 {index + 1}</span>
          </div>
          <textarea
            value={layer.text}
            onChange={(event) => onChange({ text: event.target.value })}
            rows={2}
            placeholder={`例如：图像${TEXT_NUMBER_TOKEN}  或  第${TEXT_NUMBER_TOKEN}页`}
            className="w-full resize-y rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-3 py-2 text-sm text-text-dark outline-none"
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onChange({ text: `${layer.text}${TEXT_NUMBER_TOKEN}` })}
              className="rounded-md border border-[rgba(255,255,255,0.18)] px-2 py-1 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark"
            >
              插入 {TEXT_NUMBER_TOKEN}
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-dark">
              <input
                type="checkbox"
                checked={layer.autoNumber}
                onChange={(event) => onChange({ autoNumber: event.target.checked })}
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
              />
              按顺序自动编号
            </label>
          </div>

          {(layer.autoNumber || layer.text.includes(TEXT_NUMBER_TOKEN)) && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-text-dark">起始编号</span>
              <input
                type="number"
                value={layer.numberStart}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  onChange({ numberStart: Number.isFinite(next) ? next : 1 });
                }}
                className="h-8 w-20 rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm tabular-nums text-text-dark outline-none"
              />
              <span className="text-xs text-text-muted">选择条第一格显示这个数</span>
            </div>
          )}

          <div>
            <div className="mb-1 text-xs text-text-dark">排列方向</div>
            <div className="flex flex-wrap gap-1.5">
              {TEXT_DIRECTION_PRESETS.map((preset) => {
                const active = layer.direction === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => onChange({ direction: preset.value })}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? 'border-accent/45 bg-accent/15 text-text-dark'
                        : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <span className="self-center text-xs text-text-muted/70">
                {layer.direction === 'vertical' ? '逐字向下，换行分列' : '正常横排，换行分行'}
              </span>
            </div>
          </div>

          <select
            value={layer.fontFamily}
            onChange={(event) => onChange({ fontFamily: event.target.value })}
            className="h-9 w-full rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm text-text-dark outline-none"
          >
            {TEXT_FONT_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.value} style={{ fontFamily: preset.value }}>
                {preset.label}
              </option>
            ))}
          </select>

          <SliderRow
            label="字号（相对短边）"
            value={layer.fontSizePercent}
            min={TEXT_FONT_SIZE_MIN}
            max={TEXT_FONT_SIZE_MAX}
            step={0.1}
            nudgeStep={0.1}
            suffix="%"
            onChange={(value) => onChange({ fontSizePercent: value })}
            hint="按画幅短边取百分比，不同尺寸的图文字占比一致"
          />

          <SliderRow
            label={lineHeightLabel}
            value={layer.lineHeightPercent}
            min={TEXT_LINE_HEIGHT_MIN}
            max={TEXT_LINE_HEIGHT_MAX}
            step={0.1}
            nudgeStep={0.1}
            suffix="%"
            onChange={(value) => onChange({ lineHeightPercent: value })}
            hint={
              layer.direction === 'vertical'
                ? '竖排时控制每个字占的高度，也就是列内字距；同时决定多列之间的间距'
                : '多行文字的行间距，100% 就是紧贴'
            }
          />

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-dark">
            <input
              type="checkbox"
              checked={layer.bold}
              onChange={(event) => onChange({ bold: event.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
            <Bold className="h-3.5 w-3.5 text-text-muted" />
            加粗
          </label>

          <div>
            <div className="mb-1 text-xs text-text-dark">对齐</div>
            <div className="flex flex-wrap gap-1.5">
              {TEXT_ALIGN_PRESETS.map((preset) => {
                const Icon = ALIGN_ICONS[preset.value];
                const active = layer.align === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    title={preset.label}
                    onClick={() => onChange({ align: preset.value })}
                    className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? 'border-accent/45 bg-accent/15 text-text-dark'
                        : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <ColorField
            label="文字颜色"
            value={layer.color}
            onChange={(value) => onChange({ color: value })}
          />

          <SliderRow
            label="描边宽度（相对字号）"
            value={layer.strokePercent}
            min={0}
            max={TEXT_STROKE_MAX}
            step={0.1}
            nudgeStep={0.1}
            suffix="%"
            onChange={(value) => onChange({ strokePercent: value })}
            hint="给文字描一圈边，放在复杂画面上也能看清"
          />

          <ColorField
            label="描边颜色"
            value={layer.strokeColor}
            onChange={(value) => onChange({ strokeColor: value })}
          />

          <SliderRow
            label="水平位置 X"
            value={layer.xPercent}
            min={0}
            max={100}
            step={0.1}
            nudgeStep={TEXT_POSITION_NUDGE_STEP}
            suffix="%"
            onChange={(value) => onChange({ xPercent: value })}
          />

          <SliderRow
            label="垂直位置 Y"
            value={layer.yPercent}
            min={0}
            max={100}
            step={0.1}
            nudgeStep={TEXT_POSITION_NUDGE_STEP}
            suffix="%"
            onChange={(value) => onChange({ yPercent: value })}
          />

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => onChange({ xPercent: 50, yPercent: 92 })}
              className="flex shrink-0 items-center gap-1 rounded-md border border-[rgba(255,255,255,0.18)] px-2 py-1 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark"
            >
              <RotateCcw className="h-3 w-3" />
              复位位置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface TextLayersEditorProps {
  layers: TextLayer[];
  onChange: (layers: TextLayer[]) => void;
  /**
   * 当前图在**选择条里**的 0-based 位置 —— 编号 = 起始编号 + 它。
   * 拖一下条，这个值跟着变，示例文字和预览里的编号也就跟着变。
   */
  orderIndex: number;
  /** 展开中的层 id（受控 —— 预览要用它决定「拖动改的是哪一层」）。 */
  activeLayerId: string | null;
  onActiveLayerChange: (id: string | null) => void;
  /** 底部提示语的措辞：裁剪面板里位置靠滑杆微调，也能直接在预览里拖。 */
  positionHint?: string;
}

/**
 * 文字图层面板 —— 裁剪面板左栏的「文字」区块用的就是它。
 *
 * 只管参数，不管预览：预览由宿主组件渲染（裁剪面板把文字叠在
 * 「裁剪 + 边框」的合成结果上）。绘制走 `resolveTextLayerLayout` /
 * `drawTextLayer`，所以面板里看到的就是出图结果。
 */
export function TextLayersEditor({
  layers,
  onChange,
  orderIndex,
  activeLayerId,
  onActiveLayerChange,
  positionHint,
}: TextLayersEditorProps) {
  const updateLayer = (id: string, patch: Partial<TextLayer>) => {
    onChange(layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  };

  const removeLayer = (id: string) => {
    const next = layers.filter((layer) => layer.id !== id);
    onChange(next);
    if (activeLayerId === id) {
      onActiveLayerChange(next.length > 0 ? next[0].id : null);
    }
  };

  const addLayer = () => {
    if (layers.length >= TEXT_MAX_LAYERS) {
      return;
    }
    const layer = createTextLayer({
      // 新层稍微往下错开一点，免得正好压在上一层身上、看不出加了东西。
      yPercent: Math.min(96, 92 - layers.length * 8),
    });
    onChange([...layers, layer]);
    onActiveLayerChange(layer.id);
  };

  return (
    <div className="space-y-2">
      {layers.length === 0 && (
        <div className="rounded-lg border border-dashed border-[rgba(255,255,255,0.18)] px-3 py-2 text-xs leading-relaxed text-text-muted">
          还没有文字。点下面的「添加文字」，再填写内容即可。
        </div>
      )}

      {layers.map((layer, index) => (
        <TextLayerRow
          key={layer.id}
          layer={layer}
          index={index}
          open={activeLayerId === layer.id}
          orderIndex={orderIndex}
          onToggle={() => onActiveLayerChange(activeLayerId === layer.id ? null : layer.id)}
          onChange={(patch) => updateLayer(layer.id, patch)}
          onRemove={() => removeLayer(layer.id)}
        />
      ))}

      <button
        type="button"
        onClick={addLayer}
        disabled={layers.length >= TEXT_MAX_LAYERS}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[rgba(255,255,255,0.2)] py-2 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[rgba(255,255,255,0.2)] disabled:hover:text-text-muted"
      >
        <Plus className="h-3.5 w-3.5" />
        {layers.length >= TEXT_MAX_LAYERS ? `最多 ${TEXT_MAX_LAYERS} 层` : '添加文字'}
      </button>

      <div className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/50 px-2.5 py-2 text-xs leading-relaxed text-text-muted">
        <div>
          <code className="rounded bg-white/[0.08] px-1">{TEXT_NUMBER_TOKEN}</code>{' '}
          是序号占位符，编号按<b className="text-text-dark">选择条的顺序</b>排 ——
          第 1 格就是 1，拖动缩略图即可重排。点「批量套用」会把编号一起分给队列里的图，
          逐张切过去点「应用」时各自记得自己排第几。
        </div>
        {layers.length > 0 && (
          <div className="mt-1 text-text-dark">
            第 1 张「{resolveTextContent(layers[0], 0)}」· 第 2 张「
            {resolveTextContent(layers[0], 1)}」
          </div>
        )}
        {positionHint && <div className="mt-1">{positionHint}</div>}
      </div>
    </div>
  );
}

/** 折叠区块外壳 —— 两个宿主的面板都用它包住文字图层。 */
export interface TextSectionShellProps {
  title: string;
  summary?: string;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function TextSectionShell({
  title,
  summary,
  icon,
  open,
  onToggle,
  children,
}: TextSectionShellProps) {
  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
        {icon ?? <Type className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-dark">{title}</span>
        {summary && <span className="shrink-0 text-xs text-text-muted">{summary}</span>}
      </button>
      {open && (
        <div className="space-y-3 border-t border-[rgba(255,255,255,0.08)] px-3 py-3">{children}</div>
      )}
    </div>
  );
}

/** 供宿主拼摘要用：没层 / 一层 / N 层。 */
export function describeTextLayers(layers: TextLayer[], orderIndex: number): string {
  if (layers.length === 0) {
    return '无';
  }
  const first = resolveTextContent(layers[0], orderIndex).replace(/\n/g, ' ');
  if (layers.length === 1) {
    return first.trim() || '（空）';
  }
  return `${layers.length} 层 · ${first.trim() || '（空）'}`;
}
