import { ViewportPortal, useViewport } from '@xyflow/react';
import type { SnapGuide } from '../hooks/useCanvasSnapFollow';

export function SnapGuides({ guides }: { guides: SnapGuide[] }) {
  const { zoom } = useViewport();
  const baseThickness = Math.max(0.5, 1 / zoom);
  
  if (guides.length === 0) return null;

  return (
    <ViewportPortal>
      {guides.map((g) => {
        const isSnapped = g.state === 'snapped';
        // 吸住时：洋红色，加粗，带发光阴影
        // 吸入中：天蓝色，正常粗细
        const color = isSnapped ? '#f0abfc' : '#38bdf8'; 
        const thickness = isSnapped ? baseThickness * 2.5 : baseThickness;
        const shadow = isSnapped ? `drop-shadow(0 0 4px ${color})` : 'none';

        const style = g.orientation === 'vertical' 
          ? { left: g.position, top: -100000, width: thickness, height: 200000, backgroundColor: color, filter: shadow }
          : { top: g.position, left: -100000, height: thickness, width: 200000, backgroundColor: color, filter: shadow };

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