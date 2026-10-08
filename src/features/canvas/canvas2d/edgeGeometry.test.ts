import { describe, expect, it } from 'vitest';

import {
  distToPolyline,
  polylineMidpoint,
  sampleOrthogonal,
  sampleSpline,
} from './edgeGeometry';

describe('sampleSpline', () => {
  it('首尾等于端点', () => {
    const pts = sampleSpline(0, 0, 300, 100);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 100 });
  });
  it('采样点连续（无跳变）', () => {
    const pts = sampleSpline(0, 0, 400, 200);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThan(60);
    }
  });
});

describe('sampleOrthogonal', () => {
  it('无避让矩形时为六段折线圆角采样，首尾为端点', () => {
    const pts = sampleOrthogonal(0, 0, 'right', 300, 120, 'left', []);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 120 });
    expect(pts.length).toBeGreaterThan(6);
  });
  it('避让矩形把 lane 推离障碍', () => {
    const blocker = { id: 'b', left: 100, top: 40, right: 200, bottom: 80 };
    const pts = sampleOrthogonal(0, 60, 'right', 300, 60, 'left', [blocker]);
    // 水平中线被挡：lane 必须离开 [40,80]
    const laneYs = pts.map((p) => p.y);
    const inBand = laneYs.filter((y) => y > 40 && y < 80);
    // 起终点本身在带内是允许的，但中间 lane 段应避开
    const midPts = pts.slice(2, -2);
    for (const p of midPts) {
      const inside = p.y > 40 && p.y < 80 && p.x > 100 && p.x < 200;
      expect(inside).toBe(false);
    }
    expect(inBand.length).toBeLessThanOrEqual(pts.length);
  });
});

describe('distToPolyline / polylineMidpoint', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  it('线上点距离为 0，线外点距离正确', () => {
    expect(distToPolyline(50, 0, line)).toBe(0);
    expect(distToPolyline(50, 8, line)).toBe(8);
    expect(distToPolyline(-10, 0, line)).toBe(10);
  });
  it('中点为半程位置', () => {
    expect(polylineMidpoint(line)).toEqual({ x: 50, y: 0 });
    const l2 = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    // 弧长中点 = 拐角（两段各 100）
    expect(polylineMidpoint(l2)).toEqual({ x: 100, y: 0 });
  });
});
