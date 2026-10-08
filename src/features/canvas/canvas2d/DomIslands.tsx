import { Component, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { IslandHostContext, NodeHostIdContext } from '@/features/canvas/compat/nodeHostApi';
import {
  emitIslandVisibilityChange,
  getCanvasElement,
  registerIslandMountedChecker,
  registerIslandVisibilityChecker,
} from '@/features/canvas/compat/engineBridge';
import { nodeTypes } from '@/features/canvas/nodes';
import { withNodeRenderErrorBoundary } from '@/features/canvas/nodes/NodeRenderErrorBoundary';
import type { Canvas2DEngine } from './engine';
import { prefetchImage } from './imageCache';
import { selectDomIslands, type IslandViewport } from './domIslands';

/** 每帧放行的新挂载岛显示数量（摊薄重绘成本） */
const RESUME_BATCH_PER_FRAME = 8;
/** 相机静止多久后降级合成层、强制清晰重栅（毫秒） */
const RASTER_SETTLE_MS = 180;
/** 相机静止多久后结算岛成员变化（毫秒） */
const MEMBER_SETTLE_MS = 250;
/** 相机运动判定窗口（毫秒）：窗口内岛隐藏由卡片接管 */
const CAMERA_MOVING_MS = 200;
/** 显示门槛（屏幕像素）：挂载集合内达到该尺寸才显示为活编辑器 */
const SHOW_GATE_W = 140;
const SHOW_GATE_H = 40;
/** 拖拽快速路径阈值：同时移动的岛达到该数量时运动期降级为画布卡片 */
const DRAG_SIMPLIFY_MIN = 4;
/** 预挂载上限（含隐藏岛）：隐藏岛零绘制成本，仅占内存 */
const MOUNT_CAP = 120;
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

/* 按组件类型缓存错误边界包装，避免每次渲染生成新组件类型导致重挂载 */
const safeComponentCache = new WeakMap<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React.ComponentType<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React.ComponentType<any>
>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeComponent<T extends React.ComponentType<any>>(Comp: T): React.ComponentType<any> {
  let wrapped = safeComponentCache.get(Comp);
  if (!wrapped) {
    wrapped = withNodeRenderErrorBoundary(Comp);
    safeComponentCache.set(Comp, wrapped);
  }
  return wrapped;
}

/** 岛层整体兜底边界：任何未预料异常回退为纯画布卡片，绝不拖累主界面 */
class DomIslandsBoundary extends Component<
  { children: ReactNode; onFallback?: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }
  componentDidCatch(error: Error): void {
    console.error('[DomIslands] 岛层渲染异常，已回退为画布卡片+检视面板模式', error);
    this.props.onFallback?.();
  }
  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

interface DomIslandsProps {
  engineRef: { current: Canvas2DEngine | null };
  model: SceneModel | null;
  selectedIds: string[];
  onIslandsChange: (ids: ReadonlySet<string>) => void;
  /** 岛层整体异常回退时通知宿主（启用检视面板兜底） */
  onFallback?: () => void;
}

const DomIslandsInner = memo(function DomIslandsInner({
  engineRef,
  model,
  selectedIds,
  onIslandsChange,
}: DomIslandsProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const wrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const lastKeyRef = useRef('');
  const lastMemberLogRef = useRef(0);
  const lastCameraMoveRef = useRef(0);
  const rasterSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memberSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [islandIds, setIslandIds] = useState<string[]>([]);

  const selectedSet = useRef(new Set<string>());
  selectedSet.current = new Set(selectedIds);

  const islandSetRef = useRef<ReadonlySet<string>>(new Set<string>());
  /** 当前实际可见（display:''）的岛集合，与 engine.domIslands 严格同步 */
  const shownSetRef = useRef<Set<string>>(new Set<string>());
  /** 目标岛有序列表（选中优先、距离排序）与集合镜像 */
  const targetOrderRef = useRef<string[]>([]);
  /** 待空闲挂载队列（有序） */
  const pendingAddRef = useRef<string[]>([]);
  /** 待空闲卸载队列 */
  const pendingRemoveRef = useRef<string[]>([]);
  const pendingRemoveSetRef = useRef<Set<string>>(new Set<string>());
  /** 已挂载（React 状态）镜像 */
  const mountedSetRef = useRef<Set<string>>(new Set<string>());

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
    const ids = selectDomIslands(model.nodes, selectedSet.current, viewport, {
      minScreenW: 0,
      minScreenH: 0,
      cap: MOUNT_CAP,
    });
    targetOrderRef.current = ids;
    const key = ids.join('|');
    if (key === lastKeyRef.current) return;
    const prevSet = islandSetRef.current;
    const added = ids.filter((id) => !prevSet.has(id)).length;
    const removed = [...prevSet].filter((id) => !key.split('|').includes(id)).length;
    const now = Date.now();
    if (added + removed > 0 && now - lastMemberLogRef.current > 1000) {
      lastMemberLogRef.current = now;
      console.warn(`[canvas2d] 岛成员变化 +${added}/-${removed}（总计 ${ids.length}）`);
    }
    lastKeyRef.current = key;
    // 成员变化只更新目标；挂载由空闲回调调度、卸载由 rAF 分批
    islandSetRef.current = new Set(ids);
    const targetSet = new Set(ids);
    pendingAddRef.current = ids.filter((id) => !mountedSetRef.current.has(id));
    pendingRemoveRef.current = [...mountedSetRef.current].filter((id) => !targetSet.has(id));
    pendingRemoveSetRef.current = new Set(pendingRemoveRef.current);
  }, [engineRef, model]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;


  useEffect(() => {
    mountedSetRef.current = new Set(islandIds);
    onIslandsChange(new Set(islandIds));
  }, [islandIds, onIslandsChange]);

  useEffect(() => {
    registerIslandVisibilityChecker((id) => shownSetRef.current.has(id));
    registerIslandMountedChecker((id) => mountedSetRef.current.has(id));
    return () => {
      registerIslandVisibilityChecker(null);
      registerIslandMountedChecker(null);
    };
  }, []);

  useEffect(() => {
    // 引擎由父组件 effect 创建（晚于子组件 effect），需等待其就绪后再注册监听
    let unsub: (() => void) | null = null;
    let cancelled = false;
    let raf = 0;
    const attach = () => {
      const engine = engineRef.current;
      if (!engine) {
        if (!cancelled) raf = requestAnimationFrame(attach);
        return;
      }
      applyWorldTransform();
      recompute();
      unsub = engine.addCameraListener(() => {
        lastCameraMoveRef.current = performance.now();
        // 运动期间冻结成员变化（避免门槛线上每帧挂载/卸载重型组件）；
        // 静止 MEMBER_SETTLE_MS 后统一结算（分批挂载/卸载）
        if (memberSettleTimerRef.current) clearTimeout(memberSettleTimerRef.current);
        memberSettleTimerRef.current = setTimeout(() => {
          memberSettleTimerRef.current = null;
          recomputeRef.current();
        }, MEMBER_SETTLE_MS);
        // 运动中：提升合成层（transform 拉伸顺滑）；静止后降级强制按新缩放
        // 重新光栅化——否则 will-change 常驻会让放大后的 DOM 岛持续模糊
        const world = worldRef.current;
        if (world && world.style.willChange !== 'transform') world.style.willChange = 'transform';
        if (rasterSettleTimerRef.current) clearTimeout(rasterSettleTimerRef.current);
        rasterSettleTimerRef.current = setTimeout(() => {
          rasterSettleTimerRef.current = null;
          const w = worldRef.current;
          if (w) w.style.willChange = 'auto';
        }, RASTER_SETTLE_MS);
        applyWorldTransform();
      });
    };
    attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (rasterSettleTimerRef.current) clearTimeout(rasterSettleTimerRef.current);
      if (memberSettleTimerRef.current) clearTimeout(memberSettleTimerRef.current);
      unsub?.();
    };
  }, [applyWorldTransform, recompute, engineRef]);


  /* ---------- 拖拽期间岛跟随（rAF 直写 transform） ---------- */
  const modelRef = useRef<SceneModel | null>(null);
  modelRef.current = model;
  const appliedBaseRef = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const engine = engineRef.current;
      const off = engine?.getDragOffset() ?? null;
      /* 拖拽快速路径：同时移动 ≥4 个岛时，运动期交给画布卡片渲染
         （DOM 子树逐帧重绘是拖拽卡顿主源）；松手即恢复完整组件 */
      const simplify = off && off.ids.size >= DRAG_SIMPLIFY_MIN ? off.ids : null;

      /* ---- 岛可见性：新挂载分批显示（防瞬时重绘尖峰） ---- */
      if (engine) {
        // 单一样式原则：整个缩放手势中每个节点保持同一样式
        // （编辑器保持编辑器、卡片保持卡片，随容器 transform 平滑缩放）；
        // 表示形式的升级/降级只发生在静止 250ms 后跨过可读门槛时，
        // 且卡片已是等比微缩复刻，观感连续
        const mountSet = islandSetRef.current;
        const zoom = engine.getViewport().zoom;
        const passesGate = (id: string): boolean => {
          const rn = modelRef.current?.byId.get(id);
          if (!rn) return false;
          return rn.w * zoom >= SHOW_GATE_W && rn.h * zoom >= SHOW_GATE_H;
        };
        const desired = new Set<string>();
        for (const id of mountSet) {
          if (!wrapperRefs.current.has(id)) continue;
          if (pendingRemoveSetRef.current.has(id)) continue;
          if (passesGate(id) || selectedSet.current.has(id)) desired.add(id);
        }
        const shown = shownSetRef.current;
        let changed = false;
        // 清理已卸载岛残留（否则画布会持续跳过其卡片导致节点不可见）
        for (const id of [...shown]) {
          if (!wrapperRefs.current.has(id)) {
            shown.delete(id);
            changed = true;
          }
        }
        let budget = RESUME_BATCH_PER_FRAME;
        for (const [id, el] of wrapperRefs.current) {
          const want = desired.has(id) && !(simplify !== null && simplify.has(id));
          const isShown = shown.has(id);
          if (want && !isShown && budget > 0) {
            el.style.display = '';
            shown.add(id);
            budget--;
            changed = true;
          } else if (!want && isShown) {
            el.style.display = 'none';
            shown.delete(id);
            changed = true;
          }
        }
        if (changed) {
          engine.setDomIslands(new Set(shown));
          emitIslandVisibilityChange();
        }

        /* 挂载/卸载均由空闲回调调度（见 idle 循环），rAF 只管可见性 */
      }

      for (const [id, el] of wrapperRefs.current) {
        if (simplify !== null && simplify.has(id)) {
          // 画布卡片接管运动渲染：DOM 隐藏且不需要 transform
          continue;
        }
        if (off && off.ids.has(id)) {
          const rn = modelRef.current?.byId.get(id);
          if (!appliedBaseRef.current.has(id) && rn) {
            appliedBaseRef.current.set(id, { x: rn.x, y: rn.y });
          }
          // 合成层提升：移动交给 GPU 合成器，避免逐帧重绘 DOM 子树
          if (el.style.willChange !== 'transform') el.style.willChange = 'transform';
          el.style.transform = `translate(${off.dx}px, ${off.dy}px)`;
        } else if (el.style.transform) {
          // 等 store 提交新坐标（model 基准变化）后再清除偏移，避免回跳一帧
          const base = appliedBaseRef.current.get(id);
          const rn = modelRef.current?.byId.get(id);
          if (!base || !rn || rn.x !== base.x || rn.y !== base.y) {
            el.style.transform = '';
            el.style.willChange = '';
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

  /* ---------- 空闲时段挂载：主线程空闲才挂一个，交互永远优先 ---------- */
  useEffect(() => {
    let cancelled = false;
    let handle = 0;
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    const schedule = () => {
      if (cancelled) return;
      if (win.requestIdleCallback) {
        handle = win.requestIdleCallback(step, { timeout: 800 });
      } else {
        handle = window.setTimeout(step, 120);
      }
    };
    const step = () => {
      if (cancelled) return;
      const moving = performance.now() - lastCameraMoveRef.current < CAMERA_MOVING_MS;
      if (!moving) {
        if (pendingAddRef.current.length > 0) {
          const id = pendingAddRef.current.shift() as string;
          if (!mountedSetRef.current.has(id) && islandSetRef.current.has(id)) {
            // 预热画布图片缓存：平移/缩放切回卡片时立即有图，不再灰占位
            const rn = modelRef.current?.byId.get(id);
            prefetchImage(rn?.previewUrl ?? rn?.imageUrl);
            setIslandIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          }
        } else if (pendingRemoveRef.current.length > 0) {
          const id = pendingRemoveRef.current.shift() as string;
          pendingRemoveSetRef.current.delete(id);
          if (mountedSetRef.current.has(id) && !islandSetRef.current.has(id)) {
            setIslandIds((prev) => prev.filter((pid) => pid !== id));
          }
        }
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (win.cancelIdleCallback) win.cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, []);

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
        style={{ transformOrigin: '0 0' }}
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
});

/* ---------------- 单个 DOM 岛 ---------------- */

interface IslandNodeProps {
  rendered: RenderNode;
  selected: boolean;
  engineRef: { current: Canvas2DEngine | null };
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

const IslandNode = memo(function IslandNode({
  rendered,
  selected,
  engineRef,
  registerRef,
}: IslandNodeProps) {
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
  const SafeComp = safeComponent(Comp);

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
        display: 'none',
        // 布局/样式隔离：岛内变化不向外传播失效，降低主线程布局成本
        contain: 'layout style',
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
            <SafeComp
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
});

export function DomIslands({ onFallback, ...rest }: DomIslandsProps) {
  return (
    <DomIslandsBoundary onFallback={onFallback}>
      <DomIslandsInner {...rest} />
    </DomIslandsBoundary>
  );
}
