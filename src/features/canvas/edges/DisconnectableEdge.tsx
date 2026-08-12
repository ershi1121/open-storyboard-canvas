import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';

const EMPTY_ROUTE_NODES: CanvasNode[] = [];

type EdgeFlowState = 'idle' | 'processing' | 'failed';

/* ✨ 拧麻花缆线参数：三股排成一排绕轴旋转 → 一粗一细 */
const STRANDS = 3;
const TWIST_WAVELENGTH = 180;  // 每 120px 拧一整圈
const ROPE_RADIUS = 0.8;      // 股心绕轴半径（px）
const STRAND_HALF_W = 1.4;    // 股最大半宽：最粗≈3px，最细≈1.6px
const SAMPLE_STEP = 5;
const MIN_SAMPLES = 32;
const MAX_SAMPLES = 260;

/* ✨ 流水色彩：gradient stops 沿线分布并流动；亮度叠加旋转深度 */
const GRAD_STOPS = [0, 0.25, 0.5, 0.75, 1];
const STRAND_HUE_OFF = [-22, 0, 22];

/* ✨ 调色板 */
type Palette = {
  hueCenter: number; hueSpan: number; waves: number;
  colorSpeed: number; flowSpeed: number;
  sat: number; lightDark: number; lightLight: number;
};
const PALETTE_IDLE: Palette = {
  hueCenter: 205, hueSpan: 55, waves: 2,
  colorSpeed: 0.5, flowSpeed: 130,
  sat: 100, lightDark: 66, lightLight: 45,
};
const PALETTE_PROCESSING: Palette = {
  hueCenter: 160, hueSpan: 65, waves: 3,
  colorSpeed: 1, flowSpeed: 200,
  sat: 85, lightDark: 62, lightLight: 42,
};
const PALETTE_FAILED: Palette = {
  hueCenter: 335, hueSpan: 75, waves: 1.3,
  colorSpeed: 0.22, flowSpeed: 90,
  sat: 95, lightDark: 62, lightLight: 48,
};

const TWO_PI = Math.PI * 2;
const norm360 = (h: number) => ((h % 360) + 360) % 360;
const clampLight = (l: number) => Math.max(20, Math.min(85, l));

function resolveNodeWidth(node: CanvasNode): number | string {
  const width = node.measured?.width ?? (node as any).width ?? node.style?.width;
  return typeof width === 'number' || typeof width === 'string' ? width : '';
}

function resolveNodeHeight(node: CanvasNode): number | string {
  const height = node.measured?.height ?? (node as any).height ?? node.style?.height;
  return typeof height === 'number' || typeof height === 'string' ? height : '';
}

function buildNodeGeometrySignature(nodes: CanvasNode[]): string {
  return nodes
    .map((node) => [
      node.id,
      node.type,
      node.position.x,
      node.position.y,
      resolveNodeWidth(node),
      resolveNodeHeight(node),
    ].join(':'))
    .join('|');
}

export const DisconnectableEdge = memo(function DisconnectableEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    selected,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  } = props;

  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  const nodeGeometrySignature = useCanvasStore((state) =>
    canvasEdgeRoutingMode === 'smartOrthogonal' ? buildNodeGeometrySignature(state.nodes as CanvasNode[]) : ''
  );
  const routeNodes = useMemo(
    () => (canvasEdgeRoutingMode === 'smartOrthogonal' ? useCanvasStore.getState().nodes : EMPTY_ROUTE_NODES),
    [canvasEdgeRoutingMode, nodeGeometrySignature]
  );

  // 三态判定：沿用仓库原有业务规则
  const edgeFlowState = useCanvasStore((state) => {
    const sourceNode = state.nodes.find((node) => node.id === source);
    const targetNode = state.nodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode || targetNode.type !== CANVAS_NODE_TYPES.exportImage) {
      return 'idle' as EdgeFlowState;
    }
    const isSupportedSource =
      sourceNode.type === CANVAS_NODE_TYPES.storyboardGen ||
      sourceNode.type === CANVAS_NODE_TYPES.imageEdit;
    if (!isSupportedSource) {
      return 'idle' as EdgeFlowState;
    }
    const d = (targetNode.data ?? {}) as Record<string, any>;
    if (d.isGenerating === true) {
      return 'processing' as EdgeFlowState;
    }
    const genErr = d.generationError;
    if (
      (typeof genErr === 'string' && genErr.length > 0) ||
      (Array.isArray(genErr) && genErr.length > 0) ||
      Boolean(d.error)
    ) {
      return 'failed' as EdgeFlowState;
    }
    return 'idle' as EdgeFlowState;
  });

  const isProcessingEdge = edgeFlowState === 'processing';
  const isFailedEdge = edgeFlowState === 'failed';

  /* ✨ 触发规则：空闲仅选中 / 生成中加速 / 失败常显 / 完毕恢复原样 */
  const showFlow = isProcessingEdge || isFailedEdge || !!selected;

  const { edgePath, labelX, labelY } = useMemo(() => {
    if (canvasEdgeRoutingMode === 'spline') {
      const [path, nextLabelX, nextLabelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      return { edgePath: path, labelX: nextLabelX, labelY: nextLabelY };
    }
    const route = buildOrthogonalRoute({
      sourceId: source,
      targetId: target,
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Right,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Left,
      nodes: routeNodes as CanvasNode[],
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return { edgePath: route.path, labelX: route.labelX, labelY: route.labelY };
  }, [
    canvasEdgeRoutingMode,
    routeNodes,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  /* ✨ 缆线几何 + 流水色彩 refs */
  const samplePathRef = useRef<SVGPathElement | null>(null);
  const pipeRef = useRef<SVGPathElement | null>(null);
  const strandRefs = useRef<(SVGPathElement | null)[]>([]);
  const gradRefs = useRef<(SVGLinearGradientElement | null)[]>([]);
  const geomRef = useRef<{
    pts: { x: number; y: number; nx: number; ny: number; s: number; env: number; breathe: number }[];
    total: number;
  } | null>(null);
  const travelRef = useRef(0);
  const colorPhaseRef = useRef(0);
  const palRef = useRef<Palette>({ ...PALETTE_IDLE });
  const stateRef = useRef({ processing: false, failed: false });
  stateRef.current = { processing: isProcessingEdge, failed: isFailedEdge };

  // 路径变化时采样一次（含端点收束 + 自然呼吸包络）
  useLayoutEffect(() => {
    if (!showFlow) return;
    const el = samplePathRef.current;
    if (!el) return;
    const total = el.getTotalLength();
    if (!total) {
      geomRef.current = null;
      return;
    }
    const count = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(total / SAMPLE_STEP)));
    const pts: { x: number; y: number; nx: number; ny: number; s: number; env: number; breathe: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const s = u * total;
      const p = el.getPointAtLength(s);
      const pa = el.getPointAtLength(Math.max(0, s - 1.5));
      const pb = el.getPointAtLength(Math.min(total, s + 1.5));
      let tx = pb.x - pa.x;
      let ty = pb.y - pa.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const env = Math.min(1, Math.sin(Math.PI * u) * 1.8);          // 端点收束
      const breathe = 0.9 + 0.1 * Math.sin(s * 0.015 + 1.7);         // 振幅自然生长
      pts.push({ x: p.x, y: p.y, nx: -ty, ny: tx, s, env, breathe });
    }
    geomRef.current = { pts, total };
  }, [edgePath, showFlow]);

  // rAF：拧麻花几何 + 流水色彩
  useEffect(() => {
    if (!showFlow) return;

    const renderFrame = () => {
      const geom = geomRef.current;
      if (!geom || !geom.pts.length) return;
      const { pts, total } = geom;
      const cur = palRef.current;
      const isDark = document.documentElement.classList.contains('dark');
      const baseLight = isDark ? cur.lightDark : cur.lightLight;
      const travel = travelRef.current;
      const phase = colorPhaseRef.current;

      for (let k = 0; k < STRANDS; k++) {
        const strandPhase = (k / STRANDS) * TWO_PI;

        // ✨ 流水色彩 + 深度调亮：近侧亮、远侧暗
        const grad = gradRefs.current[k];
        if (grad) {
          const stops = grad.children;
          for (let j = 0; j < stops.length && j < GRAD_STOPS.length; j++) {
            const u = GRAD_STOPS[j];
            const s = u * total;
            const theta = ((s - travel) / TWIST_WAVELENGTH) * TWO_PI + strandPhase;
            const depth = Math.cos(theta); // -1 远侧 .. +1 近侧
            const hue = norm360(
              cur.hueCenter + STRAND_HUE_OFF[k] + cur.hueSpan * Math.sin(TWO_PI * (u * cur.waves - phase)),
            );
            const light = clampLight(baseLight + depth * 10);
            const alpha = 0.7 + 0.3 * ((depth + 1) / 2);
            (stops[j] as SVGStopElement).setAttribute(
              'stop-color',
              `hsla(${hue.toFixed(1)}, ${cur.sat.toFixed(0)}%, ${light.toFixed(0)}%, ${alpha.toFixed(2)})`,
            );
          }
        }

        const strand = strandRefs.current[k];
        if (!strand) continue;

        // ✨ 拧麻花丝带：偏移=sinθ，宽度/亮度=cosθ → 一粗一细旋转感
        const left: string[] = [];
        const right: string[] = [];
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const theta = ((p.s - travel) / TWIST_WAVELENGTH) * TWO_PI + strandPhase;
          const sinT = Math.sin(theta);
          const cosT = Math.cos(theta);
          const off = ROPE_RADIUS * sinT * p.env * p.breathe;
          const half = STRAND_HALF_W * (0.55 + 0.45 * ((cosT + 1) / 2)) * p.env;
          const cx = p.x + p.nx * off;
          const cy = p.y + p.ny * off;
          const lx = cx + p.nx * half;
          const ly = cy + p.ny * half;
          const rx = cx - p.nx * half;
          const ry = cy - p.ny * half;
          left.push(`${i === 0 ? 'M' : 'L'}${lx.toFixed(2)} ${ly.toFixed(2)}`);
          right.push(`L${rx.toFixed(2)} ${ry.toFixed(2)}`);
        }
        strand.setAttribute('d', left.join('') + right.reverse().join('') + 'Z');

        // 光晕颜色取中段
        const hueMid = norm360(
          cur.hueCenter + STRAND_HUE_OFF[k] + cur.hueSpan * Math.sin(TWO_PI * (0.5 * cur.waves - phase)),
        );
        strand.style.color = `hsl(${hueMid.toFixed(1)}, ${cur.sat.toFixed(0)}%, ${baseLight.toFixed(0)}%)`;
      }

      if (pipeRef.current) {
        const hueBase = norm360(cur.hueCenter + cur.hueSpan * Math.sin(TWO_PI * (0.5 * cur.waves - phase)));
        pipeRef.current.style.color = `hsl(${hueBase.toFixed(1)}, ${cur.sat.toFixed(0)}%, ${baseLight.toFixed(0)}%)`;
      }
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      renderFrame();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      const target = st.processing ? PALETTE_PROCESSING : st.failed ? PALETTE_FAILED : PALETTE_IDLE;
      const cur = palRef.current;
      const mix = 1 - Math.exp(-dt * 3);
      cur.hueCenter += (target.hueCenter - cur.hueCenter) * mix;
      cur.hueSpan += (target.hueSpan - cur.hueSpan) * mix;
      cur.waves += (target.waves - cur.waves) * mix;
      cur.colorSpeed += (target.colorSpeed - cur.colorSpeed) * mix;
      cur.flowSpeed += (target.flowSpeed - cur.flowSpeed) * mix;
      cur.sat += (target.sat - cur.sat) * mix;
      cur.lightDark += (target.lightDark - cur.lightDark) * mix;
      cur.lightLight += (target.lightLight - cur.lightLight) * mix;
      travelRef.current += dt * cur.flowSpeed;
      colorPhaseRef.current += dt * cur.colorSpeed;
      renderFrame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edgePath, showFlow]);

  const gradId = (k: number) => `flow-grad-${id}-${k}`;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: style?.stroke,
          strokeWidth: selected ? 2.4 : 1.9,
          ...style,
        }}
      />

      {/* ✨ 三股拧麻花能量缆 + 流水多色彩 */}
      {showFlow && (
        <g className="canvas-edge-flow">
          <defs>
            {[0, 1, 2].map((k) => (
              <linearGradient
                key={k}
                id={gradId(k)}
                ref={(el) => { gradRefs.current[k] = el; }}
                gradientUnits="userSpaceOnUse"
                x1={sourceX}
                y1={sourceY}
                x2={targetX}
                y2={targetY}
              >
                {GRAD_STOPS.map((u) => (
                  <stop key={u} offset={u} stopColor="hsla(200, 70%, 55%, 0.9)" />
                ))}
              </linearGradient>
            ))}
          </defs>
          <path ref={samplePathRef} d={edgePath} fill="none" stroke="none" />
          <path ref={pipeRef} d={edgePath} className="edge-flow-streak edge-flow-streak--pipe" />
          <path
            ref={(el) => { strandRefs.current[0] = el; }}
            className="edge-flow-streak edge-flow-streak--helix-a"
            fill={`url(#${gradId(0)})`}
          />
          <path
            ref={(el) => { strandRefs.current[1] = el; }}
            className="edge-flow-streak edge-flow-streak--helix-b"
            fill={`url(#${gradId(1)})`}
          />
          <path
            ref={(el) => { strandRefs.current[2] = el; }}
            className="edge-flow-streak edge-flow-streak--helix-c"
            fill={`url(#${gradId(2)})`}
          />
        </g>
      )}

      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan absolute flex h-6 w-6 items-center justify-center text-text-muted transition-colors hover:text-text-dark"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onClick={(event) => {
              event.stopPropagation();
              deleteEdge(id);
            }}
            aria-label="断开连线"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M2 12C2 6.477 6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12m7.707-3.707a1 1 0 0 0-1.414 1.414L10.586 12l-2.293 2.293a1 1 0 1 0 1.414 1.414L12 13.414l2.293-2.293a1 1 0 0 0-1.414-1.414L13.414 12l-2.293-2.293a1 1 0 0 0-1.414-1.414L12 10.586z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});