import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Copy, ImagePlus, Trash2 } from 'lucide-react';
import type { NodeContextMenuState } from '../types';

interface ContextMenuProps {
  state: NodeContextMenuState | null;
  onCopySelectedText: () => void;
  onCreateImageFromText: () => void;
  onCopyNode: () => void;
  onPaste: () => void;
  onDeleteNode: () => void;
}

export const ContextMenu = memo(function ContextMenu({
  state,
  onCopySelectedText,
  onCreateImageFromText,
  onCopyNode,
  onPaste,
  onDeleteNode,
}: ContextMenuProps) {
  const { t } = useTranslation();
  if (!state) {
    return null;
  }
  return (
    <div
      data-canvas-no-marquee="true"
      className="absolute z-[12030] min-w-32 overflow-hidden rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] py-1 text-sm text-text-dark shadow-2xl"
      style={{ left: state.position.x, top: state.position.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {state.selectedText && (
        <>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopySelectedText();
            }}
          >
            <Copy className="h-4 w-4" />
            {t('nodeToolbar.copyText')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCreateImageFromText();
            }}
          >
            <ImagePlus className="h-4 w-4" />
            {t('nodeToolbar.generateImage')}
          </button>
          <div className="my-1 h-px bg-[var(--canvas-node-border)]" />
        </>
      )}
      {state.nodeId && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCopyNode();
          }}
        >
          <Copy className="h-4 w-4" />
          {t('nodeToolbar.copyNode')}
        </button>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPaste();
        }}
      >
        <ClipboardPaste className="h-4 w-4" />
        {t('nodeToolbar.paste')}
      </button>
      {state.nodeId && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDeleteNode();
          }}
        >
          <Trash2 className="h-4 w-4" />
          {t('common.delete')}
        </button>
      )}
    </div>
  );
});