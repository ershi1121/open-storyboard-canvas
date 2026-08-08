import { memo } from 'react';
import type { CanvasMarqueeRect } from '../types';

interface SelectionOverlaysProps {
  marqueeRect: CanvasMarqueeRect | null;
  selectionBoundsRect: CanvasMarqueeRect | null;
}

export const SelectionOverlays = memo(function SelectionOverlays({
  marqueeRect,
  selectionBoundsRect,
}: SelectionOverlaysProps) {
  return (
    <>
      {marqueeRect && (
        <div
          className="pointer-events-none absolute z-[12000] rounded border border-accent/80 bg-accent/15 shadow-[0_0_0_1px_rgba(255,255,255,0.16)_inset]"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}
      {!marqueeRect && selectionBoundsRect && (
        <div
          className="pointer-events-none absolute z-[11990] rounded border border-accent/80 bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.14)_inset]"
          style={{
            left: selectionBoundsRect.left,
            top: selectionBoundsRect.top,
            width: selectionBoundsRect.width,
            height: selectionBoundsRect.height,
          }}
        />
      )}
    </>
  );
});