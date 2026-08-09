import { ViewportPortal, useViewport } from '@xyflow/react';
import type { SnapGuide } from '../hooks/useCanvasSnapFollow';

export function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  const { zoom } = useViewport();
  const baseThickness = Math.max(0.5, 1 / zoom);
  
  if (guides.length === 0) return null;

  return (
    <ViewportPortal>
      {guides.map((g) => {
        const color = '#f0abfc';
        const thickness = baseThickness;
        const style = g.orientation === 'vertical'
          ? { left: g.position, top: -100000, width: thickness, height: 200000, backgroundColor: color }
          : { top: g.position, left: -100000, height: thickness, width: 200000, backgroundColor: color };

        return (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50 transition-all duration-75"
            style={style}
          />
        );
      })}
    </ViewportPortal>
  );
}