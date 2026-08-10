import { ViewportPortal } from '@xyflow/react';
import type { SnapGuide } from './useCanvasSnapFollow';

export function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      {guides.map((g) =>
        g.orientation === 'vertical' ? (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50 w-px bg-fuchsia-500"
            style={{ left: g.position, top: -100000, height: 200000 }}
          />
        ) : (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50 h-px bg-fuchsia-500"
            style={{ top: g.position, left: -100000, width: 200000 }}
          />
        )
      )}
    </ViewportPortal>
  );
}