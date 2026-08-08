import { memo } from 'react';
import type { PreviewConnectionVisual } from '../types';

export const ConnectionPreview = memo(function ConnectionPreview({
  visual,
}: { visual: PreviewConnectionVisual | null }) {
  if (!visual) {
    return null;
  }
  return (
    <svg
      className="pointer-events-none absolute z-40 overflow-visible"
      style={{
        left: visual.left,
        top: visual.top,
        width: visual.width,
        height: visual.height,
      }}
      width={visual.width}
      height={visual.height}
    >
      <path
        className="pointer-events-none"
        d={visual.d}
        fill="none"
        stroke={visual.stroke}
        strokeWidth={visual.strokeWidth}
        strokeLinecap={visual.strokeLinecap}
      />
    </svg>
  );
});