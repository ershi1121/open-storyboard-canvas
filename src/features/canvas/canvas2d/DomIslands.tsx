import { Component, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { IslandHostContext, NodeHostIdContext } from '@/features/canvas/compat/nodeHostApi';
import { getCanvasElement } from '@/features/canvas/compat/engineBridge';
import { nodeTypes } from '@/features/canvas/nodes';
import { withNodeRenderErrorBoundary } from '@/features/canvas/nodes/NodeRenderErrorBoundary';
import type { Canvas2DEngine } from './engine';
import { selectDomIslands, type IslandViewport } from './domIslands';

/** 相机静止多久后恢复 DOM 岛（毫秒） */
const SUSPEND_RESUME_MS = 220;
/** 恢复期每帧放行的岛数量（摊薄重绘成本） */
const RESUME_BATCH_PER_FRAME = 8;
/** 调度器每帧新增挂载上限（摊薄"停止缩放瞬间"的集中挂载成本） */
const MOUNT_BATCH_PER_FRAME = 2;
/** 调度器每帧卸载上限 */
const UNMOUNT_BATCH_PER_FRAME = 6;
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
  const [islandIds, setIslandIds] = useState<string[]>([]);

  const selectedSet = useRef(new Set<string>());
  selectedSet.current = new Set(selectedIds);

  /* ---------- 相机运动期间挂起 DOM 岛（缩放/平移性能关键路径） ----------
   * 相机每帧变化时：隐藏非选中岛（display:none，保留挂载不卸载）、
   * 引擎 domIslands 清空让画布卡片接管 → 零 DOM 重排重绘、零挂载抖动；
   * 相机静止 SUSPEND_RESUME_MS 后恢复岛并刷新成员。
   * 选中节点的岛保持可见：编辑焦点不在缩放时丢失。 */
  const suspendedRef = useRef(false);
  const suspendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandSetRef = useRef<ReadonlySet<string>>(new Set<string>());
  /** 当前实际可见（display:''）的岛集合，与 engine.domIslands 严格同步 */
  const shownSetRef = useRef<Set<string>>(new Set<string>());
  /** 目标岛有序列表（选中优先、距离排序）与集合镜像 */
  const targetOrderRef = useRef<string[]>([]);
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
    const ids = selectDomIslands(model.nodes, selectedSet.current, viewport);
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
    // 成员变化只更新目标；实际挂载/卸载由 rAF 调度器分批执行
    islandSetRef.current = new Set(ids);
  }, [engineRef, model]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;


  const suspendForCamera = useCallback(() => {
    suspendedRef.current = true;
    if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
    suspendTimerRef.current = setTimeout(() => {
      suspendTimerRef.current = null;
      suspendedRef.current = false;
      recomputeRef.current();
    }, SUSPEND_RESUME_MS);
  }, []);

  useEffect(() => {
    mountedSetRef.current = new Set(islandIds);
    onIslandsChange(new Set(islandIds));
  }, [islandIds, onIslandsChange]);

  useEffect(() => {
    return () => {
      if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
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
        applyWorldTransform();
        suspendForCamera(); // 相机运动：挂起岛并续期恢复计时器
      });
    };
    attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unsub?.();
    };
  }, [applyWorldTransform, recompute, suspendForCamera, engineRef]);


  /* ---------- 拖拽期间岛跟随（rAF 直写 transform） ---------- */
  const modelRef = useRef<SceneModel | null>(null);
  modelRef.current = model;
  const appliedBaseRef = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      /* ---- 岛可见性：挂起期仅选中可见；恢复期每帧分批显示（防瞬时重绘尖峰） ---- */
      const engine = engineRef.current;
      if (engine) {
        const desired = suspendedRef.current
          ? new Set([...islandSetRef.current].filter((id) => selectedSet.current.has(id)))
          : islandSetRef.current;
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
          const want = desired.has(id);
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
        if (changed) engine.setDomIslands(new Set(shown));

        /* ---- 分批挂载/卸载：把停止缩放瞬间的集中成本摊到多帧 ---- */
        if (!suspendedRef.current) {
          const target = islandSetRef.current;
          const mounted = mountedSetRef.current;
          const removeChunk: string[] = [];
          for (const id of mounted) {
            if (!target.has(id) && removeChunk.length < UNMOUNT_BATCH_PER_FRAME) {
              removeChunk.push(id);
            }
          }
          const addChunk: string[] = [];
          if (removeChunk.length === 0) {
            for (const id of targetOrderRef.current) {
              if (addChunk.length >= MOUNT_BATCH_PER_FRAME) break;
              if (!mounted.has(id)) addChunk.push(id);
            }
          }
          if (removeChunk.length > 0 || addChunk.length > 0) {
            const removeSet = new Set(removeChunk);
            const addSet = new Set(addChunk);
            setIslandIds((prev) => {
              const next = new Set(prev);
              for (const id of removeSet) next.delete(id);
              for (const id of addSet) next.add(id);
              return [...next];
            });
          }
        }
      }

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
