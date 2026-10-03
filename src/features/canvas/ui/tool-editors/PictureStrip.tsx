import { useCallback, useMemo, useState } from 'react';
import { Layers, Plus, X } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { buildStripIndexById, orderStripItems } from './imageOrder';
import { PicturePickerDialog } from './PicturePickerDialog';

export interface PictureStripCandidate {
  id: string;
  label: string;
  /**
   * 缩略图源。
   * ⚠️ 请优先传 `previewImageUrl`（小图）而不是 `imageUrl`（原图）——
   * 条里 / 候选面板里一次要渲染几十个 `<img>`，拿原图会明显吃内存和解码时间。
   */
  imageUrl: string;
  /** 在节点 data 里存的真实尺寸，用来给缩略图贴一个尺寸提示。 */
  width?: number | null;
  height?: number | null;
  /**
   * 该图在**有效图片顺序**（= 整张画布所有图片节点）中的 0-based 下标。
   *
   * ⚠️ 它**只用来排序**：决定条里谁在前谁在后、以及拖动时往哪个槽位写回全局顺序。
   * **编号不读它** —— 编号读的是「条内位置」（见 `buildStripIndexById`）。
   */
  orderIndex?: number;
}

interface PictureStripProps {
  /** 当前正在编辑的图。恒显示在条里、带「当前」角标，且**不参与批量计数**。 */
  current: PictureStripCandidate;
  /** 用户手动加入批量队列的图（不含当前图），按有效图片顺序。 */
  queued: PictureStripCandidate[];
  /**
   * 画布上全部可加入的图片（含当前图）。
   * ⚠️ 它**只用来喂"添加图片"弹窗** —— 弹窗关着时一张缩略图都不会渲染。
   */
  available: PictureStripCandidate[];
  /** 弹窗里加入 / 移出一张图。 */
  onToggleQueued: (id: string) => void;
  /** 一次性重设整个队列（「全部加入」/「全部移除」）。 */
  onSetQueued: (ids: string[]) => void;
  /** 清空队列。 */
  onClearQueue: () => void;
  /**
   * 切换当前编辑图 —— 条里点缩略图、弹窗里点卡片左上角 ⇄，两个入口都走这里。
   *
   * ⭐ **调用方要负责给「旧当前图」找归宿**（接进队列）：它既不是当前图、
   * 又不在队列里的话，切换后就会从条里凭空消失，用户再也找不回来。
   */
  onSelectCurrent: (id: string) => void;
  /** 把当前面板参数套用到队列里的全部图。 */
  onApplyBatch: (queuedIds: string[]) => void;
  /**
   * 拖动排序 —— 传出**条里这些图**的新顺序（id 数组）。不传 = 条里不可拖动。
   *
   * ⚠️ 条里只是全局图片顺序的一个**子集**（当前图 ∪ 队列），
   * 怎么把这份子集顺序映射回全局是调用方的事（没显示在条里的图原地不动）。
   * ⚠️ 这个顺序**同时决定文字编号**「图像1 / 图像2…」，不是纯视觉排序。
   */
  onReorder?: (orderedIds: string[]) => void;
  isApplying?: boolean;
  /**
   * 批量套用刚完成时的张数，用来把按钮文案换成「已套用 N 张」。
   *
   * ⚠️ 批量套用**只写参数、不落图**，界面上不会有别的变化 ——
   * 没有这个反馈，用户点完会以为「点了没反应」。`null` / 不传 = 不显示。
   */
  appliedCount?: number | null;

  // ---- 以下均为可选定制项，不传时保持裁剪面板的原有文案 ----

  /** 左侧标签。 */
  title?: string;
  /** 在缩略图上显示它在**条里排第几**（1,2,3…）。 */
  showPosition?: boolean;
  /** 队列为空时的提示语。 */
  emptyHint?: string;
  /** 批量按钮文案。count = 队列张数。 */
  buildApplyLabel?: (count: number) => string;
  /** 批量按钮禁用时的 tooltip。 */
  applyDisabledHint?: string;
}

/**
 * 批量套用的图片选择条。
 *
 * ⭐ 核心约定：**条里默认只有当前图，其余目标图由用户自己加进来。**
 *
 * 早先的版本把画布上**全部**图片节点一次性铺进条里，几十上百张时既卡（几十个
 * `<img>` 同时解码）又没意义（大部分图并不需要批量套用）。现在的模型是：
 *
 *  - 条里恒显示 `current` + `queued`（用户加进来的），这是"待套用清单"；
 *  - 点「添加图片」才打开**弹窗**，**这时才渲染画布全部图片的缩略图**——
 *    由用户主动触发，代价可接受；
 *  - 弹窗里点整张卡片 = 加入 / 移出队列，点左上角「切换」= 换当前编辑的图；
 *  - 队列里的图在条里点右上角 ✕ 即可移除，「清空」一次清光；
 *  - 条里的缩略图**可以拖动调整顺序** —— 调的是**全局图片顺序**（条里只是它的子集），
 *    所以拖完文字编号「图像1 / 图像2…」也会跟着变。
 *
 * ⭐ **位置恒等于画布顺序**：`current` 和 `queued` 混在一起按 `orderIndex` 排，
 * 当前图**不占第一格**、也不享受任何位置特权。任何操作都不增删、不重排 ——
 * 用户不会把「位置变了」误读成「编号变了」。
 * 当前图只用「当前」角标 + 高亮表达身份，**不用位置表达**。
 *
 * ⭐ **编号 = 条内位置**（第 1 格就是 1）。条上的角标和文字里的 {n} 读的是同一个数，
 * 所以拖一下条，两边的编号一起变 —— 只要还没点「应用」，画布上的图就不会动。
 *
 * 设计取舍：
 *  - 候选弹窗做成独立的 portal 弹窗（`PicturePickerDialog`）而不是内嵌小格子：
 *    内嵌格子受条高限制只能做到 76×44，编号和文件名根本看不清。
 *  - 当前图不做勾选 —— 它由底部「应用」按钮负责，不参与批量计数。
 */
export function PictureStrip({
  current,
  queued,
  available,
  onToggleQueued,
  onSetQueued,
  onClearQueue,
  onSelectCurrent,
  onApplyBatch,
  onReorder,
  isApplying = false,
  appliedCount = null,
  title = '批量套用',
  showPosition = false,
  emptyHint = '还没添加要批量套用的图片',
  buildApplyLabel,
  applyDisabledHint = '先点「添加图片」把要套用的图加进来',
}: PictureStripProps) {
  // 候选弹窗默认关着 —— 关着时画布上的图片一张都不渲染。
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const queuedIds = useMemo(() => new Set(queued.map((item) => item.id)), [queued]);

  const queuedCount = queued.length;

  /**
   * 条里的渲染顺序 = **纯画布顺序**，当前图不享受任何位置特权。
   *
   * ⚠️ 早先的版本把当前图单独拎出来摆在第一格 —— 用户点后面的图切换时，整条会重排：
   * 新当前图跳到第一格、旧当前图掉回队列位置。用户把「位置变了」直接读成
   * 「顺序/编号被改了」，**视觉重排本身就是问题，跟数据对不对无关**。
   * 当前图只用「当前」角标 + 高亮表达身份，不用位置表达。
   */
  const orderedItems = useMemo(() => orderStripItems(current, queued), [current, queued]);

  /**
   * 条内 0-based 位置表 —— 编号的唯一依据。
   *
   * 拖动条之后 `orderIndex` 会跟着全局顺序一起变，这张表自然重算，
   * 于是角标和文字编号同时跟着动，不需要任何额外同步。
   */
  const stripIndexById = useMemo(() => buildStripIndexById(orderedItems), [orderedItems]);

  // ---- 拖动排序 ----
  // 只在调用方传了 onReorder 时才启用。用原生 HTML5 DnD：条里最多几十格，
  // 不需要引入拖拽库；pointer 事件手搓反而要自己处理滚动容器里的自动滚动。
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const resetDrag = useCallback(() => {
    setDraggingId(null);
    setDropTargetId(null);
  }, []);

  /**
   * 松手：把被拖的图插到目标格**占据的那个位置**上（目标往后让位），其余顺次让开。
   *
   * ⚠️ 摘掉源之后**不要**调整 `to`：原目标索引处的元素已经往后挪了一格，
   * 插进 `to` 正好落在它后面 —— 这正是「拖到哪一格就占哪一格」的语义。
   * 早先按「插到目标之前」实现（`from < to` 时把 `to` 减一），
   * 结果从前往后拖一格会原地不动，看起来像拖动失效。
   */
  const handleDropOn = useCallback(
    (targetId: string) => {
      const sourceId = draggingId;
      resetDrag();
      if (!onReorder || !sourceId || sourceId === targetId) {
        return;
      }
      const ids = orderedItems.map((item) => item.id);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) {
        return;
      }
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      onReorder(ids);
    },
    [draggingId, onReorder, orderedItems, resetDrag]
  );

  const buildDragProps = useCallback(
    (id: string) => {
      if (!onReorder) {
        return undefined;
      }
      return {
        draggable: true,
        isDragging: draggingId === id,
        isDropTarget: draggingId !== null && draggingId !== id && dropTargetId === id,
        onDragStart: () => setDraggingId(id),
        onDragOver: () => setDropTargetId(id),
        onDrop: () => handleDropOn(id),
        onDragEnd: resetDrag,
      };
    },
    [draggingId, dropTargetId, handleDropOn, onReorder, resetDrag]
  );

  const applyLabel = buildApplyLabel
    ? buildApplyLabel(queuedCount)
    : queuedCount === 0
      ? '批量应用到其他图'
      : `批量应用到 ${queuedCount} 张`;

  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs leading-relaxed text-text-muted/80">{title}</span>

        {/*
          只有这一段横向滚动 —— 右侧按钮固定住。
          之前整条一起滚，图一多就得拖到最右边才点得到「批量应用」，很容易以为按钮没了。
        */}
        <div className="ui-scrollbar nowheel flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5">
          {orderedItems.map((item, position) => {
            const isCurrent = item.id === current.id;
            return (
              <ThumbnailTile
                key={item.id}
                node={item}
                isCurrent={isCurrent}
                position={showPosition ? position : undefined}
                // 点图面 = 切过去编辑这张；点右上角 ✕ = 移出队列。
                // 当前图那格两个都不给 —— 它已经在编辑了，也不参与批量队列。
                onSelect={isCurrent ? undefined : () => onSelectCurrent(item.id)}
                onRemove={isCurrent ? undefined : () => onToggleQueued(item.id)}
                dragProps={buildDragProps(item.id)}
              />
            );
          })}
          {queuedCount === 0 && (
            <span className="whitespace-nowrap text-xs text-text-muted/60">{emptyHint}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setIsPickerOpen(true)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[rgba(255,255,255,0.16)] px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:border-accent/40 hover:text-text-dark"
          >
            <Plus className="h-3.5 w-3.5" />
            添加图片
          </button>
          {queuedCount > 0 && (
            <button
              type="button"
              onClick={onClearQueue}
              className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-white/[0.04] hover:text-text-dark"
            >
              清空
            </button>
          )}
          <button
            type="button"
            disabled={isApplying || queuedCount === 0}
            title={
              queuedCount === 0
                ? applyDisabledHint
                : `把当前参数套用到队列里的 ${queuedCount} 张图`
            }
            onClick={() => onApplyBatch(queued.map((item) => item.id))}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-text-dark transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Layers className="h-3.5 w-3.5" />
            {isApplying
              ? '套用中…'
              : appliedCount !== null
                ? `已套用 ${appliedCount} 张`
                : applyLabel}
          </button>
        </div>
      </div>

      {/*
        候选弹窗：**只有打开时才渲染画布上的全部图片**。
        这是整个"避免卡顿"改造的关键 —— 关着时 DOM 里只有 current + queued 那几张。
      */}
      <PicturePickerDialog
        open={isPickerOpen}
        onClose={() => setIsPickerOpen(false)}
        available={available}
        currentId={current.id}
        queuedIds={queuedIds}
        showPosition={showPosition}
        positionById={stripIndexById}
        onToggleQueued={onToggleQueued}
        onSetQueued={onSetQueued}
        onSelectCurrent={(id) => {
          onSelectCurrent(id);
          // 切换后把弹窗关掉，让用户直接看到新图的面板内容。
          setIsPickerOpen(false);
        }}
      />
    </div>
  );
}

interface ThumbnailTileProps {
  node: PictureStripCandidate;
  /** 当前图：accent 描边 + 「当前」角标，且没有移除按钮。 */
  isCurrent?: boolean;
  /** 该图在**条里**排第几（0-based，显示时 +1）；undefined = 不显示编号 */
  position?: number;
  /** 传了才显示右上角 ✕（把这张图移出队列）。 */
  onRemove?: () => void;
  /**
   * 点整格图面 = 切换当前编辑图。
   *
   * ⭐ 之前这里**什么事件都没绑**：用户点条里的图毫无反应，只有 hover 边框变色，
   * 很容易误以为「点了 = 选中了」。而唯一的切换入口藏在候选弹窗卡片左上角那个
   * 小小的 ⇄ 图标里，基本没人找得到。
   * 当前图那格不传 —— 它自己就是当前图，没有「切到自己」这回事。
   */
  onSelect?: () => void;
  /**
   * 拖动排序（不传 = 这一格不可拖）。
   * 只有调用方给了 `onReorder` 时，`PictureStrip` 才会注入这一组。
   */
  dragProps?: {
    draggable: boolean;
    isDragging: boolean;
    isDropTarget: boolean;
    onDragStart: () => void;
    onDragOver: () => void;
    onDrop: () => void;
    onDragEnd: () => void;
  };
}

function ThumbnailTile({
  node,
  isCurrent = false,
  position,
  onRemove,
  onSelect,
  dragProps,
}: ThumbnailTileProps) {
  const sizeLabel = node.width && node.height ? `${node.width}×${node.height}` : null;
  const title = [
    node.label,
    sizeLabel,
    onSelect ? '点击切换为当前编辑图' : null,
    dragProps ? '可拖动调整顺序' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`group relative shrink-0 overflow-hidden rounded-lg border transition-colors ${
        isCurrent
          ? 'border-accent/60 ring-1 ring-accent/40'
          : 'border-[rgba(255,255,255,0.14)] hover:border-accent/40'
      } ${dragProps ? 'cursor-grab active:cursor-grabbing' : onSelect ? 'cursor-pointer' : ''} ${
        dragProps?.isDragging ? 'opacity-40' : ''
      } ${dragProps?.isDropTarget ? 'ring-2 ring-accent/70' : ''}`}
      style={{ width: 64 }}
      title={title}
      onClick={onSelect}
      draggable={dragProps?.draggable ?? false}
      onDragStart={
        dragProps
          ? (event) => {
              // 不 setData 的话某些环境下根本不会进入拖拽状态。
              event.dataTransfer.setData('text/plain', node.id);
              event.dataTransfer.effectAllowed = 'move';
              dragProps.onDragStart();
            }
          : undefined
      }
      onDragOver={
        dragProps
          ? (event) => {
              // 必须 preventDefault —— 否则 drop 事件永远不会触发。
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              dragProps.onDragOver();
            }
          : undefined
      }
      onDrop={
        dragProps
          ? (event) => {
              event.preventDefault();
              dragProps.onDrop();
            }
          : undefined
      }
      onDragEnd={dragProps ? () => dragProps.onDragEnd() : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      <div className="relative h-[44px] w-full bg-black/40">
        <img
          src={resolveImageDisplayUrl(node.imageUrl)}
          alt={node.label}
          draggable={false}
          loading="lazy"
          className="h-full w-full object-contain"
        />
        {isCurrent && (
          <span className="absolute left-1 top-1 rounded bg-accent/90 px-1 py-px text-[10px] font-medium leading-none text-white">
            当前
          </span>
        )}
        {typeof position === 'number' && (
          <span
            className={`absolute bottom-1 left-1 rounded px-1 py-px text-[10px] font-medium leading-none tabular-nums ${
              isCurrent ? 'bg-black/70 text-white' : 'bg-black/65 text-text-dark'
            }`}
          >
            {position + 1}
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            aria-label={`把 ${node.label} 移出批量队列`}
            onClick={(event) => {
              // ⚠️ 必须拦住冒泡：外层图面现在挂着「点击切换当前图」，
              // 不拦的话点一下 ✕ 会顺手把当前图也切过去（两件事一起发生）。
              event.stopPropagation();
              onRemove();
            }}
            className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border border-[rgba(255,255,255,0.3)] bg-black/60 text-white/80 transition-colors hover:border-red-400/60 hover:text-red-300"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="truncate px-1.5 py-1 text-[10px] text-text-muted">{node.label}</div>
    </div>
  );
}
