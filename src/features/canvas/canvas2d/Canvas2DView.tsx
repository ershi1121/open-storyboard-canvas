import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeChange, ReactFlowInstance, Viewport } from '@xyflow/react';

import { useCanvasStore, type CanvasNode } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { buildSceneModel } from './sceneModel';
import { filterDragDescendants } from './spatialGrid';
import { Canvas2DEngine, type EngineStats, type ViewportLike } from './engine';

/**
 * Canvas2D 渲染后端（实验性）。
 *
 * 与 React Flow 版 Canvas 的关系：
 * - 共享同一份文档模型（canvasStore）、持久化（useCanvasPersistence）、
 *   生成轮询（useCanvasGenerationPolling）与撤销历史；
 * - 渲染与手势完全脱离 DOM/React：手势期间零 store 写入，
 *   松手时一次性 commit（见 engine.ts 顶部注释）。
 *
 * v0 未接入：连线拖出、框选、磁吸、节点内编辑面板、右键菜单、节点缩放。
 * 切换入口：设置 → 外观 → 画布渲染引擎。
 */

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function viewportEquals(a: ViewportLike | null | undefined, b: ViewportLike | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom - b.zoom) < 0.0001;
}

export function Canvas2DView() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Canvas2DEngine | null>(null);
  const lastEmittedSelectionRef = useRef<string | null>(null);
  const lastCommittedViewportRef = useRef<ViewportLike | null>(null);
  const schedulePersistRef = useRef<(delayMs?: number) => void>(() => {});
  const [stats, setStats] = useState<EngineStats | null>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const currentViewport = useCanvasStore((state) => state.currentViewport);
  const theme = useThemeStore((state) => state.theme);
  const apiKeys = useSettingsStore((state) => state.apiKeys);

  /* ---------- 持久化（复用 RF 版同一套 hook，传入视口适配器） ---------- */
  const persistenceAdapter = useMemo(
    () =>
      ({
        getViewport: (): Viewport => {
          const live = engineRef.current?.getViewport();
          return live
            ? { x: live.x, y: live.y, zoom: live.zoom }
            : useCanvasStore.getState().currentViewport ?? DEFAULT_VIEWPORT;
        },
        setViewport: (viewport: Viewport) => {
          useCanvasStore.getState().setViewportState(viewport);
        },
      }) as unknown as ReactFlowInstance,
    [],
  );
  const { scheduleCanvasPersist } = useCanvasPersistence(persistenceAdapter);
  schedulePersistRef.current = scheduleCanvasPersist;

  /* 生成轮询：与 RF 版行为一致（同一时刻只挂载一个画布后端） */
  useCanvasGenerationPolling(nodes, apiKeys);

  /* ---------- 渲染模型 ---------- */
  const model = useMemo(
    () => buildSceneModel(nodes, edges, { resolveUrl: resolveImageDisplayUrl }),
    [nodes, edges],
  );

  /* ---------- 引擎生命周期（挂载一次） ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Canvas2DEngine({
      onSelect: (_ids, primary) => {
        lastEmittedSelectionRef.current = primary;
        const store = useCanvasStore.getState();
        if (store.selectedNodeId !== primary) store.setSelectedNode(primary);
      },
      onDragStart: (ids) => {
        const store = useCanvasStore.getState();
        const byId = new Map(store.nodes.map((node) => [node.id, node]));
        const changes: NodeChange<CanvasNode>[] = [];
        for (const id of ids) {
          const node = byId.get(id);
          if (!node) continue;
          changes.push({ type: 'position', id, position: { ...node.position }, dragging: true });
        }
        if (changes.length > 0) store.onNodesChange(changes);
      },
      onDragCommit: (ids, dx, dy) => {
        const store = useCanvasStore.getState();
        const byId = new Map(store.nodes.map((node) => [node.id, node]));
        const parentOf = new Map(store.nodes.map((node) => [node.id, node.parentId]));
        const effective = new Set(filterDragDescendants(ids, parentOf));
        const changes: NodeChange<CanvasNode>[] = [];
        for (const id of ids) {
          const node = byId.get(id);
          if (!node) continue;
          // 后代节点随父移动，相对坐标不变，但仍需清掉 dragging 标记
          const position = effective.has(id)
            ? { x: node.position.x + dx, y: node.position.y + dy }
            : { ...node.position };
          changes.push({ type: 'position', id, position, dragging: false });
        }
        if (changes.length > 0) store.onNodesChange(changes);
        schedulePersistRef.current(0);
      },
      onViewportCommit: (viewport) => {
        lastCommittedViewportRef.current = viewport;
        useCanvasStore.getState().setViewportState({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
      },
      onCursor: (cursor) => {
        if (canvasRef.current) canvasRef.current.style.cursor = cursor;
      },
    });
    engine.attach(canvas);
    const rect = containerRef.current?.getBoundingClientRect();
    engine.resize(rect?.width ?? 800, rect?.height ?? 600, Math.min(window.devicePixelRatio || 1, 2));
    engine.setTheme(useThemeStore.getState().theme);
    const vp = useCanvasStore.getState().currentViewport;
    if (vp) {
      engine.adoptViewport(vp);
      lastCommittedViewportRef.current = vp;
    }
    engine.start();
    engineRef.current = engine;

    const statsTimer = setInterval(() => {
      setStats({ ...engine.getStats() });
    }, 500);

    return () => {
      clearInterval(statsTimer);
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  /* ---------- store → engine 同步 ---------- */
  useEffect(() => {
    engineRef.current?.setModel(model);
  }, [model]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  // 外部选区变化（撤销/删除/面板联动）→ 引擎
  useEffect(() => {
    if (selectedNodeId === lastEmittedSelectionRef.current) return;
    lastEmittedSelectionRef.current = selectedNodeId;
    engineRef.current?.setSelection(selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId]);

  // 外部视口变化（项目恢复/切换）→ 引擎
  useEffect(() => {
    if (viewportEquals(currentViewport, lastCommittedViewportRef.current)) return;
    lastCommittedViewportRef.current = currentViewport ?? null;
    if (currentViewport) engineRef.current?.adoptViewport(currentViewport);
  }, [currentViewport]);

  /* ---------- 输入 ---------- */
  const localXY = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const p = localXY(event);
      engineRef.current?.pointerDown(p.x, p.y, event.shiftKey);
    },
    [localXY],
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const p = localXY(event);
      engineRef.current?.pointerMove(p.x, p.y);
    },
    [localXY],
  );
  const handlePointerUp = useCallback(() => {
    engineRef.current?.pointerUp();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      engineRef.current?.wheel(event.clientX - rect.left, event.clientY - rect.top, event.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      engineRef.current?.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /* ---------- 快捷键（v0 精简集） ---------- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const store = useCanvasStore.getState();
      if (store.activeToolDialog || store.imageViewer.isOpen) return;
      const key = event.key;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (key === 'z' || key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && (key === 'y' || key === 'Y')) {
        event.preventDefault();
        store.redo();
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        const ids = [...(engineRef.current?.getSelectedIds() ?? [])];
        if (ids.length === 0) return;
        event.preventDefault();
        store.deleteNodes(ids);
        schedulePersistRef.current(0);
        return;
      }
      if (key === 'Escape') {
        engineRef.current?.clearSelection();
        return;
      }
      if (key === 'f' || key === 'F') {
        event.preventDefault();
        engineRef.current?.fitView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ---------- HUD ---------- */
  const hudFps = stats?.fps ?? 0;
  const fpsClass = hudFps >= 50 ? 'text-emerald-400' : hudFps >= 30 ? 'text-amber-400' : 'text-red-400';

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-bg-dark">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ cursor: 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      {/* 状态 HUD */}
      <div className="pointer-events-none absolute right-3 top-3 min-w-[190px] rounded-lg border border-border-dark bg-[rgba(11,15,24,0.85)] p-3 font-mono text-[11px] leading-5 text-text-muted backdrop-blur-sm">
        <div className={`text-xl font-bold ${fpsClass}`}>{stats ? stats.fps : '--'} FPS</div>
        <div className="mt-1 flex justify-between gap-3">
          <span>{t('canvas2d.hudFrame')}</span>
          <b className="text-text-dark">{stats ? `${stats.frameMs.toFixed(1)} ms` : '--'}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>{t('canvas2d.hudVisible')}</span>
          <b className="text-text-dark">
            {stats ? `${stats.visible} / ${stats.total}` : '--'}
          </b>
        </div>
        <div className="flex justify-between gap-3">
          <span>{t('canvas2d.hudEdges')}</span>
          <b className="text-text-dark">{stats ? `${stats.edgesDrawn}` : '--'}</b>
        </div>
        <div className="flex justify-between gap-3">
          <span>zoom</span>
          <b className="text-text-dark">{stats ? `${stats.zoom.toFixed(2)}×` : '--'}</b>
        </div>
        <div className="pointer-events-auto mt-2 flex gap-1.5">
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.zoomBy(1.25)}
          >
            +
          </button>
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.zoomBy(0.8)}
          >
            −
          </button>
          <button
            type="button"
            className="rounded border border-border-dark bg-surface-dark px-2 py-0.5 text-[11px] text-text-dark hover:border-accent"
            onClick={() => engineRef.current?.fitView()}
          >
            {t('canvas2d.fit')}
          </button>
        </div>
      </div>

      {/* 预览版提示 */}
      <div className="pointer-events-none absolute left-3 top-3 max-w-[420px] rounded-lg border border-sky-500/30 bg-[rgba(12,42,61,0.88)] px-3 py-2 text-[11px] leading-4 text-sky-200 backdrop-blur-sm">
        <b className="text-sky-100">{t('canvas2d.badge')}</b>
        <span className="mx-1.5 opacity-50">|</span>
        {t('canvas2d.banner')}
      </div>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <div className="rounded-xl border border-border-dark bg-surface-dark/90 px-6 py-4 text-center text-sm text-text-muted">
            {t('canvas2d.empty')}
          </div>
        </div>
      )}
    </div>
  );
}
