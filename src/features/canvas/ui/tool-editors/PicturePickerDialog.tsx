import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Check, Repeat2, X } from 'lucide-react';

import { UiButton } from '@/components/ui';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { PictureStripCandidate } from './PictureStrip';

interface PicturePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** 画布上全部图片（含当前图）。 */
  available: PictureStripCandidate[];
  /** 当前图的 id —— 它已经在选择条里了，不出现在候选里。 */
  currentId: string;
  /** 已加入批量队列的 id 集合。 */
  queuedIds: Set<string>;
  /** 在缩略图上显示该图在**条里**排第几。 */
  showPosition: boolean;
  /**
   * 条内 0-based 位置表（id → 位置）。
   *
   * ⚠️ 只有**已经在条里**的图（当前图 ∪ 队列）才有位置。当前图不会出现在候选里，
   * 所以这里能拿到的都是队列里的图 —— 用户能提前看到「这张加进去会是第几号」。
   */
  positionById: Map<string, number>;
  onToggleQueued: (id: string) => void;
  /** 一次性重设整个队列（「全部加入」/「全部移除」）。 */
  onSetQueued: (ids: string[]) => void;
  /** 切换当前编辑的图 —— 会把这个弹窗关掉。 */
  onSelectCurrent: (id: string) => void;
}

/**
 * 「选择要批量套用的图片」弹窗。
 *
 * ⭐ 为什么是弹窗而不是原来那条内嵌的小格子：
 * 内嵌面板受选择条那一行的高度限制，缩略图只有 76×44，编号和文件名基本看不清。
 * 改成弹窗后可以做到 1200×80vh，缩略图放大到 180×132，一眼能认出是哪张图。
 *
 * ⚠️ 用 `createPortal` 挂到 `document.body`：
 * 裁剪面板本身在一个 `overflow-y-auto` 的滚动容器里，直接渲染会被裁掉；
 * 而且层级要盖过裁剪弹窗（z-50），所以用 `z-[200]`。
 *
 * 交互：
 *  - 点整张卡片 = 加入 / 移出批量队列（命中区域就是整块，不用瞄准小勾选框）
 *  - 左上角 ⇄ = 切换当前编辑的图（会关掉本弹窗）
 */
export function PicturePickerDialog({
  open,
  onClose,
  available,
  currentId,
  queuedIds,
  showPosition,
  positionById,
  onToggleQueued,
  onSetQueued,
  onSelectCurrent,
}: PicturePickerDialogProps) {
  // 候选 = 画布全部图片 − 当前图（当前图已经在选择条里恒显示，不用再选一次）。
  const selectable = useMemo(
    () => available.filter((item) => item.id !== currentId),
    [available, currentId]
  );

  const selectedIds = useMemo(
    () => selectable.filter((item) => queuedIds.has(item.id)).map((item) => item.id),
    [selectable, queuedIds]
  );
  const selectedCount = selectedIds.length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="nowheel fixed inset-0 z-[200] flex items-center justify-center"
      onWheel={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="关闭图片选择"
        onClick={onClose}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="选择要批量套用的图片"
        className="relative flex h-[min(80vh,880px)] w-[min(1200px,calc(100vw-80px))] flex-col overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-[var(--ui-surface-panel)] shadow-[var(--ui-shadow-panel)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[rgba(255,255,255,0.1)] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-dark">选择要批量套用的图片</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
              点图片即可加入 / 移出批量队列，点左上角 ⇄ 切换当前编辑的图 · 已加入{' '}
              {selectedCount} 张
              {selectable.length > 0 ? `（画布共 ${selectable.length} 张可选）` : ''}
              <br />
              角标是它在选择条里的<b className="text-text-dark">位置</b> —— 文字里的{' '}
              <code className="rounded bg-white/[0.08] px-1">{'{n}'}</code>{' '}
              编号读的就是这个数，拖动条即可重排。
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={selectable.length === 0}
              onClick={() => onSetQueued(allSelected ? [] : selectable.map((item) => item.id))}
              className="whitespace-nowrap rounded-lg border border-[rgba(255,255,255,0.16)] px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent/40 hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {allSelected ? '全部移除' : '全部加入'}
            </button>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-dark"
              aria-label="关闭图片选择"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {selectable.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              画布上没有其它图片
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {selectable.map((item) => {
                const checked = queuedIds.has(item.id);
                const position = positionById.get(item.id);
                return (
                  <div
                    key={item.id}
                    title={item.label}
                    // 勾选态用「粗 accent 边框 + 底色 + 打勾」三重表达 —— 光靠一个
                    // 小圆点在一屏几十张里根本看不出哪张被选中了。
                    // border-2 两边都写，避免勾选时整块跳 1px。
                    className={`group relative overflow-hidden rounded-xl border-2 transition-colors ${
                      checked
                        ? 'border-accent bg-accent/15'
                        : 'border-[rgba(255,255,255,0.14)] hover:border-accent/40'
                    }`}
                  >
                    {/* 主点击区 = 整张卡片，加入 / 移出批量队列 */}
                    <button
                      type="button"
                      aria-pressed={checked}
                      aria-label={`${checked ? '移出' : '加入'}批量队列：${item.label}`}
                      onClick={() => onToggleQueued(item.id)}
                      className="block w-full text-left"
                    >
                      <div className="relative h-[132px] w-full bg-black/40">
                        <img
                          src={resolveImageDisplayUrl(item.imageUrl)}
                          alt={item.label}
                          draggable={false}
                          loading="lazy"
                          className="h-full w-full object-contain"
                        />
                        {showPosition && typeof position === 'number' && (
                          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-white">
                            {position + 1}
                          </span>
                        )}
                        <span
                          className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow-sm transition-colors ${
                            checked
                              ? 'border-white/80 bg-accent text-white'
                              : 'border-[rgba(255,255,255,0.5)] bg-black/60 text-transparent'
                          }`}
                        >
                          <Check className="h-4 w-4" />
                        </span>
                      </div>
                      <div
                        className={`truncate px-2.5 py-2 text-xs ${
                          checked ? 'font-medium text-text-dark' : 'text-text-muted'
                        }`}
                      >
                        {item.label}
                      </div>
                    </button>

                    {/* 次要操作：切换当前编辑的图（和"加入队列"是两件事，所以单独一个按钮）。
                        只放图标 —— 每张卡片都挂一个「切换」文字标签会非常吵。 */}
                    <button
                      type="button"
                      title="切换到这个图片（改用它作为当前编辑图）"
                      aria-label={`切换到 ${item.label}`}
                      onClick={() => onSelectCurrent(item.id)}
                      className="absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(255,255,255,0.28)] bg-black/60 text-white/75 transition-colors hover:border-accent/70 hover:text-white"
                    >
                      <Repeat2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[rgba(255,255,255,0.1)] px-5 py-3">
          <span className="text-xs text-text-muted/80">
            当前图不参与批量套用，它用面板底部的「应用」按钮
          </span>
          <UiButton size="sm" variant="primary" onClick={onClose}>
            完成{selectedCount > 0 ? `（已加入 ${selectedCount} 张）` : ''}
          </UiButton>
        </div>
      </section>
    </div>,
    document.body
  );
}
