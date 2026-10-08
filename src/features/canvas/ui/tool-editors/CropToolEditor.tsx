import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Frame,
  Maximize2,
  Minimize2,
  Plus,
  ScanSearch,
  Trash2,
  Type,
} from 'lucide-react';

import { loadImageElement, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { ToolSelectField } from '@/features/canvas/tools';
import {
  AUTO_CROP_COLOR_PRESETS,
  AUTO_CROP_EDGE_ITEMS,
  AUTO_CROP_PADDING_MAX_PERCENT,
  AUTO_CROP_PADDING_MIN_PERCENT,
  hasAutoCropEdge,
  isSameColor,
  isTrimInsetsEmpty,
  measureAutoCrop,
  readAutoCropOptions,
  readCropRect,
  resolveEffectiveCropRect,
  resolveRemovedInsets,
  toAutoCropToolOptions,
  toggleAutoCropEdge,
  type AutoCropDetection,
  type AutoCropOptions,
} from '@/features/canvas/tools/autoCrop';
import {
  BORDER_COLOR_PRESETS,
  BORDER_LAYER_WIDTH_MAX_PERCENT,
  BORDER_MAX_LAYERS,
  BORDER_PAD_MAX_PERCENT,
  BORDER_RADIUS_MAX_PERCENT,
  BORDER_RATIO_PRESETS,
  BORDER_STROKE_MAX_PERCENT,
  DEFAULT_BORDER_COLOR,
  createBorderLayerId,
  describeAspectRatio,
  isValidHexColor,
  readBorderOptions,
  resolveBorderGeometry,
  toBorderToolOptions,
  type BorderLayer,
  type BorderOptions,
} from '@/features/canvas/tools/border';
import type { BatchApplyScope, VisualToolEditorProps } from './types';
import { buildStripIndexById, orderStripItems, resolveStripTextIndex } from './imageOrder';
import { PictureStrip, type PictureStripCandidate } from './PictureStrip';
import { COLOR_CHIP_CLASS, getLayerAccentColor, readableTextColor } from './layerAccent';
import {
  TEXT_LAYERS_KEY,
  readTextLayers,
  resolveTextLayersLayout,
  stringifyTextLayers,
  type TextLayer,
} from '@/features/canvas/tools/text';
import { TextLayerPreview } from './TextLayerPreview';
import { TextLayersEditor, describeTextLayers } from './TextLayersEditor';

const VIEWPORT_PADDING_PX = 20;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;

function parsePresetRatio(value: string): number | null {
  if (!value.includes(':')) {
    return null;
  }

  const [rawW, rawH] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return null;
  }

  return rawW / rawH;
}

function parseCustomRatio(value: string): number | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (input.includes(':')) {
    return parsePresetRatio(input);
  }

  const numeric = Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toImageSpaceCrop(
  crop: PixelCrop,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
) {
  const scaleX = naturalWidth / renderedWidth;
  const scaleY = naturalHeight / renderedHeight;

  return {
    cropX: Math.round(crop.x * scaleX),
    cropY: Math.round(crop.y * scaleY),
    cropWidth: Math.round(crop.width * scaleX),
    cropHeight: Math.round(crop.height * scaleY),
  };
}

function toRenderedCrop(
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
): Crop {
  const scaleX = renderedWidth / naturalWidth;
  const scaleY = renderedHeight / naturalHeight;

  return {
    unit: 'px',
    x: Math.max(0, cropX * scaleX),
    y: Math.max(0, cropY * scaleY),
    width: Math.max(1, cropWidth * scaleX),
    height: Math.max(1, cropHeight * scaleY),
  };
}

function buildDefaultCrop(width: number, height: number, aspect: number | undefined): Crop {
  if (!aspect) {
    return { unit: 'px', x: 0, y: 0, width, height };
  }

  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 88,
      },
      aspect,
      width,
      height
    ),
    width,
    height
  );
}

/** 预览盒内边距，和下面 `p-4` 保持一致，用来算可用绘制区。 */
const BORDER_PREVIEW_PADDING_PX = 16;
/** 首帧还没量到尺寸时的兜底值，避免预览闪一下极小的图。 */
const BORDER_PREVIEW_FALLBACK_WIDTH = 460;
const BORDER_PREVIEW_FALLBACK_HEIGHT = 480;

/**
 * 输出预览缩放：1 = 适应容器，向上放大看细节，向下缩小看整体留白。
 * 下限必须小于 1 —— 锁在 1 的话滚轮往下滚到头就毫无反应，用户只会以为「只能放大不能缩小」。
 */
const PREVIEW_ZOOM_MIN = 0.25;
const PREVIEW_ZOOM_MAX = 8;
const PREVIEW_ZOOM_WHEEL_STEP = 1.15;

/** 裁剪区域缩放：1 = 适应容器。同理允许缩小，否则滚轮只有一半能用。 */
const CROP_ZOOM_MIN = 0.5;
const CROP_ZOOM_MAX = 6;

/** 缩放的「默认档」= 1（适应容器）。判断「是否被用户动过」要用它，不能用最小值。 */
const PREVIEW_ZOOM_DEFAULT = 1;
const CROP_ZOOM_DEFAULT = 1;

/**
 * 平移余量（占可用绘制区的比例）。
 * 只按「内容比容器大多少」算边界的话，宽图放大后竖向永远拖不动 —— 内容高度还没容器高。
 * 额外给一段余量，四个方向都拖得动，又不至于一把把图推出视野。
 */
const PREVIEW_PAN_MARGIN_RATIO = 0.35;

/** 数值微调按钮步进（百分比）。滑杆一格太粗，箭头专门用来做 0.1% 的精调。 */
const BORDER_NUDGE_STEP_PERCENT = 0.1;

/**
 * 自动裁剪扫描的去抖时长。
 * 容差滑杆是连续拖动的，每动一格就全图扫一遍（1024² 逐行）会明显卡手。
 */
const AUTO_CROP_DETECT_DEBOUNCE_MS = 120;

/**
 * 布局切换阈值：裁剪后宽高比 ≥ 此值视为「横图」，切到上下分布；
 * < 此值视为「竖图 / 方图」，维持三列分布。
 *
 * 阈值不能太小（如 1.0）：方图（r≈1）容易在边界来回跳，用户一动裁剪就闪屏。
 * 1.2 是「肉眼明显偏横」的临界值，跳变更稳。
 */
const LAYOUT_WIDE_RATIO_THRESHOLD = 1.2;

function clampZoom(value: number, min: number, max: number): number {
  // 滚轮往下滚回来时是连乘，会漂到 1.0000000000000002 这种值上；
  // 靠近下限就直接吸附回 1，否则"是否已放大"的判断和光标样式都会误触发。
  if (value <= min + 0.001) {
    return min;
  }
  return Math.min(max, value);
}

function clampOffset(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

interface CollapsibleSectionProps {
  title: string;
  icon?: ReactNode;
  /** 收起时也能看到的关键信息，省得为了确认一个值把面板全展开 */
  summary?: string;
  /** 区块身份色：给标题栏铺一整块色，和里面的图层色块一样一眼分区。不传则跟随主题。 */
  accent?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * 可折叠区块。左侧功能栏一律用它，不再用开关 ——
 * 开关本身占一行，还要额外占一行标题；折叠面板的标题行本身就是控件，
 * 收起后只剩一行，加几层边框也只是多几行。
 */
function CollapsibleSection({
  title,
  icon,
  summary,
  accent,
  open,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
        style={accent ? { backgroundColor: accent, color: readableTextColor(accent) } : undefined}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 ${
            accent ? 'text-current' : 'text-text-muted'
          } transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {icon}
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${
            accent ? 'text-current' : 'text-text-dark'
          }`}
        >
          {title}
        </span>
        {summary && (
          <span
            className={`shrink-0 text-xs ${accent ? 'text-current opacity-80' : 'text-text-muted'}`}
          >
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-[rgba(255,255,255,0.08)] px-3 py-3">{children}</div>
      )}
    </div>
  );
}

interface PercentSliderRowProps {
  label: string;
  hint: string;
  value: number;
  max: number;
  /** 下限，默认 0；自动裁剪「保留边距」传负值以支持往内容里切。 */
  min?: number;
  /**
   * 滑杆与箭头的步进，默认 0.1 —— 边框那几个参数要精调（0.1% 的圆角差别看得出来）。
   * 容差、保留边距这类粗调参数传 1 或 0.5 即可。
   */
  step?: number;
  onChange: (value: number) => void;
}

/** 通用的「0 → max 百分比」滑杆行，带上下箭头微调。 */
function PercentSliderRow({
  label,
  hint,
  value,
  max,
  min = 0,
  step = BORDER_NUDGE_STEP_PERCENT,
  onChange,
}: PercentSliderRowProps) {
  // 滑杆一格太粗，箭头专门做精调。
  // 结果要四舍五入到 2 位小数，否则 0.1 连加几次会变成 0.30000000000000004 显示在界面上。
  const nudge = (delta: number) => {
    const next = Math.min(max, Math.max(min, Math.round((value + delta) * 100) / 100));
    onChange(next);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-text-dark">{label}</span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="tabular-nums text-xs text-text-muted">{formatPercent(value)}</span>
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => nudge(step)}
              disabled={value >= max}
              title={`增加 ${formatPercent(step)}`}
              className="flex h-3.5 items-center justify-center text-text-muted transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-muted"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => nudge(-step)}
              disabled={value <= min}
              title={`减少 ${formatPercent(step)}`}
              className="flex h-3.5 items-center justify-center text-text-muted transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-muted"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
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
      <div className="mt-0.5 text-xs leading-relaxed text-text-muted/80">{hint}</div>
    </div>
  );
}

interface BorderLayerRowProps {
  layer: BorderLayer;
  index: number;
  open: boolean;
  hexDraft: string;
  onToggle: () => void;
  onChange: (patch: Partial<BorderLayer>) => void;
  onHexDraftChange: (value: string) => void;
  onHexDraftCommit: () => void;
  onRemove: () => void;
}

/** 一层边框。标题行显示色块 + 宽度，展开才出颜色与滑杆。 */
function BorderLayerRow({
  layer,
  index,
  open,
  hexDraft,
  onToggle,
  onChange,
  onHexDraftChange,
  onHexDraftCommit,
  onRemove,
}: BorderLayerRowProps) {
  const accent = getLayerAccentColor(index);
  const onColor = readableTextColor(accent);
  return (
    <div
      className="overflow-hidden rounded-lg border border-[rgba(128,128,128,0.7)]"
      style={{ backgroundColor: accent }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5" style={{ color: onColor }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
          <span className="shrink-0 text-xs font-medium text-current">边框 {index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-right tabular-nums text-xs text-current opacity-80">
            {formatPercent(layer.widthPercent)}
          </span>
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
            <span className="text-xs font-medium text-text-dark">边框 {index + 1}</span>
          </div>
          <div>
            <div className="mb-1 text-xs text-text-dark">颜色</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="color"
                value={layer.color}
                onChange={(event) => onChange({ color: event.target.value.toUpperCase() })}
                className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-[rgba(128,128,128,0.7)] bg-bg-dark/80 p-1"
              />
              <input
                type="text"
                value={hexDraft}
                spellCheck={false}
                onChange={(event) => onHexDraftChange(event.target.value)}
                onBlur={onHexDraftCommit}
                className="h-8 w-[96px] rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm uppercase text-text-dark outline-none"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BORDER_COLOR_PRESETS.map((preset) => {
                const active = layer.color.toUpperCase() === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    title={preset}
                    onClick={() => onChange({ color: preset })}
                    style={{ backgroundColor: preset }}
                    className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
                      active ? 'border-accent ring-2 ring-accent/50' : 'border-[rgba(128,128,128,0.7)]'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          <PercentSliderRow
            label="这一层宽度"
            hint="从图片（或内层）再向外扩一圈，输出画布会随之变大"
            value={layer.widthPercent}
            max={BORDER_LAYER_WIDTH_MAX_PERCENT}
            onChange={(value) => onChange({ widthPercent: value })}
          />
        </div>
      )}
    </div>
  );
}

export function CropToolEditor({
  plugin,
  sourceImageUrl,
  options,
  onOptionsChange,
  onSwitchTarget,
  onApplyBatch,
  onStripSnapshot,
  onBatchTrimToContent,
  onReorderImages,
  canvasImages,
  currentNodeId,
  currentOrderIndex,
  isBatchApplying,
  batchAppliedCount,
}: VisualToolEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousAspectKeyRef = useRef<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [customRatioInput, setCustomRatioInput] = useState(
    typeof options.customAspectRatio === 'string' ? options.customAspectRatio : ''
  );
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // 边框一旦真正生效（有层宽度 > 0，或有描边 / 圆角 / 补边），下方那个大裁剪框
  // 就没必要再占着地方了 —— 用户已经把裁剪区域定好了，这时候要的是边框参数和预览。
  // 自动收起，但留一个入口让用户随时能再展开回去改裁剪。
  const [isCropViewportVisible, setIsCropViewportVisible] = useState(true);
  // 裁剪区自己的缩放倍数。和输出预览的缩放是两套 —— 一个用来精修裁剪框，
  // 一个用来检查成品边框，互不干扰。
  const [cropZoom, setCropZoom] = useState(CROP_ZOOM_DEFAULT);

  // 顶部选择条：用户**手动加入**批量队列的图片 id 集合（不含当前图）。
  //
  // ⭐ 默认是空的 —— 条里一开始只有当前图那一格。
  // 早先把画布上全部图片节点一次性铺进条里，几十上百张时又卡又没意义；
  // 现在改成"用户自己把要批量套用的图加进来"，只渲染当前图 + 加进来的那几张。
  // ⚠️ 切换当前图**不再清空**队列：条里显示的正是「当前图 ∪ 队列」，清空就等于图从条里消失；
  // 换图时改为把旧当前图接进队列（见 handleSelectCurrent）。
  const [queuedIds, setQueuedIds] = useState<Set<string>>(() => new Set());

  /**
   * 画布上的图片节点（含当前图），顺序 = 画布顺序。
   *
   * ⚠️ 这份列表**只喂给"添加图片"候选面板**，默认不渲染 ——
   * 面板收起时 DOM 里只有 current + queued 那几张缩略图。
   * `orderIndex` 只负责排序（决定条里谁在前），编号不读它。
   */
  const canvasCandidates = useMemo<PictureStripCandidate[]>(
    () =>
      (canvasImages ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        imageUrl: item.imageUrl,
        width: item.width,
        height: item.height,
        orderIndex: item.orderIndex,
      })),
    [canvasImages]
  );

  /** 当前图的缩略图源：能从画布清单里拿到小图就用小图，拿不到再退回编辑用的原图。 */
  const currentThumbnailUrl = useMemo(
    () => canvasCandidates.find((item) => item.id === currentNodeId)?.imageUrl ?? sourceImageUrl,
    [canvasCandidates, currentNodeId, sourceImageUrl]
  );

  const currentPictureNode = useMemo<PictureStripCandidate | null>(() => {
    if (!currentNodeId) {
      return null;
    }
    // ⚠️ label / orderIndex 一律取画布清单里那一份：当前图现在**混在条里按画布顺序排**，
    // 标签写死「当前图」会和「当前」角标重复，也看不出这到底是画布上的哪一张。
    const fromCanvas = canvasCandidates.find((item) => item.id === currentNodeId);
    return {
      id: currentNodeId,
      label: fromCanvas?.label ?? '当前图',
      imageUrl: fromCanvas?.imageUrl ?? currentThumbnailUrl,
      width: naturalSize.width || undefined,
      height: naturalSize.height || undefined,
      orderIndex: fromCanvas?.orderIndex ?? currentOrderIndex,
    };
  }, [
    canvasCandidates,
    currentNodeId,
    currentOrderIndex,
    currentThumbnailUrl,
    naturalSize.height,
    naturalSize.width,
  ]);

  /**
   * 用户手动加入批量队列的图（不含当前图）。
   *
   * 顺序取自 canvasCandidates（= 画布顺序），**不是 queuedIds 的插入顺序** ——
   * 队列排列必须和画布一致，用户才不会把「位置变了」误读成「编号变了」。
   */
  const queuedCandidates = useMemo(
    () => canvasCandidates.filter((item) => item.id !== currentNodeId && queuedIds.has(item.id)),
    [canvasCandidates, currentNodeId, queuedIds]
  );

  /** 条里的全部图（当前图 ∪ 队列），按画布顺序排 —— 和条上渲染出来的顺序完全一致。 */
  const stripOrderedItems = useMemo(
    () => (currentPictureNode ? orderStripItems(currentPictureNode, queuedCandidates) : []),
    [currentPictureNode, queuedCandidates]
  );

  /**
   * 条内 0-based 位置表：id → 它在条里排第几。
   *
   * ⭐ 这是**编号的唯一依据**。条上的角标和文字里的 {n} 读的是同一个数，
   * 所以拖一下条两边一起变；不点「应用」，画布上的图不会动。
   */
  const stripIndexById = useMemo(() => buildStripIndexById(stripOrderedItems), [stripOrderedItems]);

  /**
   * 把当前选择条内容实时上报给父层（`NodeToolDialog`），供右下角「应用」整批落图用。
   *
   * ⭐ 这是「应用只对一张图生效」的正解：队列（哪些图）+ 编号表都在本组件内部，
   * 父层过去拿不到，只能烘当前这一张。这里每次条内容/编号一变就同步一次。
   * 队列为空 → 传 `null`，父层据此退回「只应用当前图」的单图行为。
   */
  useEffect(() => {
    if (!onStripSnapshot || !currentNodeId) {
      return;
    }
    const otherIds = stripOrderedItems
      .filter((item) => item.id !== currentNodeId)
      .map((item) => item.id);
    if (otherIds.length === 0) {
      onStripSnapshot(null);
      return;
    }
    const record: Record<string, number> = {};
    stripIndexById.forEach((index, id) => {
      record[id] = index;
    });
    onStripSnapshot({
      sourceNodeId: currentNodeId,
      otherIds,
      textOrderIndexById: record,
    });
  }, [onStripSnapshot, stripOrderedItems, stripIndexById, currentNodeId]);

  // ---- 各区块（自动裁剪 / 边框 / 文字）的「批量应用到其他图」+「批量收到内容边界」 ----
  const [isBatchTrimming, setIsBatchTrimming] = useState(false);
  // 队列里的其它图（不含当前图）——各区块的批量按钮都作用在这些图上。
  const batchTargetIds = useMemo(
    () => stripOrderedItems.filter((item) => item.id !== currentNodeId).map((item) => item.id),
    [stripOrderedItems, currentNodeId]
  );
  const applyBatchScope = useCallback(
    (scope: BatchApplyScope) => {
      if (batchTargetIds.length === 0) {
        return;
      }
      onApplyBatch?.(batchTargetIds, stripIndexById, scope);
    },
    [batchTargetIds, onApplyBatch, stripIndexById]
  );
  const handleBatchTrim = useCallback(async () => {
    if (batchTargetIds.length === 0 || !onBatchTrimToContent) {
      return;
    }
    setIsBatchTrimming(true);
    try {
      await onBatchTrimToContent(batchTargetIds);
    } finally {
      setIsBatchTrimming(false);
    }
  }, [batchTargetIds, onBatchTrimToContent]);

  const batchButtonClass =
    'flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-text-dark transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50';
  const renderSectionBatchButton = (scope: BatchApplyScope, label: string) => (
    <button
      type="button"
      onClick={() => applyBatchScope(scope)}
      disabled={batchTargetIds.length === 0 || isBatchApplying}
      title={
        batchTargetIds.length === 0
          ? '先点顶部「添加图片」把要套用的图加进来'
          : `只把本区块的设置套用到队列里的 ${batchTargetIds.length} 张图（各图保留自己的裁剪框/比例）`
      }
      className={batchButtonClass}
    >
      {isBatchApplying ? '套用中…' : `${label}（${batchTargetIds.length}）`}
    </button>
  );
  const renderBatchTrimButton = () => (
    <button
      type="button"
      onClick={handleBatchTrim}
      disabled={batchTargetIds.length === 0 || isBatchTrimming}
      title={
        batchTargetIds.length === 0
          ? '先点顶部「添加图片」把要处理的图加进来'
          : `把队列里的 ${batchTargetIds.length} 张图的裁剪框，各自按自己的像素收到内容边界`
      }
      className={batchButtonClass}
    >
      {isBatchTrimming ? '收边中…' : `批量把裁剪框收到内容边界（${batchTargetIds.length}）`}
    </button>
  );

  /**
   * 条里是不是真的在编排**一批**图（当前图之外还有人）。
   *
   * ⭐ 这是编号口径的分水岭：
   *  - 条里有队列 → 编号**实时**按条内位置算（用户正在编排，所见即所得，拖一下就变）；
   *  - 条里只剩当前图 → **不重算**，保留这张图自己存着的编号。
   *    因为「应用」是确认落图、会关掉面板，条就没了；用户逐张切过去点「应用」时，
   *    每张图必须还记得自己在那一批里排第几，否则会全部退回 1。
   */
  const hasStripBatch = stripOrderedItems.length > 1;

  /** 图上存着的编号（批量套用时落盘的那份）。 */
  const storedTextIndex = Math.max(0, Math.floor(Number(options.textOrderIndex) || 0));

  /**
   * 当前图的编号（0-based）—— 文字编号 = 起始编号 + 它。
   *
   * 条里有一批图就按条内位置实时算；只剩当前图就用它自己存着的编号（判据见 imageOrder.ts）。
   */
  const resolvedTextIndex = resolveStripTextIndex({
    hasBatch: hasStripBatch,
    currentId: currentNodeId,
    stripIndexById,
    storedIndex: storedTextIndex,
  });

  /**
   * 把「当前图在条里的位置」写进 `options.textOrderIndex`。
   *
   * ⭐ 这是编号从面板传到出图链路的**唯一通道**：`NodeToolDialog` 点「应用」时
   * 把 options 原样交给 toolProcessor，`applyTextLayersToImage` 读 textOrderIndex 决定 {n}。
   *
   * ⚠️ 不能留到「点应用时再算」—— 那一层拿不到队列（队列是本组件的状态），
   * 只能退化成「画布第几张」，也就是之前那个 5,6,7,8,17 的 bug。
   * ⚠️ 只在**编排一批图**时覆盖；单图时留着图上存的值，别把已分配好的编号抹成 1。
   */
  useEffect(() => {
    if (!hasStripBatch || !currentNodeId || options.textOrderIndex === resolvedTextIndex) {
      return;
    }
    onOptionsChange({ ...options, textOrderIndex: resolvedTextIndex });
  }, [currentNodeId, hasStripBatch, onOptionsChange, options, resolvedTextIndex]);

  const displaySourceImageUrl = useMemo(
    () => resolveImageDisplayUrl(sourceImageUrl),
    [sourceImageUrl]
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    // 必须用原生监听器：React 的 onWheel 在根节点上是 passive 的，
    // preventDefault 不生效，滚轮会连带把弹窗一起滚走。
    const handleCropWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const step = event.deltaY < 0 ? PREVIEW_ZOOM_WHEEL_STEP : 1 / PREVIEW_ZOOM_WHEEL_STEP;
      setCropZoom((current) => clampZoom(current * step, CROP_ZOOM_MIN, CROP_ZOOM_MAX));
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    element.addEventListener('wheel', handleCropWheel, { passive: false });

    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', handleCropWheel);
    };
    // 收起 / 展开会重建 DOM 节点，必须重新挂 observer 和监听器，
    // 否则会一直盯着已卸载的旧节点。
  }, [isCropViewportVisible]);

  /** 适应容器的大小（缩放倍数 = 1 时的渲染尺寸）。 */
  const fitImageSize = useMemo(() => {
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / naturalSize.width, maxHeight / naturalSize.height, 1);

    return {
      width: Math.max(1, Math.round(naturalSize.width * ratio)),
      height: Math.max(1, Math.round(naturalSize.height * ratio)),
    };
  }, [naturalSize.height, naturalSize.width, viewportSize.height, viewportSize.width]);

  /**
   * 裁剪区实际渲染尺寸 = 适应尺寸 × 缩放倍数。
   *
   * 缩放直接作用在渲染尺寸上（而不是套一层 CSS transform），
   * 是因为 toImageSpaceCrop / toRenderedCrop 本来就是按「渲染尺寸 vs 原图尺寸」
   * 的比例换算的 —— 渲染尺寸变大，裁剪坐标自动跟着换算正确，不用额外补偿。
   */
  const renderedImageSize = useMemo(() => {
    if (!fitImageSize) {
      return null;
    }

    return {
      width: Math.max(1, Math.round(fitImageSize.width * cropZoom)),
      height: Math.max(1, Math.round(fitImageSize.height * cropZoom)),
    };
  }, [fitImageSize, cropZoom]);

  const ratioOptions = useMemo(() => {
    const field = plugin.fields.find((item) => item.type === 'select' && item.key === 'aspectRatio');
    if (!field) {
      return [
        { label: '自由', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '4:5', value: '4:5' },
        { label: '5:4', value: '5:4' },
        { label: '2:1', value: '2:1' },
        { label: '21:9', value: '21:9' },
        { label: '原图', value: 'original' },
      ];
    }

    return (field as ToolSelectField).options;
  }, [plugin.fields]);

  const aspectMode = typeof options.aspectRatio === 'string' ? options.aspectRatio : 'free';
  const resolvedAspect = useMemo(() => {
    if (aspectMode === 'free') {
      return undefined;
    }

    if (aspectMode === 'original') {
      if (naturalSize.width <= 0 || naturalSize.height <= 0) {
        return undefined;
      }
      return naturalSize.width / naturalSize.height;
    }

    if (aspectMode === 'custom') {
      return parseCustomRatio(customRatioInput) ?? undefined;
    }

    return parsePresetRatio(aspectMode) ?? undefined;
  }, [aspectMode, customRatioInput, naturalSize.height, naturalSize.width]);

  const customRatioError = useMemo(() => {
    if (aspectMode !== 'custom') {
      return null;
    }
    if (!customRatioInput.trim()) {
      return '请输入比例，例如 3:2 或 1.5';
    }
    if (!parseCustomRatio(customRatioInput)) {
      return '比例格式无效';
    }
    return null;
  }, [aspectMode, customRatioInput]);

  const border = useMemo(() => readBorderOptions(options), [options]);

  const updateBorder = useCallback(
    (patch: Partial<BorderOptions>) => {
      onOptionsChange({
        ...options,
        ...toBorderToolOptions({ ...border, ...patch }),
      });
    },
    [border, onOptionsChange, options]
  );

  const updateLayer = useCallback(
    (id: string, patch: Partial<BorderLayer>) => {
      updateBorder({
        layers: border.layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
      });
    },
    [border.layers, updateBorder]
  );

  const addLayer = useCallback(() => {
    if (border.layers.length >= BORDER_MAX_LAYERS) {
      return;
    }

    const next: BorderLayer = {
      id: createBorderLayerId(),
      color: DEFAULT_BORDER_COLOR,
      // 新层给个看得见的宽度，否则用户点完「添加」什么都看不到，
      // 会以为按钮没生效。
      widthPercent: 4,
    };
    updateBorder({ layers: [...border.layers, next] });
    setExpandedLayerIds((current) => new Set(current).add(next.id));
  }, [border.layers, updateBorder]);

  const removeLayer = useCallback(
    (id: string) => {
      updateBorder({ layers: border.layers.filter((layer) => layer.id !== id) });
    },
    [border.layers, updateBorder]
  );

  // ---- 自动裁剪（按颜色去边）----
  //
  // 它排在整条裁剪链路的**最底层**：先按颜色把底图边界收到内容上，
  // 之后才轮到手动裁剪框、边框、文字。所以
  //
  //     有效裁剪框 = 手动裁剪框 ∩ 内容边界
  //
  // 边框是后面才叠上去的，永远不会被这一步吃掉 —— 这就是用户要的「PS 图层」效果：
  // 上层的不会影响下层的。
  const autoCrop = useMemo(() => readAutoCropOptions(options), [options]);

  const updateAutoCrop = useCallback(
    (patch: Partial<AutoCropOptions>) => {
      onOptionsChange({ ...options, ...toAutoCropToolOptions({ ...autoCrop, ...patch }) });
    },
    [autoCrop, onOptionsChange, options]
  );

  /**
   * 检测用的图**单独加载一份**。
   *
   * ⚠️ 不能直接拿裁剪区那张 `<img>`（imageRef）—— 它没设 crossOrigin，
   * 远程图会把画布污染掉，`getImageData` 直接抛异常。
   * `loadImageElement` 对 http(s)/asset 会带上 crossOrigin，而且出图链路用的是同一个函数，
   * 两边读到的像素一致，算出来的内容边界才可能一模一样。
   */
  const [detectImage, setDetectImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDetectImage(null);
    loadImageElement(sourceImageUrl)
      .then((image) => {
        if (!cancelled) {
          setDetectImage(image);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetectImage(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sourceImageUrl]);

  const [autoCropDetection, setAutoCropDetection] = useState<AutoCropDetection | null>(null);
  /** 'idle' = 没开或还在识别 · 'ready' = 有结果 · 'unavailable' = 读不到像素 */
  const [autoCropStatus, setAutoCropStatus] = useState<'idle' | 'ready' | 'unavailable'>('idle');

  /**
   * 扫描去抖。容差滑杆是连续拖的，每动一格就全图扫一遍会明显卡手 ——
   * 停手 120ms 之后才真正跑。
   *
   * ⚠️ 依赖只列**影响识别的字段**，不列 options 本身：
   * 拖动裁剪框时 options 一直在变，挂在 options 上会让扫描被无谓地反复触发。
   */
  useEffect(() => {
    if (!autoCrop.enabled || !detectImage) {
      setAutoCropDetection(null);
      setAutoCropStatus('idle');
      return;
    }

    const handle = window.setTimeout(() => {
      const result = measureAutoCrop(detectImage, autoCrop);
      setAutoCropDetection(result);
      setAutoCropStatus(result ? 'ready' : 'unavailable');
    }, AUTO_CROP_DETECT_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [autoCrop.color, autoCrop.edges, autoCrop.enabled, autoCrop.paddingPercent, detectImage]);

  /** 自动裁剪算出的内容矩形（原图像素空间）；没开或识别不出来时为 null。 */
  const autoCropRect = autoCrop.enabled ? autoCropDetection?.contentRect ?? null : null;

  /**
   * 面板读数用：四边**实际**裁掉多少。
   *
   * ⚠️ 不能直接显示 `detection.insets` —— 那是「识别到的背景厚度」，
   * 开了保留边距之后实际裁掉的要少一圈，两行数字对不上用户会以为算错了。
   */
  const autoCropRemovedInsets = useMemo(
    () =>
      autoCropDetection
        ? resolveRemovedInsets(
            autoCropDetection.contentRect,
            autoCropDetection.naturalWidth,
            autoCropDetection.naturalHeight
          )
        : null,
    [autoCropDetection]
  );

  /**
   * 有效裁剪框 = 手动框 ∩ 内容边界。
   *
   * 预览、文字排版、出图三处都读它。出图链路（toolProcessor.cropImage）用的是
   * 同一个 `resolveEffectiveCropRect`，所以这里看到的边界就是最终成品的边界。
   */
  const effectiveCropRect = useMemo(
    () => resolveEffectiveCropRect(readCropRect(options), autoCropRect),
    [autoCropRect, options]
  );

  /** 裁剪区里那条虚线参考框：把内容边界画在渲染图上，用户能看见「裁到哪」。 */
  const autoCropGuide = useMemo(() => {
    if (!autoCropRect || !renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const scaleX = renderedImageSize.width / naturalSize.width;
    const scaleY = renderedImageSize.height / naturalSize.height;

    return {
      left: autoCropRect.x * scaleX,
      top: autoCropRect.y * scaleY,
      width: autoCropRect.width * scaleX,
      height: autoCropRect.height * scaleY,
    };
  }, [autoCropRect, naturalSize.height, naturalSize.width, renderedImageSize]);
  /**
   * 四边都没裁到、但识别色和角落实色又对不上时，把角落实色报出来。
   *
   * ⚠️ 这是自动裁剪最常见的失效形态 —— 识别色选了「白」，图的背景其实是 #FDFDFD
   * （肉眼就是白），用户从界面上分不出来，只会觉得「这功能失效了」。
   * 报出实色并配一个「换成它」按钮，让用户一键纠正。
   */
  const autoCropEdgeMismatch = useMemo(() => {
    if (!autoCropDetection || !autoCropRemovedInsets) {
      return null;
    }
    if (!isTrimInsetsEmpty(autoCropRemovedInsets)) {
      return null;
    }
    if (isSameColor(autoCropDetection.cornerColor, autoCrop.color)) {
      return null;
    }
    return autoCropDetection.cornerColor;
  }, [autoCrop.color, autoCropDetection, autoCropRemovedInsets]);

  /**
   * 把裁剪框收到内容边界上。
   *
   * 顺手把比例切回「自由」—— 否则锁着 1:1 的话，ReactCrop 会立刻把刚设好的框掰回方形，
   * 用户看到的是「按钮点了没用」。
   */
  const applyAutoCropToCropBox = useCallback(() => {
    if (!autoCropRect) {
      return;
    }

    onOptionsChange({
      ...options,
      aspectRatio: 'free',
      cropX: autoCropRect.x,
      cropY: autoCropRect.y,
      cropWidth: autoCropRect.width,
      cropHeight: autoCropRect.height,
    });
  }, [autoCropRect, onOptionsChange, options]);

  const autoCropSummary = useMemo(() => {
    if (!autoCrop.enabled) {
      return '关';
    }
    const labels = AUTO_CROP_EDGE_ITEMS.filter((item) =>
      hasAutoCropEdge(autoCrop.edges, item.key)
    )
      .map((item) => item.label)
      .join('');
    return `${autoCrop.color} · ${labels || '不裁'}`;
  }, [autoCrop.color, autoCrop.edges, autoCrop.enabled]);

  // 十六进制输入框的草稿（和边框层同样的理由：敲到一半不该被规范化回弹）。
  const [autoCropHexDraft, setAutoCropHexDraft] = useState<string | null>(null);

  // ---- 文字图层 ----
  // 和「文字」工具读写的是 options / node.data 上的同一个字段，所以两边看到同一份参数。
  // 文字排在裁剪 → 边框之后落图，位置百分比是相对**最终输出画幅**的，
  // 这也正是裁剪面板预览里叠文字的那块区域，所见即所得。
  const textLayers = useMemo(() => readTextLayers(options[TEXT_LAYERS_KEY]), [options]);
  // `resolvedTextIndex`（当前图在条里排第几）在上面和选择条一起算好了 —— 它是编号的唯一依据。
  const [activeTextLayerId, setActiveTextLayerId] = useState<string | null>(null);

  // 展开的层必须真实存在：删层 / 切图后要落回第一层。
  useEffect(() => {
    if (textLayers.length === 0) {
      if (activeTextLayerId !== null) {
        setActiveTextLayerId(null);
      }
      return;
    }
    if (!activeTextLayerId || !textLayers.some((layer) => layer.id === activeTextLayerId)) {
      setActiveTextLayerId(textLayers[0].id);
    }
  }, [activeTextLayerId, textLayers]);

  const updateTextLayers = useCallback(
    (next: TextLayer[]) => {
      onOptionsChange({ ...options, [TEXT_LAYERS_KEY]: stringifyTextLayers(next) });
    },
    [onOptionsChange, options]
  );

  /** 左侧功能栏的折叠状态。默认展开最常用的两块，其余收起保持紧凑。 */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    ratio: true,
    autoCrop: false,
    border: true,
    edge: false,
    text: false,
  });
  const toggleSection = useCallback((key: string) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(
    () => new Set(border.layers.slice(0, 1).map((layer) => layer.id))
  );
  const toggleLayer = useCallback((id: string) => {
    setExpandedLayerIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 十六进制输入框单独留一份草稿，否则用户敲到一半就会被规范化回弹。
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});
  const handleHexDraftChange = useCallback(
    (id: string, value: string) => {
      setHexDrafts((current) => ({ ...current, [id]: value }));
      if (isValidHexColor(value)) {
        updateLayer(id, { color: value.trim().toUpperCase() });
      }
    },
    [updateLayer]
  );
  const handleHexDraftCommit = useCallback((id: string) => {
    setHexDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  /** 边框是否已经真正影响画面 —— 用来决定要不要自动收起裁剪区。 */
  const isBorderActive = useMemo(
    () =>
      border.layers.some((layer) => layer.widthPercent > 0)
      || border.strokePercent > 0
      || border.radiusPercent > 0
      || border.ratioMode !== 'none'
      || border.padPercent > 0,
    [border.layers, border.padPercent, border.radiusPercent, border.ratioMode, border.strokePercent]
  );

  // 边框开始生效时自动收起裁剪框；用户手动展开后不会被边框参数的改动再次收起，
  // 因为这个 effect 只盯着 isBorderActive 这一个布尔值。
  useEffect(() => {
    if (isBorderActive) {
      setIsCropViewportVisible(false);
    }
  }, [isBorderActive]);

  // 预览盒是响应式的，尺寸靠 ResizeObserver 量出来再算缩放比，
  // 这样不同窗口宽度下预览都能把可用空间吃满，而不是固定一个小框。
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [previewBoxSize, setPreviewBoxSize] = useState({ width: 0, height: 0 });

  // 滚轮缩放 + 拖拽平移。zoom = 1 表示适应容器。
  // 初值必须取「默认档」而不是最小值：缩放允许小于 1 之后，
  // 拿最小值当初值会让预览一打开就缩成一小团。
  const [previewZoom, setPreviewZoom] = useState(PREVIEW_ZOOM_DEFAULT);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const previewDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  // 平移边界由 borderPreview 算出来，拖拽时从这里读，避免把图拖出可视区。
  const previewBoundsRef = useRef({ x: 0, y: 0 });

  // 「复位」是回到默认视图（1 倍 + 居中），不是缩到最小 —— 用 MIN 会让双击后画面缩成一团。
  const resetPreviewView = useCallback(() => {
    setPreviewZoom(PREVIEW_ZOOM_DEFAULT);
    setPreviewOffset({ x: 0, y: 0 });
  }, []);

  const resetCropView = useCallback(() => {
    setCropZoom(CROP_ZOOM_DEFAULT);
  }, []);

  useEffect(() => {
    // 预览盒现在常驻（没有边框时也在），所以只挂一次。
    const element = previewBoxRef.current;
    if (!element) {
      return;
    }

    const updatePreviewBoxSize = () => {
      const rect = element.getBoundingClientRect();
      setPreviewBoxSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const step = event.deltaY < 0 ? PREVIEW_ZOOM_WHEEL_STEP : 1 / PREVIEW_ZOOM_WHEEL_STEP;
      setPreviewZoom((current) => clampZoom(current * step, PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX));
    };

    updatePreviewBoxSize();
    const observer = new ResizeObserver(updatePreviewBoxSize);
    observer.observe(element);
    element.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    setCustomRatioInput(typeof options.customAspectRatio === 'string' ? options.customAspectRatio : '');
  }, [options.customAspectRatio]);

  const syncCropToOptions = useCallback((pixelCrop: PixelCrop) => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return;
    }

    const imageCrop = toImageSpaceCrop(
      pixelCrop,
      renderedImageSize.width,
      renderedImageSize.height,
      naturalSize.width,
      naturalSize.height
    );

    onOptionsChange({
      ...options,
      aspectRatio: aspectMode,
      customAspectRatio: customRatioInput,
      ...imageCrop,
    });
  }, [
    aspectMode,
    customRatioInput,
    naturalSize.height,
    naturalSize.width,
    onOptionsChange,
    options,
    renderedImageSize,
  ]);

  const applyCropFromOptions = useCallback((): boolean => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return false;
    }

    const cropX = toNumber(options.cropX);
    const cropY = toNumber(options.cropY);
    const cropWidth = toNumber(options.cropWidth);
    const cropHeight = toNumber(options.cropHeight);
    if (
      cropX === null ||
      cropY === null ||
      cropWidth === null ||
      cropHeight === null ||
      cropWidth <= 0 ||
      cropHeight <= 0
    ) {
      return false;
    }

    setCrop(
      toRenderedCrop(
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        renderedImageSize.width,
        renderedImageSize.height,
        naturalSize.width,
        naturalSize.height
      )
    );
    return true;
  }, [naturalSize.height, naturalSize.width, options.cropHeight, options.cropWidth, options.cropX, options.cropY, renderedImageSize]);

  useEffect(() => {
    if (!renderedImageSize) {
      return;
    }

    const aspectKey = `${aspectMode}:${aspectMode === 'custom' ? customRatioInput : ''}`;
    const aspectModeChanged =
      previousAspectKeyRef.current !== null
      && previousAspectKeyRef.current !== aspectKey;
    previousAspectKeyRef.current = aspectKey;

    if (!aspectModeChanged && applyCropFromOptions()) {
      return;
    }

    const next = buildDefaultCrop(
      renderedImageSize.width,
      renderedImageSize.height,
      resolvedAspect
    );
    setCrop(next);
    syncCropToOptions({
      unit: 'px',
      x: Math.round(next.x ?? 0),
      y: Math.round(next.y ?? 0),
      width: Math.round(next.width ?? renderedImageSize.width),
      height: Math.round(next.height ?? renderedImageSize.height),
    });
  }, [
    applyCropFromOptions,
    aspectMode,
    customRatioInput,
    renderedImageSize,
    resolvedAspect,
    syncCropToOptions,
  ]);

  /**
   * 纯 CSS 预览，不碰 canvas —— 避免远程图源把画布污染掉（taint），
   * 也省掉一次异步取图。几何算法与 toolProcessor 里的出图逻辑共用同一套
   * resolveBorderGeometry，所以预览和实际输出一致。
   *
   * DOM 结构与 canvas 的绘制顺序严格对应：
   *   画布底色（最外层颜色）→ 各层同心圆角矩形（外→内）→ 图片。
   */
  const borderPreview = useMemo(() => {
    // 注意：这里不看有没有边框 —— 没有边框时中间这块要当"纯裁剪结果"的
    // 实时预览用，否则裁剪阶段那么大一块面板就是空的。
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    // ⚠️ 用「有效裁剪框」（手动框 ∩ 自动裁剪的内容边界），不是手动画的那个框。
    // 自动裁剪在最底层，边框叠在它上面，所以预览必须按收边后的画幅算 ——
    // 否则用户看到的边框宽度和成品的边框宽度对不上。
    const cropX = effectiveCropRect?.x ?? 0;
    const cropY = effectiveCropRect?.y ?? 0;
    const cropWidth = effectiveCropRect?.width ?? naturalSize.width;
    const cropHeight = effectiveCropRect?.height ?? naturalSize.height;

    if (cropWidth <= 0 || cropHeight <= 0) {
      return null;
    }

    const geometry = resolveBorderGeometry(cropWidth, cropHeight, border);
    const availableWidth = Math.max(
      1,
      (previewBoxSize.width || BORDER_PREVIEW_FALLBACK_WIDTH) - BORDER_PREVIEW_PADDING_PX * 2
    );
    const availableHeight = Math.max(
      1,
      (previewBoxSize.height || BORDER_PREVIEW_FALLBACK_HEIGHT) - BORDER_PREVIEW_PADDING_PX * 2
    );
    // fitScale 只负责"适应容器"，用户滚轮缩放叠在它上面，
    // 所以改窗口大小或改边框参数都不会把用户的缩放倍数重置掉。
    const fitScale = Math.min(
      availableWidth / geometry.canvasWidth,
      availableHeight / geometry.canvasHeight
    );
    const scale = fitScale * previewZoom;

    // 框的可视尺寸 = 适应容器后的尺寸（不含用户缩放）。
    // 预览框按它定型：横图就是扁框、竖图就是竖框，不再一律撑成跟列一样高的竖框。
    const boxWidth = geometry.canvasWidth * fitScale;
    const boxHeight = geometry.canvasHeight * fitScale;

    const outerWidth = geometry.canvasWidth * scale;
    const outerHeight = geometry.canvasHeight * scale;
    // 边界 = 内容超出框多少的一半 + 一段余量。
    // 基准必须用框尺寸而不是可用区：横图时可用区高度远大于框高，
    // 拿可用区算余量会大得离谱，内容能被拖到几乎完全移出框。
    const maxOffsetX =
      Math.max(0, (outerWidth - boxWidth) / 2)
      + boxWidth * PREVIEW_PAN_MARGIN_RATIO;
    const maxOffsetY =
      Math.max(0, (outerHeight - boxHeight) / 2)
      + boxHeight * PREVIEW_PAN_MARGIN_RATIO;

    return {
      boxWidth,
      boxHeight,
      outerWidth,
      outerHeight,
      maxOffsetX,
      maxOffsetY,
      offsetX: clampOffset(previewOffset.x, maxOffsetX),
      offsetY: clampOffset(previewOffset.y, maxOffsetY),
      fillColor: geometry.fillColor,
      innerLeft: geometry.padX * scale,
      innerTop: geometry.padY * scale,
      innerWidth: cropWidth * scale,
      innerHeight: cropHeight * scale,
      radius: geometry.radiusPx * scale,
      stroke: geometry.strokePx * scale,
      strokeColor: geometry.strokeColor,
      // 外→内，保证内层画在外层之上
      rings: geometry.rings
        .filter((ring) => ring.thicknessPx > 0)
        .slice()
        .reverse()
        .map((ring) => ({
          color: ring.color,
          offset: ring.outerOffsetPx * scale,
          radius: ring.radiusPx * scale,
        })),
      backgroundSize: `${naturalSize.width * scale}px ${naturalSize.height * scale}px`,
      backgroundPosition: `${-cropX * scale}px ${-cropY * scale}px`,
      outputWidth: geometry.canvasWidth,
      outputHeight: geometry.canvasHeight,
      outputRatio: describeAspectRatio(geometry.canvasWidth, geometry.canvasHeight),
    };
  }, [
    border,
    effectiveCropRect,
    naturalSize.height,
    naturalSize.width,
    previewBoxSize.height,
    previewBoxSize.width,
    previewOffset.x,
    previewOffset.y,
    previewZoom,
  ]);

  useEffect(() => {
    previewBoundsRef.current = {
      x: borderPreview?.maxOffsetX ?? 0,
      y: borderPreview?.maxOffsetY ?? 0,
    };
  }, [borderPreview?.maxOffsetX, borderPreview?.maxOffsetY]);

  /**
   * 文字排布按**输出画幅**算（裁剪 + 边框之后的尺寸），不是原图 ——
   * 用户看到的落点就是成品的落点。
   */
  const cropTextLayouts = useMemo(() => {
    if (!borderPreview) {
      return [];
    }
    return resolveTextLayersLayout(
      borderPreview.outputWidth,
      borderPreview.outputHeight,
      textLayers,
      resolvedTextIndex
    );
  }, [borderPreview, resolvedTextIndex, textLayers]);

  // 横图（裁剪后宽高比 ≥ 阈值）单独一套列宽配比。
  // 用「裁剪后」比例而不是原始比例 —— 用户一旦裁成竖图，配比就该跟着收回去，
  // 而不是还按横图铺开。
  const isWideLayout = useMemo(() => {
    // 同样读有效裁剪框 —— 自动裁剪把白边去掉之后，本来「横」的图可能变「方」，
    // 布局该跟着收回去。
    const cropWidth = effectiveCropRect?.width ?? naturalSize.width;
    const cropHeight = effectiveCropRect?.height ?? naturalSize.height;
    if (cropWidth <= 0 || cropHeight <= 0) {
      return false;
    }
    return cropWidth / cropHeight >= LAYOUT_WIDE_RATIO_THRESHOLD;
  }, [effectiveCropRect, naturalSize.width, naturalSize.height]);

  /**
   * 三列网格的列宽模板。两个维度共同决定：
   *
   * 1. `isWideLayout`：横图的预览框受**列宽**限制（16:9 塞进窄列只能得到一个小扁框），
   *    所以横图把权重压给预览列；竖图/方图的框受**列高**限制，给再多宽度也用不上，
   *    维持三列均分。
   * 2. `isCropViewportVisible`：边框一生效裁剪区就自动收起，此时那一列只剩一个
   *    「展开」按钮。把腾出来的宽度**全部让给预览**，否则宽图预览框旁边会留一大片空白
   *    —— 这正是「明明有很多地方是空白的」的根源。
   *
   * 注意：列宽下限只写在这里（grid track 的 minmax 第一项），子元素上不要再写
   * `min-w-[Npx]` —— grid item 的 min-width 会撑破轨道并压到相邻列。
   */
  const gridColumns = useMemo(() => {
    if (isWideLayout) {
      return isCropViewportVisible
        ? 'minmax(280px, 0.62fr) minmax(0, 1.45fr) minmax(340px, 1.15fr)'
        : 'minmax(280px, 0.62fr) minmax(0, 2.7fr) minmax(200px, 0.5fr)';
    }
    return isCropViewportVisible
      ? 'minmax(280px, 0.9fr) minmax(320px, 1.05fr) minmax(340px, 1.05fr)'
      : 'minmax(280px, 0.62fr) minmax(320px, 1.5fr) minmax(200px, 0.5fr)';
  }, [isCropViewportVisible, isWideLayout]);

  // 回到 1 倍（默认视图）时把平移一并归零，否则再放大时会从一个莫名其妙的位置开始。
  useEffect(() => {
    if (Math.abs(previewZoom - PREVIEW_ZOOM_DEFAULT) <= 0.001) {
      setPreviewOffset({ x: 0, y: 0 });
    }
  }, [previewZoom]);

  /**
   * 预览视图是否被用户动过（缩放或平移）。
   * 注意不能用 `previewZoom > PREVIEW_ZOOM_MIN` 判断 —— 缩放允许小于 1 之后，
   * 缩小到 50% 也满足 "> 最小值"，会误判成「已放大」而常驻复位按钮和抓手光标。
   */
  const isPreviewViewAdjusted = useMemo(
    () =>
      Math.abs(previewZoom - PREVIEW_ZOOM_DEFAULT) > 0.001
      || previewOffset.x !== 0
      || previewOffset.y !== 0,
    [previewOffset.x, previewOffset.y, previewZoom]
  );

  const isCropZoomAdjusted = useMemo(
    () => Math.abs(cropZoom - CROP_ZOOM_DEFAULT) > 0.001,
    [cropZoom]
  );

  const handlePreviewPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 不再要求「先放大才能拖」—— 平移余量让默认视图也能挪动，方便贴着边看细节。
      previewDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: previewOffset.x,
        originY: previewOffset.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [previewOffset.x, previewOffset.y, previewZoom]
  );

  const handlePreviewPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = previewDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const bounds = previewBoundsRef.current;
      setPreviewOffset({
        x: clampOffset(drag.originX + (event.clientX - drag.startX), bounds.x),
        y: clampOffset(drag.originY + (event.clientY - drag.startY), bounds.y),
      });
    },
    []
  );

  const handlePreviewPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    previewDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) {
      return;
    }

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }, []);

  const activeRatioLabel = useMemo(() => {
    const found = ratioOptions.find((item) => item.value === aspectMode);
    if (found) {
      return found.label;
    }
    return aspectMode === 'custom' ? '自定义' : aspectMode;
  }, [aspectMode, ratioOptions]);

  const borderSummary = useMemo(() => {
    const parts: string[] = [];
    const visibleLayers = border.layers.filter((layer) => layer.widthPercent > 0).length;
    if (border.layers.length > 0) {
      parts.push(visibleLayers > 0 ? `${visibleLayers} 层` : `${border.layers.length} 层（宽度 0）`);
    }
    if (border.ratioMode !== 'none') {
      const found = BORDER_RATIO_PRESETS.find((item) => item.value === border.ratioMode);
      parts.push(found ? found.label : border.ratioMode);
    }
    if (border.padPercent > 0) {
      parts.push(`留白 ${formatPercent(border.padPercent)}`);
    }
    return parts.length > 0 ? parts.join(' · ') : '无';
  }, [border.layers, border.padPercent, border.ratioMode]);

  const edgeSummary = useMemo(() => {
    const parts: string[] = [];
    if (border.strokePercent > 0) {
      parts.push(`描边 ${formatPercent(border.strokePercent)}`);
    }
    if (border.radiusPercent > 0) {
      parts.push(`圆角 ${formatPercent(border.radiusPercent)}`);
    }
    return parts.join(' · ');
  }, [border.radiusPercent, border.strokePercent]);

  const cropViewport = (
    // 外层撑满：量可用尺寸 + 接滚轮缩放
    <div ref={viewportRef} className="relative flex min-h-[240px] flex-1 items-center justify-center">
      {/*
        内层才是可见视口：尺寸 = 适应尺寸（zoom = 1）+ 内边距，跟着图的比例走，
        横图得到扁视口、竖图得到竖视口。
        放大时内容超出视口、靠 overflow-auto 滚动 —— 视口自身不能跟着放大，否则会把列撑破。
      */}
      <div
        className="ui-scrollbar relative max-h-full max-w-full overscroll-contain overflow-auto rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85"
        style={{
          width: fitImageSize ? `${fitImageSize.width + VIEWPORT_PADDING_PX * 2}px` : undefined,
          height: fitImageSize ? `${fitImageSize.height + VIEWPORT_PADDING_PX * 2}px` : undefined,
          minWidth: '200px',
          minHeight: '160px',
        }}
      >
      <div
        className="flex h-max min-h-full w-max min-w-full items-center justify-center"
        style={{ padding: `${VIEWPORT_PADDING_PX}px` }}
      >
        {renderedImageSize && (
          /*
            外面这层只是给「内容边界」虚线框一个定位基准 —— 尺寸和图片严格一致
            （flex 让 ReactCrop 那个 inline-block 变成块级，不会多出行高带来的偏移），
            所以对原本的居中布局没有任何影响。
          */
          <div
            className="relative flex leading-none"
            style={{
              width: `${renderedImageSize.width}px`,
              height: `${renderedImageSize.height}px`,
            }}
          >
            <ReactCrop
              crop={crop}
              onChange={(nextCrop) => setCrop(nextCrop)}
              onComplete={(pixelCrop) => syncCropToOptions(pixelCrop)}
              aspect={resolvedAspect}
              minWidth={24}
              minHeight={24}
              keepSelection
              ruleOfThirds
            >
              <img
                ref={imageRef}
                src={displaySourceImageUrl}
                alt="Crop Source"
                className="block select-none object-contain"
                style={{
                  width: `${renderedImageSize.width}px`,
                  height: `${renderedImageSize.height}px`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
                onLoad={handleImageLoad}
              />
            </ReactCrop>
            {autoCropGuide && (
              // 只做标记，不拦鼠标 —— 底下的裁剪框照样能拖。
              <div
                className="pointer-events-none absolute border-2 border-dashed border-accent"
                style={{
                  left: `${autoCropGuide.left}px`,
                  top: `${autoCropGuide.top}px`,
                  width: `${autoCropGuide.width}px`,
                  height: `${autoCropGuide.height}px`,
                }}
              />
            )}
          </div>
        )}
        {!renderedImageSize && (
          <img
            ref={imageRef}
            src={displaySourceImageUrl}
            alt="Crop Source"
            className="hidden"
            onLoad={handleImageLoad}
          />
        )}
        </div>
      </div>
    </div>
  );

  /**
   * 切换当前编辑图 —— 条里点缩略图、弹窗里点 ⇄，两个入口都走这里。
   *
   * 队列的维护规则只有一条：**条里的图永远不许凭空消失**。所以换图要同时做两件事：
   *  - 新当前图从队列里摘出去 —— 它现在是参数来源，不能再当套用目标；
   *  - **旧当前图接进队列** —— 它原本只靠「当前图」那一格的位置显示，换图后如果不给
   *    归宿，就会既不是当前图、又不在队列里，直接从条里掉出去，用户再也找不回来。
   *
   * ⚠️ 早先的版本在这里 `setQueuedIds(new Set())` 一把清空 —— 切一次图，用户辛苦挑的
   * 几十张目标图全没了。同一个病根：切换时没给「旧图」留位置。
   */
  const handleSelectCurrent = useCallback(
    (id: string) => {
      if (id === currentNodeId) {
        return;
      }
      setQueuedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        if (currentNodeId) {
          next.add(currentNodeId);
        }
        return next;
      });
      onSwitchTarget?.(id);
    },
    [currentNodeId, onSwitchTarget]
  );

  const handleToggleQueued = useCallback((id: string) => {
    setQueuedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSetQueued = useCallback((ids: string[]) => {
    // 「哪些算其它图」由选择条算好传进来（它知道谁是当前图），这里只管落状态。
    setQueuedIds(new Set(ids));
  }, []);

  const handleClearQueue = useCallback(() => {
    setQueuedIds(new Set());
  }, []);

  /**
   * 「批量套用」= **预览**：把当前编排好的参数（含**编号分配**）铺到队列里的图，
   * 让用户逐张切过去检查。只写参数、不落图 —— 落图是每张图各自点「应用」的事。
   *
   * ⚠️ 编号表必须一起传出去：面板一关，条就没了，目标图只能靠自己存的那份编号
   * 才知道「我在这批里排第几」。
   */
  const handleApplyBatch = useCallback(
    (otherIds: string[]) => {
      onApplyBatch?.(otherIds, stripIndexById);
    },
    [onApplyBatch, stripIndexById]
  );

  return (
    <div className="flex flex-col gap-3">
      {currentPictureNode && onSwitchTarget && (
        <PictureStrip
          current={currentPictureNode}
          queued={queuedCandidates}
          available={canvasCandidates}
          onToggleQueued={handleToggleQueued}
          onSetQueued={handleSetQueued}
          onClearQueue={handleClearQueue}
          onSelectCurrent={handleSelectCurrent}
          onApplyBatch={handleApplyBatch}
          onReorder={onReorderImages}
          isApplying={isBatchApplying}
          appliedCount={batchAppliedCount}
          title="批量套用"
          showPosition
          emptyHint="还没添加要批量套用的图片，点右侧「添加图片」挑"
        />
      )}

      <div
        className="grid h-[min(82vh,940px)] gap-4 overflow-y-auto pr-0.5"
        style={{
          gridTemplateColumns: gridColumns,
          gridTemplateRows: 'minmax(0, 1fr)',
          gridTemplateAreas: '"left preview crop"',
        }}
      >
      {/* 左：功能栏 —— 裁剪比例 / 边框 / 描边圆角 / 按比例补边 / 文字，五个折叠区块。 */}
      {/* 高度两件套必须写全：
          - max-h-full：把列钉回父容器高度（grid 轨道是 1fr，但 stretch 仍会按内容拉高）。
          - min-h-0：解除 flex item 默认 min-height:auto，否则列内 flex-1 撑不开/收不回。
          列宽下限只写在 gridColumns 的 minmax 里，这里不再重复声明 min-w —— 见上面那条注释。 */}
      <div style={{ gridArea: 'left' }} className="ui-scrollbar flex max-h-full min-h-0 flex-col gap-2.5 overflow-y-auto pr-1">
        <CollapsibleSection
          title="裁剪比例"
          accent={getLayerAccentColor(0)}
          summary={activeRatioLabel}
          open={openSections.ratio}
          onToggle={() => toggleSection('ratio')}
        >
          <div className="flex flex-wrap items-center gap-2">
            {ratioOptions.map((item) => {
              const active = item.value === aspectMode;
              return (
                <button
                  key={item.value}
                  type="button"
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? 'border-accent/45 bg-accent/15 text-text-dark'
                      : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
                  }`}
                  onClick={() =>
                    onOptionsChange({
                      ...options,
                      aspectRatio: item.value,
                    })
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {aspectMode === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={customRatioInput}
                onChange={(event) => {
                  const next = event.target.value;
                  setCustomRatioInput(next);
                  onOptionsChange({
                    ...options,
                    aspectRatio: 'custom',
                    customAspectRatio: next,
                  });
                }}
                placeholder="输入比例，如 3:2 或 1.5"
                className="h-9 w-full rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-3 text-sm text-text-dark outline-none"
              />
              {customRatioError && <span className="text-xs text-red-300">{customRatioError}</span>}
            </div>
          )}
        </CollapsibleSection>

        {/*
          自动裁剪排在「裁剪比例」之后、「边框」之前 ——
          面板从上到下的顺序就是实际处理顺序：先按颜色把底图边界收到内容上，
          再叠边框、文字。边框是后叠上去的，所以永远不会被自动裁剪吃掉。
        */}
        <CollapsibleSection
          title="自动裁剪"
          accent={getLayerAccentColor(1)}
          icon={<ScanSearch className="h-3.5 w-3.5 shrink-0 text-current" />}
          summary={autoCropSummary}
          open={openSections.autoCrop}
          onToggle={() => toggleSection('autoCrop')}
        >
          {renderSectionBatchButton('autoCrop', '批量应用自动裁剪到其他图')}
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-xs text-text-dark">按颜色去边</span>
            <input
              type="checkbox"
              checked={autoCrop.enabled}
              onChange={(event) => updateAutoCrop({ enabled: event.target.checked })}
              className="h-4 w-4 cursor-pointer accent-accent"
            />
          </label>

          {!autoCrop.enabled && (
            <div className="rounded-lg border border-dashed border-[rgba(255,255,255,0.18)] px-3 py-2 text-xs leading-relaxed text-text-muted">
              打开后从原图四边向内扫，把指定颜色（比如白边）裁掉，碰到别的颜色就停 ——
              画面收到内容边界上。它只作用在底图上，边框和文字是之后才叠上去的，不会被裁掉。
            </div>
          )}

          {autoCrop.enabled && (
            <>
              <div>
                <div className="mb-1 text-xs text-text-dark">要裁掉的颜色</div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={autoCrop.color}
                    onChange={(event) => {
                      setAutoCropHexDraft(null);
                      updateAutoCrop({ color: event.target.value.toUpperCase() });
                    }}
                    className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-[rgba(128,128,128,0.7)] bg-bg-dark/80 p-1"
                  />
                  <input
                    type="text"
                    value={autoCropHexDraft ?? autoCrop.color}
                    spellCheck={false}
                    onChange={(event) => {
                      const next = event.target.value;
                      setAutoCropHexDraft(next);
                      if (isValidHexColor(next)) {
                        updateAutoCrop({ color: next.trim().toUpperCase() });
                      }
                    }}
                    onBlur={() => setAutoCropHexDraft(null)}
                    className="h-8 w-[96px] rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm uppercase text-text-dark outline-none"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {AUTO_CROP_COLOR_PRESETS.map((preset) => {
                    const active = autoCrop.color.toUpperCase() === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        title={preset}
                        onClick={() => {
                          setAutoCropHexDraft(null);
                          updateAutoCrop({ color: preset });
                        }}
                        style={{ backgroundColor: preset }}
                        className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
                          active ? 'border-accent ring-2 ring-accent/50' : 'border-[rgba(128,128,128,0.7)]'
                        }`}
                      />
                    );
                  })}
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-text-muted/80">
                  从四边向内扫，整行 / 整列还是这个颜色就继续裁，碰到别的颜色就停。
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs text-text-dark">参与去边的边</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {AUTO_CROP_EDGE_ITEMS.map((item) => {
                    const active = hasAutoCropEdge(autoCrop.edges, item.key);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          updateAutoCrop({ edges: toggleAutoCropEdge(autoCrop.edges, item.key) })
                        }
                        className={`h-7 w-9 rounded-lg border text-xs transition-colors ${
                          active
                            ? 'border-accent/45 bg-accent/15 text-text-dark'
                            : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
                        }`}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                  <span className="text-xs text-text-muted/80">只裁勾上的那几边</span>
                </div>
              </div>

              <PercentSliderRow
                label="保留边距"
                hint="正值＝往回多留一圈背景，避免主体贴边太紧；负值＝往内容里再多切一点，用来去掉自动裁剪后残留的那条细边。按图片短边百分比算。"
                value={autoCrop.paddingPercent}
                min={AUTO_CROP_PADDING_MIN_PERCENT}
                max={AUTO_CROP_PADDING_MAX_PERCENT}
                step={0.1}
                onChange={(value) => updateAutoCrop({ paddingPercent: value })}
              />

              {autoCropStatus === 'ready' && autoCropDetection && autoCropRemovedInsets ? (
                <div className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/50 px-2.5 py-2 text-xs leading-relaxed text-text-muted">
                  <span className="text-text-dark">内容边界</span>{' '}
                  <span className="tabular-nums">
                    {autoCropDetection.contentRect.width} × {autoCropDetection.contentRect.height}
                  </span>
                  <br />
                  <span className="tabular-nums">
                    裁掉 上 {autoCropRemovedInsets.top} · 下 {autoCropRemovedInsets.bottom} · 左{' '}
                    {autoCropRemovedInsets.left} · 右 {autoCropRemovedInsets.right} px
                  </span>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[rgba(255,255,255,0.18)] px-3 py-2 text-xs leading-relaxed text-text-muted">
                  {autoCropStatus === 'unavailable'
                    ? '这张图读不到像素（跨域限制），自动裁剪不会生效。'
                    : '正在识别…'}
                </div>
              )}

              {autoCropEdgeMismatch ? (
                <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 text-xs leading-relaxed text-amber-200">
                  四边都没裁到：图的边角其实是{' '}
                  <span className="font-mono">{autoCropEdgeMismatch}</span>，和识别色{' '}
                  <span className="font-mono">{autoCrop.color}</span> 对不上。
                  <button
                    type="button"
                    onClick={() => updateAutoCrop({ color: autoCropEdgeMismatch })}
                    className="ml-1 rounded border border-amber-400/50 px-1.5 py-0.5 text-amber-100 transition-colors hover:bg-amber-400/20"
                  >
                    换成它
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                onClick={applyAutoCropToCropBox}
                disabled={!autoCropRect}
                className="w-full rounded-lg border border-accent/45 bg-accent/15 py-2 text-xs text-text-dark transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                把裁剪框收到内容边界
              </button>

              {renderBatchTrimButton()}

              <div className="text-xs leading-relaxed text-text-muted/80">
                虚线框就是识别出的内容边界。裁剪框拖到它外面也没关系 ——
                多出来的部分会被截掉（自动裁剪在底层，边框、文字都在它上面）。
                上面的按钮会把裁剪框直接对齐到边界，并把比例切回「自由」。
              </div>
            </>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="边框"
          accent={getLayerAccentColor(2)}
          icon={<Frame className="h-3.5 w-3.5 shrink-0 text-current" />}
          summary={borderSummary}
          open={openSections.border}
          onToggle={() => toggleSection('border')}
        >
          {renderSectionBatchButton('border', '批量应用边框到其他图')}
          {border.layers.length === 0 && (
            <div className="rounded-lg border border-dashed border-[rgba(255,255,255,0.18)] px-3 py-2 text-xs text-text-muted">
              还没有边框层。点下面的「添加边框层」，再拖动宽度滑杆即可加边框。
            </div>
          )}

          {border.layers.map((layer, index) => (
            <BorderLayerRow
              key={layer.id}
              layer={layer}
              index={index}
              open={expandedLayerIds.has(layer.id)}
              hexDraft={hexDrafts[layer.id] ?? layer.color}
              onToggle={() => toggleLayer(layer.id)}
              onChange={(patch) => updateLayer(layer.id, patch)}
              onHexDraftChange={(value) => handleHexDraftChange(layer.id, value)}
              onHexDraftCommit={() => handleHexDraftCommit(layer.id)}
              onRemove={() => removeLayer(layer.id)}
            />
          ))}

          <button
            type="button"
            onClick={addLayer}
            disabled={border.layers.length >= BORDER_MAX_LAYERS}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[rgba(255,255,255,0.2)] py-2 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[rgba(255,255,255,0.2)] disabled:hover:text-text-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {border.layers.length >= BORDER_MAX_LAYERS
              ? `最多 ${BORDER_MAX_LAYERS} 层`
              : '添加边框层'}
          </button>

          <div className="text-xs leading-relaxed text-text-muted/80">
            层从内到外叠：第 1 层贴着图片，后面的层依次往外扩。想加双色边框就加两层。
          </div>

          <div className="border-t border-[rgba(255,255,255,0.08)] pt-3">
            <div className="mb-2 text-xs font-medium text-text-dark">按比例补边</div>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-text-dark">目标比例</div>
                <select
                  value={border.ratioMode}
                  onChange={(event) => updateBorder({ ratioMode: event.target.value })}
                  className="h-9 w-full rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-2 text-sm text-text-dark outline-none"
                >
                  {BORDER_RATIO_PRESETS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {border.ratioMode === 'custom' && (
                  <input
                    type="text"
                    value={border.customRatio}
                    onChange={(event) => updateBorder({ customRatio: event.target.value })}
                    placeholder="输入比例，如 3:2 或 1.5"
                    className="mt-2 h-9 w-full rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-3 text-sm text-text-dark outline-none"
                  />
                )}
              </div>

              <PercentSliderRow
                label="补边留白"
                hint="四边各自至少留出的背景宽度。0 = 不补边，越大四边留白越多；选了目标比例时，次要方向也会保持这一圈，四边平衡、不会一边一大条一边贴边。"
                value={border.padPercent}
                max={BORDER_PAD_MAX_PERCENT}
                step={0.1}
                onChange={(value) => updateBorder({ padPercent: value })}
              />

              <div className="text-xs leading-relaxed text-text-muted/80">
                补出来的那圈用最外层边框色；只有目标比例选「不补边」且留白为 0 时，才完全不改变画面。
              </div>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="描边与圆角"
          accent={getLayerAccentColor(3)}
          summary={edgeSummary}
          open={openSections.edge}
          onToggle={() => toggleSection('edge')}
        >
          <PercentSliderRow
            label="内侧描边"
            hint="沿图片边缘向内描线，不改变输出画布尺寸；颜色取最内层边框色"
            value={border.strokePercent}
            max={BORDER_STROKE_MAX_PERCENT}
            onChange={(value) => updateBorder({ strokePercent: value })}
          />

          <PercentSliderRow
            label="圆角"
            hint="图片与各层边框一起切圆角，半径随外扩距离同心变大"
            value={border.radiusPercent}
            max={BORDER_RADIUS_MAX_PERCENT}
            onChange={(value) => updateBorder({ radiusPercent: value })}
          />
        </CollapsibleSection>

        {/*
          文字排在裁剪 → 边框之后落图，所以放在最后一块 —— 处理顺序和面板从上到下的顺序一致。
          和「文字」工具共用同一份参数（options.textLayers），两边改的是同一个东西。
        */}
        <CollapsibleSection
          title="文字"
          accent={getLayerAccentColor(4)}
          icon={<Type className="h-3.5 w-3.5 shrink-0 text-current" />}
          summary={describeTextLayers(textLayers, resolvedTextIndex)}
          open={openSections.text}
          onToggle={() => toggleSection('text')}
        >
          {renderSectionBatchButton('text', '批量应用文字到其他图')}
          <TextLayersEditor
            layers={textLayers}
            onChange={updateTextLayers}
            orderIndex={resolvedTextIndex}
            activeLayerId={activeTextLayerId}
            onActiveLayerChange={setActiveTextLayerId}
            positionHint="位置用 X / Y 滑杆微调，右边预览实时看到落点"
          />
        </CollapsibleSection>
      </div>

      {/* 中：输出预览 —— 裁剪结果与边框实时合成，改任何参数立刻变。
          裁剪区收起时这一列会变宽（见 gridColumns），预览框跟着变大。 */}
      <div style={{ gridArea: 'preview' }} className="flex max-h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-dark">输出预览</span>
          <span className="text-xs text-text-muted/80">滚轮缩放 · 拖动平移 · 双击复位</span>
        </div>
        {/* 外层撑满列高：只负责量可用尺寸和接滚轮/拖拽（鼠标落在留白处也能缩放）。 */}
        <div
          ref={previewBoxRef}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={handlePreviewPointerUp}
          onPointerCancel={handlePreviewPointerUp}
          onDoubleClick={resetPreviewView}
          className={`relative flex min-h-[220px] flex-1 touch-none select-none items-center justify-center overflow-hidden ${
            isPreviewViewAdjusted ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
          }`}
        >
          {/*
            内层才是用户看得见的预览框：尺寸 = 适应后的画面尺寸 + 内边距，
            所以横图得到扁框、竖图得到竖框，不再一律撑成跟列一样高的竖框
            （原来横图塞进竖框，上下一大片空白很难看）。
          */}
          <div
            className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-black/30"
            style={{
              width: borderPreview
                ? `${borderPreview.boxWidth + BORDER_PREVIEW_PADDING_PX * 2}px`
                : undefined,
              height: borderPreview
                ? `${borderPreview.boxHeight + BORDER_PREVIEW_PADDING_PX * 2}px`
                : undefined,
              minWidth: '180px',
              minHeight: '120px',
              padding: `${BORDER_PREVIEW_PADDING_PX}px`,
            }}
          >
            {borderPreview ? (
              <div
                className="absolute"
                style={{
                  left: '50%',
                  top: '50%',
                  width: `${borderPreview.outerWidth}px`,
                  height: `${borderPreview.outerHeight}px`,
                  transform: `translate(calc(-50% + ${borderPreview.offsetX}px), calc(-50% + ${borderPreview.offsetY}px))`,
                  backgroundColor: borderPreview.fillColor,
                }}
              >
                <div
                  className="absolute"
                  style={{
                    left: `${borderPreview.innerLeft}px`,
                    top: `${borderPreview.innerTop}px`,
                    width: `${borderPreview.innerWidth}px`,
                    height: `${borderPreview.innerHeight}px`,
                  }}
                >
                  {borderPreview.rings.map((ring) => (
                    <div
                      key={`${ring.color}-${ring.offset}`}
                      className="absolute"
                      style={{
                        inset: `${-ring.offset}px`,
                        backgroundColor: ring.color,
                        borderRadius: `${ring.radius}px`,
                      }}
                    />
                  ))}
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage: `url("${displaySourceImageUrl}")`,
                      backgroundSize: borderPreview.backgroundSize,
                      backgroundPosition: borderPreview.backgroundPosition,
                      backgroundRepeat: 'no-repeat',
                      borderRadius: `${borderPreview.radius}px`,
                      boxShadow:
                        borderPreview.stroke > 0
                          ? `inset 0 0 0 ${borderPreview.stroke}px ${borderPreview.strokeColor}`
                          : undefined,
                    }}
                  />
                </div>

                {/*
                  文字叠在**整个输出画布**上（含补边补出来的那圈），
                  和出图顺序一致：先裁剪、再边框、最后文字。
                */}
                {cropTextLayouts.length > 0 && (
                  <div className="pointer-events-none absolute inset-0">
                    {cropTextLayouts.map((layout) => (
                      <TextLayerPreview
                        key={layout.layerId}
                        layout={layout}
                        scale={borderPreview.outerWidth / borderPreview.outputWidth}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="px-4 text-center text-xs text-text-muted">正在读取图片…</span>
            )}
          </div>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5 text-xs text-text-muted">
            {borderPreview ? (
              <>
                <div>
                  输出 {borderPreview.outputWidth} × {borderPreview.outputHeight}
                </div>
                <div>比例 {borderPreview.outputRatio}</div>
              </>
            ) : (
              <div>—</div>
            )}
            {border.layers.length === 0 && (
              <div className="text-text-muted/70">没有边框层，当前显示纯裁剪结果</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="tabular-nums text-xs text-text-muted">
              {Math.round(previewZoom * 100)}%
            </span>
            {isPreviewViewAdjusted && (
              <button
                type="button"
                onClick={resetPreviewView}
                className="rounded-md border border-[rgba(255,255,255,0.18)] px-2 py-0.5 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark"
              >
                复位
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 右：裁剪区域。收起时这一列收窄成一个「展开」按钮，宽度让给预览列。 */}
      <div style={{ gridArea: 'crop' }} className="flex max-h-full min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-dark">裁剪区域</span>
          {isCropViewportVisible && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted/80">滚轮缩放</span>
              <span className="tabular-nums text-xs text-text-muted">
                {Math.round(cropZoom * 100)}%
              </span>
              {isCropZoomAdjusted && (
                <button
                  type="button"
                  onClick={resetCropView}
                  className="rounded-md border border-[rgba(255,255,255,0.18)] px-2 py-0.5 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark"
                >
                  复位
                </button>
              )}
            </div>
          )}
        </div>

        {isCropViewportVisible && cropViewport}

        <button
          type="button"
          onClick={() => setIsCropViewportVisible((current) => !current)}
          className="flex w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-[rgba(255,255,255,0.2)] bg-bg-dark/40 py-2.5 text-xs text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark"
        >
          {isCropViewportVisible ? (
            <>
              <Minimize2 className="h-3.5 w-3.5" />
              收起裁剪区域
            </>
          ) : (
            <>
              <Maximize2 className="h-3.5 w-3.5" />
              展开裁剪区域
            </>
          )}
        </button>
      </div>
      </div>
    </div>
  );
}
