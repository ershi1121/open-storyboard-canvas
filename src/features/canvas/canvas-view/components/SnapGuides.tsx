import { ViewportPortal, useViewport } from '@xyflow/react';
import type { SnapGuide } from '../hooks/useCanvasSnapFollow';

/** 吸附参考线：用 zoom 补偿线宽，任何缩放下屏幕恒定 1px 细线 */
export function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  const { zoom } = useViewport();
  const thickness = Math.max(0.5, 1 / zoom);
  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      {guides.map((g) =>
        g.orientation === 'vertical' ? (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50 bg-fuchsia-500/80"
            style={{ left: g.position, top: -100000, width: thickness, height: 200000 }}
          />
        ) : (
          <div
            key={g.id}
            className="pointer-events-none absolute z-50 bg-fuchsia-500/80"
            style={{ top: g.position, left: -100000, height: thickness, width: 200000 }}
          />
        )
      )}
    </ViewportPortal>
  );
}