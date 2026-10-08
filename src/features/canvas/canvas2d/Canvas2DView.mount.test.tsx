// @vitest-environment jsdom
/**
 * Canvas2DView / DomIslands 挂载诊断测试（防黑屏回归）：
 * - 全视图挂载冒烟：任何渲染期异常都会使测试失败
 * - DomIslands 直挂（stub 引擎，无 rAF 时序依赖）：验证岛内渲染原版编辑组件
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '@/i18n';
import { Canvas2DView } from './Canvas2DView';
import { DomIslands } from './DomIslands';
import { buildSceneModel } from './sceneModel';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function makeCtxStub(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return () => ({ width: 10 });
      return () => undefined;
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeNode(partial: Partial<CanvasNode> & { id: string }): CanvasNode {
  return { position: { x: 0, y: 0 }, data: {} as CanvasNodeData, ...partial } as CanvasNode;
}

const AI_NODE = makeNode({
  id: 'ai1',
  type: CANVAS_NODE_TYPES.imageEdit,
  position: { x: 40, y: 40 },
  width: 360,
  height: 420,
  measured: { width: 360, height: 420 },
  data: { prompt: '雨夜街头', model: 'seedream-4', imageUrl: null } as unknown as CanvasNodeData,
});

/** stub 引擎：同步可用，绕开 rAF 就绪时序 */
function makeStubEngine() {
  const islands: { current: ReadonlySet<string> } = { current: new Set() };
  return {
    islands,
    ref: {
      current: {
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getViewSize: () => ({ w: 1200, h: 800 }),
        addCameraListener: () => () => {},
        getDragOffset: () => null,
        setDomIslands: (ids: ReadonlySet<string>) => {
          islands.current = ids;
        },
        getDomIslands: () => islands.current,
      },
    },
  };
}

describe('Canvas2DView / DomIslands 挂载诊断（防黑屏回归）', () => {
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverPolyfill;
    HTMLCanvasElement.prototype.getContext = function () {
      return makeCtxStub();
    } as never;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container?.remove();
    container = null;
    useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  });

  it('全视图含节点挂载不抛异常（冒烟）', async () => {
    useCanvasStore.setState({
      nodes: [AI_NODE],
      edges: [],
      currentViewport: { x: 0, y: 0, zoom: 1 },
    });
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<Canvas2DView />);
      await sleep(80);
    });
    expect(container?.querySelector('canvas')).not.toBeNull();
    // 正常路径不再渲染右侧检视面板（编辑全部在画布岛内完成）
    const text = (container as HTMLDivElement).textContent ?? '';
    expect(text).not.toContain('节点编辑');
    expect(text).not.toContain('Node Editor');
    await act(async () => {
      root?.unmount();
    });
  });

  it('DomIslands 直挂：岛内渲染原版编辑组件（提示词可编辑）', async () => {
    useCanvasStore.setState({ nodes: [AI_NODE], edges: [] });
    const engine = makeStubEngine();
    const model = buildSceneModel([AI_NODE], []);
    const reported: ReadonlySet<string>[] = [];

    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <DomIslands
          engineRef={engine.ref as never}
          model={model}
          selectedIds={[]}
          onIslandsChange={(ids) => reported.push(ids)}
        />,
      );
    });

    // 挂载经 rAF 调度器分批执行：轮询等待岛出现
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await act(async () => {
        await sleep(40);
      });
      ok = engine.islands.current.has('ai1');
    }
    expect(ok).toBe(true);
    expect(reported.some((ids) => ids.has('ai1'))).toBe(true);

    const textareas = Array.from(
      (container as HTMLDivElement).querySelectorAll('textarea'),
    ) as HTMLTextAreaElement[];
    const values = textareas.map((el) => el.value).join('\n');
    expect(values).toContain('雨夜街头');

    await act(async () => {
      root?.unmount();
    });
  });

  it('DomIslands 直挂：极端全览且无选中不挂载岛', async () => {
    useCanvasStore.setState({ nodes: [AI_NODE], edges: [] });
    const engine = makeStubEngine();
    engine.ref.current.getViewport = () => ({ x: 0, y: 0, zoom: 0.02 });
    const model = buildSceneModel([AI_NODE], []);

    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <DomIslands
          engineRef={engine.ref as never}
          model={model}
          selectedIds={[]}
          onIslandsChange={() => {}}
        />,
      );
    });

    expect(engine.islands.current.size).toBe(0);
    expect((container as HTMLDivElement).querySelectorAll('textarea').length).toBe(0);

    await act(async () => {
      root?.unmount();
    });
  });
});
