import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Copy, Group, Play, Trash2, Ungroup } from 'lucide-react';
import { TidyMenu, type ArrangeSort } from './TidyMenu';

interface BatchToolbarProps {
  position: { left: number; top: number } | null;
  selectedCount: number;
  canGroup: boolean;
  canUngroup: boolean;
  canTrigger: boolean;
  onArrange: (sortBy: ArrangeSort) => void;
  onTidyAndGroup: (sortBy: ArrangeSort) => void;
  onCopy: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onTrigger: () => void;
  onDelete: () => void;
}

export const BatchToolbar = memo(function BatchToolbar({
  position,
  selectedCount,
  canGroup,
  canUngroup,
  canTrigger,
  onArrange,
  onTidyAndGroup,
  onCopy,
  onGroup,
  onUngroup,
  onTrigger,
  onDelete,
}: BatchToolbarProps) {
  const { t } = useTranslation();
  if (!position) {
    return null;
  }
  return (
    <div
      data-canvas-no-marquee="true"
      className="absolute z-[12020] flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] px-2 py-1.5 text-xs text-text-dark shadow-2xl"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <span className="mr-1 flex items-center gap-1 whitespace-nowrap px-1 text-text-muted">
        <Boxes className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.selectedCount', { count: selectedCount })}
      </span>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
        onClick={onCopy}
        title={t('canvas.batchToolbar.copy')}
      >
        <Copy className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.copy')}
      </button>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canGroup}
        onClick={onGroup}
        title={t('canvas.batchToolbar.group')}
      >
        <Group className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.group')}
      </button>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canUngroup}
        onClick={onUngroup}
        title={t('canvas.batchToolbar.ungroup')}
      >
        <Ungroup className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.ungroup')}
      </button>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canTrigger}
        onClick={onTrigger}
        title={t('canvas.batchToolbar.trigger')}
      >
        <Play className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.trigger')}
      </button>
      <TidyMenu
        label="整理"
        onPick={onArrange}
        onTidyAndGroup={onTidyAndGroup}
        triggerClassName="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
        menuClassName="absolute left-1/2 top-full z-[13000] mt-1 -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] py-1 text-xs text-text-dark shadow-xl"
        itemClassName="block w-full whitespace-nowrap px-3 py-1.5 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
      />
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
        onClick={onDelete}
        title={t('canvas.batchToolbar.delete')}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('canvas.batchToolbar.delete')}
      </button>
    </div>
  );
});