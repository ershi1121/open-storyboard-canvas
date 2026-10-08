import { useCallback, useEffect, useRef, useState } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { IslandHostContext, NodeHostIdContext } from '@/features/canvas/compat/nodeHostApi';
import { getCanvasElement } from '@/features/canvas/compat/engineBridge';
import { nodeTypes } from '@/features/canvas/nodes';
import type { Canvas2DEngine } from './engine';
import { selectDomIslands, type IslandViewport } from './domIslands';
import type { RenderNode, SceneModel } from './sceneModel';

/**
 * DOM 岛层（混合渲染）：放大到阈值后，视口内的节点用【原版节点编辑组件】
 * 以 DOM 覆盖层形式渲染在画布上（可直接输入/点击生成/拖连接桩），
 * 缩小或超出上限时回退为画布卡片，保住全览性能。
 *
 * 实现要点：
 * - 单层 world 容器跟随相机 transform（平移/缩放每帧仅一次 DOM 写入）；
 * - 岛内指针事件按 nodrag 约定路由：控件区走组件，其余转发引擎手势；
 * - 拖拽期间岛跟随：rAF 读取引擎实时偏移直写 wrapper transform；
 * - ResizeObserver 把组件真实尺寸回写 store（与画布卡片尺寸保持同步）；
 * - 滚轮经 nowheel 约定转发引擎缩放。
 */

interface DomIslandsProps {
  engineRef: { current: Canvas2DEngine | null };
  model: SceneModel | null;
  selectedIds: string[];
  onIslandsChange: (ids: ReadonlySet<string>) => void;
}

export function DomIslands({ engineRef, model, selectedIds, onIslandsChange }: DomIslandsProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const wrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const lastKeyRef = useRef('');
  const [islandIds, setIslandIds] = useState<string[]>([]);

  const selectedSet = useRef(new Set<string>());
  selectedSet.current = new Set(selectedIds);

  /* ---------- world 容器跟随相机 ---------- */
  const applyWorldTransform = useCallback(() => {
    const engine = engineRef.current;
    const el = worldRef.current;
    if (!engine || !el) return;
    const vp = engine.getViewport();
    el.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  }, [engineRef]);

  /* ---------- 岛集合重算 ---------- */
  const recompute = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !model) {
      if (lastKeyRef.current !== '') {
        lastKeyRef.current = '';
        setIslandIds([]);
      }
      return;
    }
    const vp = engine.getViewport();
    const size = engine.getViewSize();
    const viewport: IslandViewport = {
      camX: -vp.x / vp.zoom,
      camY: -vp.y / vp.zoom,
      zoom: vp.zoom,
      viewW: size.w,
      viewH: size.h,
    };
    const ids = selectDomIslands(model.nodes, selectedSet.current, viewport);
    const key = ids.join('|');
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setIslandIds(ids);
    }
  }, [engineRef, model]);

  useEffect(() => {
    applyWorldTransform();
    recompute();
    const engine = engineRef.current;
    if (!engine) return;
    const unsubCam = engine.addCameraListener(() => {
      applyWorldTransform();
      recompute();
    });
    return unsubCam;
  }, [applyWorldTransform, recompute, engineRef]);

  useEffect(() => {
    const set = new Set(islandIds);
    engineRef.current?.setDomIslands(set);
    onIslandsChange(set);
  }, [islandIds, engineRef, onIslandsChange]);

  /* ---------- 拖拽期间岛跟随（rAF 直写 transform） ---------- */
  const modelRef = useRef<SceneModel | null>(null);
  modelRef.current = model;
  const appliedBaseRef = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const off = engineRef.current?.getDragOffset() ?? null;
      for (const [id, el] of wrapperRefs.current) {
        if (off && off.ids.has(id)) {
          const rn = modelRef.current?.byId.get(id);
          if (!appliedBaseRef.current.has(id) && rn) {
            appliedBaseRef.current.set(id, { x: rn.x, y: rn.y });
          }
          el.style.transform = `translate(${off.dx}px, ${off.dy}px)`;
        } else if (el.style.transform) {
          // 等 store 提交新坐标（model 基准变化）后再清除偏移，避免回跳一帧
          const base = appliedBaseRef.current.get(id);
          const rn = modelRef.current?.byId.get(id);
          if (!base || !rn || rn.x !== base.x || rn.y !== base.y) {
            el.style.transform = '';
            appliedBaseRef.current.delete(id);
          }
        }
      }
      if (!off && appliedBaseRef.current.size > 0) {
        // 手势结束后清理无主记录
        for (const id of [...appliedBaseRef.current.keys()]) {
          if (!wrapperRefs.current.has(id)) appliedBaseRef.current.delete(id);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engineRef]);

  /* ---------- 滚轮转发（nowheel 区域交给组件） ---------- */
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.nowheel')) return;
      const canvas = getCanvasElement();
      if (!canvas) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      engineRef.current?.wheel(event.clientX - rect.left, event.clientY - rect.top, event.deltaY);
    };
    layer.addEventListener('wheel', onWheel, { passive: false });
    return () => layer.removeEventListener('wheel', onWheel);
  }, [engineRef]);

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) wrapperRefs.current.set(id, el);
    else wrapperRefs.current.delete(id);
  }, []);

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        ref={worldRef}
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', willChange: 'transform' }}
      >
        {islandIds.map((id) => {
          const rendered = model?.byId.get(id);
          if (!rendered) return null;
          return (
            <IslandNode
              key={id}
              rendered={rendered}
              selected={selectedSet.current.has(id)}
              engineRef={engineRef}
              registerRef={registerRef}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 单个 DOM 岛 ---------------- */

interface IslandNodeProps {
  rendered: RenderNode;
  selected: boolean;
  engineRef: { current: Canvas2DEngine | null };
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

function IslandNode({ rendered, selected, engineRef, registerRef }: IslandNodeProps) {
  const node = useCanvasStore((state) => state.nodes.find((n) => n.id === rendered.id));
  const innerRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);
  const forwardingRef = useRef(false);

  /* 组件真实尺寸回写 store（与画布卡片尺寸同步） */
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width < 8 || height < 8) return;
      const last = lastSizeRef.current;
      if (last && Math.abs(last.w - width) < 2 && Math.abs(last.h - height) < 2) return;
      lastSizeRef.current = { w: width, h: height };
      // 直接写 store（等同旧版引擎内部 measured 语义），不产生撤销历史条目
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === rendered.id
            ? { ...n, width, height, measured: { width, height } }
            : n,
        ),
      }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rendered.id]);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const canvas = getCanvasElement();
    const rect = canvas?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      // 控件区（nodrag）交给组件自身处理
      if (target?.closest('.nodrag')) return;
      const engine = engineRef.current;
      if (!engine) return;
      event.preventDefault();
      const local = toLocal(event.clientX, event.clientY);
      engine.pointerDown(local.x, local.y, {
        button: event.button,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
      forwardingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [engineRef, toLocal],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!forwardingRef.current) return;
      const local = toLocal(event.clientX, event.clientY);
      engineRef.current?.pointerMove(local.x, local.y, { altKey: event.altKey });
    },
    [engineRef, toLocal],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!forwardingRef.current) return;
      forwardingRef.current = false;
      const local = toLocal(event.clientX, event.clientY);
      engineRef.current?.pointerUp(local.x, local.y);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [engineRef, toLocal],
  );

  if (!node || !node.type) return null;
  const Comp = nodeTypes[node.type];
  if (!Comp) return null;

  const updateNodeData = (update: unknown) => {
    const current = useCanvasStore.getState().nodes.find((n) => n.id === rendered.id);
    const next =
      typeof update === 'function' ? (update as (data: unknown) => unknown)(current?.data ?? {}) : update;
    useCanvasStore.getState().updateNodeData(rendered.id, next as Partial<CanvasNodeData>);
  };

  return (
    <div
      ref={(el) => registerRef(rendered.id, el)}
      className="pointer-events-auto absolute"
      style={{
        left: rendered.x,
        top: rendered.y,
        width: rendered.w,
        minHeight: rendered.h,
        boxShadow: selected ? '0 0 0 2px #38bdf8' : undefined,
        borderRadius: 10,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      <IslandHostContext.Provider value={true}>
        <NodeHostIdContext.Provider value={rendered.id}>
          <div ref={innerRef} style={{ width: rendered.w }}>
            <Comp
              id={node.id}
              data={node.data}
              type={node.type}
              selected={selected}
              dragging={false}
              isConnectable={true}
              zIndex={node.zIndex ?? 0}
              width={node.measured?.width ?? node.width ?? rendered.w}
              height={node.measured?.height ?? node.height ?? rendered.h}
              positionAbsoluteX={rendered.x}
              positionAbsoluteY={rendered.y}
              parentId={node.parentId}
              updateNodeData={updateNodeData}
              sourcePosition={'right' as const}
              targetPosition={'left' as const}
            />
          </div>
        </NodeHostIdContext.Provider>
      </IslandHostContext.Provider>
    </div>
  );
}
