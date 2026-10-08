import { describe, expect, it } from 'vitest';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { buildSceneModel, hashAccentColor } from './sceneModel';
import { SpatialGrid, filterDragDescendants } from './spatialGrid';

function makeNode(partial: Partial<CanvasNode> & { id: string }): CanvasNode {
  return {
    position: { x: 0, y: 0 },
    data: {} as CanvasNodeData,
    ...partial,
  } as CanvasNode;
}

describe('buildSceneModel', () => {
  it('把父链坐标累加成绝对坐标', () => {
    const parent = makeNode({
      id: 'g1',
      type: CANVAS_NODE_TYPES.group,
      position: { x: 100, y: 50 },
      width: 800,
      height: 600,
      data: { label: '第一幕' } as CanvasNodeData,
    });
    const child = makeNode({
      id: 'c1',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 20, y: 30 },
      parentId: 'g1',
      measured: { width: 240, height: 150 },
      data: { imageUrl: null, aspectRatio: '16:9' } as CanvasNodeData,
    });
    const model = buildSceneModel([parent, child], []);
    const rendered = model.byId.get('c1');
    expect(rendered).toBeDefined();
    expect(rendered?.x).toBe(120);
    expect(rendered?.y).toBe(80);
    expect(rendered?.w).toBe(240);
    expect(rendered?.h).toBe(150);
    expect(model.parentOf.get('c1')).toBe('g1');
  });

  it('分组绘制在最前（大组垫底），普通节点保持 store 顺序', () => {
    const big = makeNode({
      id: 'big',
      type: CANVAS_NODE_TYPES.group,
      position: { x: 0, y: 0 },
      width: 900,
      height: 700,
      data: { label: 'big' } as CanvasNodeData,
    });
    const small = makeNode({
      id: 'small',
      type: CANVAS_NODE_TYPES.group,
      position: { x: 10, y: 10 },
      width: 200,
      height: 150,
      data: { label: 'small' } as CanvasNodeData,
    });
    const image = makeNode({
      id: 'img',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 300, y: 300 },
      data: { imageUrl: '/tmp/a.png', aspectRatio: '1:1' } as CanvasNodeData,
    });
    const model = buildSceneModel([image, small, big], []);
    expect(model.nodes.map((n) => n.id)).toEqual(['big', 'small', 'img']);
    expect(model.nodes[0].z).toBe(0);
    expect(model.nodes[2].z).toBe(2);
  });

  it('归一化生成状态与徽标', () => {
    const generating = makeNode({
      id: 'n1',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: { imageUrl: null, aspectRatio: '1:1', isGenerating: true, batchIndex: 2, batchTotal: 4 } as CanvasNodeData,
    });
    const failed = makeNode({
      id: 'n2',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 400, y: 0 },
      data: { imageUrl: null, aspectRatio: '1:1', prompt: '', model: 'm', size: '1024x1024', generationError: 'boom' } as CanvasNodeData,
    });
    const model = buildSceneModel([generating, failed], []);
    expect(model.byId.get('n1')?.status).toBe('gen');
    expect(model.byId.get('n1')?.badge).toBe('3/4');
    expect(model.byId.get('n2')?.status).toBe('fail');
  });

  it('标签节点使用自定义颜色或按源哈希取色', () => {
    const custom = makeNode({
      id: 't1',
      type: CANVAS_NODE_TYPES.tag,
      position: { x: 0, y: 0 },
      data: { label: '主角', color: '#ff0000', sourceId: 'src1' } as CanvasNodeData,
    });
    const hashed = makeNode({
      id: 't2',
      type: CANVAS_NODE_TYPES.tag,
      position: { x: 0, y: 60 },
      data: { label: '配角', sourceId: 'src1' } as CanvasNodeData,
    });
    const model = buildSceneModel([custom, hashed], []);
    expect(model.byId.get('t1')?.accent).toBe('#ff0000');
    expect(model.byId.get('t2')?.accent).toBe(hashAccentColor('src1'));
  });

  it('边状态跟随目标节点，孤立边被丢弃', () => {
    const source = makeNode({
      id: 's',
      type: CANVAS_NODE_TYPES.storyboardGen,
      position: { x: 0, y: 0 },
      data: { gridRows: 1, gridCols: 1, frames: [], model: 'm', size: '1024x1024', requestAspectRatio: '1:1', imageUrl: null, aspectRatio: '1:1', isGenerating: true } as CanvasNodeData,
    });
    const target = makeNode({
      id: 't',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 500, y: 0 },
      data: { imageUrl: null, aspectRatio: '1:1', isGenerating: true } as CanvasNodeData,
    });
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 's', target: 't' },
      { id: 'e2', source: 's', target: 'missing' },
    ];
    const model = buildSceneModel([source, target], edges);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].state).toBe('gen');
  });

  it('通过注入的 resolveUrl 解析图片地址', () => {
    const node = makeNode({
      id: 'u1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: 'file:///tmp/a.png', previewImageUrl: 'file:///tmp/a_small.png', aspectRatio: '1:1' } as CanvasNodeData,
    });
    const model = buildSceneModel([node], [], { resolveUrl: (url) => `asset://${url}` });
    expect(model.byId.get('u1')?.imageUrl).toBe('asset://file:///tmp/a.png');
    expect(model.byId.get('u1')?.previewUrl).toBe('asset://file:///tmp/a_small.png');
  });
});

describe('SpatialGrid', () => {
  const nodes = buildSceneModel(
    [
      makeNode({ id: 'a', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, width: 200, height: 120, data: { imageUrl: null, aspectRatio: '1:1' } as CanvasNodeData }),
      makeNode({ id: 'b', type: CANVAS_NODE_TYPES.upload, position: { x: 1000, y: 800 }, width: 200, height: 120, data: { imageUrl: null, aspectRatio: '1:1' } as CanvasNodeData }),
      makeNode({ id: 'g', type: CANVAS_NODE_TYPES.group, position: { x: -50, y: -50 }, width: 400, height: 300, data: { label: 'g' } as CanvasNodeData }),
    ],
    [],
  ).nodes;

  it('命中普通节点优先于分组', () => {
    const grid = new SpatialGrid(nodes);
    const hit = grid.hitTest(100, 60);
    expect(hit?.id).toBe('a');
  });

  it('分组内空白处命中分组', () => {
    const grid = new SpatialGrid(nodes);
    const hit = grid.hitTest(-20, -20);
    expect(hit?.id).toBe('g');
  });

  it('空白处返回 null', () => {
    const grid = new SpatialGrid(nodes);
    expect(grid.hitTest(5000, 5000)).toBeNull();
  });

  it('queryRect 只返回视口附近候选', () => {
    const grid = new SpatialGrid(nodes);
    const candidates = grid.queryRect({ x: 900, y: 700, w: 400, h: 300 });
    const ids = new Set(candidates.map((i) => nodes[i].id));
    expect(ids.has('b')).toBe(true);
    expect(ids.has('a')).toBe(false);
  });
});

describe('filterDragDescendants', () => {
  it('过滤掉集合内其他节点的后代，避免双重位移', () => {
    const parentOf = new Map<string, string | undefined>([
      ['g', undefined],
      ['c1', 'g'],
      ['c2', 'g'],
      ['free', undefined],
    ]);
    expect(filterDragDescendants(['g', 'c1', 'free'], parentOf)).toEqual(['g', 'free']);
  });

  it('无父子关系时原样返回', () => {
    const parentOf = new Map<string, string | undefined>([
      ['a', undefined],
      ['b', undefined],
    ]);
    expect(filterDragDescendants(['a', 'b'], parentOf)).toEqual(['a', 'b']);
  });
});

describe('buildSceneModel 生成类节点卡片内容（防"灰块"回归）', () => {
  it('未生成的 AI 图片节点：textPreview=提示词，badge=模型·比例', () => {
    const node = makeNode({
      id: 'ai1',
      type: CANVAS_NODE_TYPES.imageEdit,
      measured: { width: 360, height: 420 },
      data: {
        prompt: '雨夜街头，主角撑伞回眸',
        model: 'seedream-4',
        modelConfig: { entryId: 'x', ratio: '16:9' },
        imageUrl: null,
      } as unknown as CanvasNodeData,
    });
    const rendered = buildSceneModel([node], []).byId.get('ai1');
    expect(rendered?.textPreview).toBe('雨夜街头，主角撑伞回眸');
    expect(rendered?.badge).toBe('seedream-4 · 16:9');
  });

  it('批次徽标优先于参数徽标；已有结果图时 textPreview 仍可携带（渲染层按有无图切换）', () => {
    const node = makeNode({
      id: 'ai2',
      type: CANVAS_NODE_TYPES.imageEdit,
      data: {
        prompt: 'p',
        model: 'm',
        aspectRatio: '1:1',
        batchIndex: 2,
        batchTotal: 4,
        imageUrl: '/tmp/x.png',
      } as unknown as CanvasNodeData,
    });
    const rendered = buildSceneModel([node], []).byId.get('ai2');
    expect(rendered?.badge).toBe('3/4');
    expect(rendered?.imageUrl).toBeTruthy();
  });

  it('全景节点预览 sourcePrompt', () => {
    const node = makeNode({
      id: 'pano1',
      type: CANVAS_NODE_TYPES.panorama,
      data: { sourcePrompt: '雪山环景', imageUrl: null, aspectRatio: '2:1', sourceMode: 'text' } as unknown as CanvasNodeData,
    });
    const rendered = buildSceneModel([node], []).byId.get('pano1');
    expect(rendered?.textPreview).toBe('雪山环景');
    expect(rendered?.badge).toBe('◎ 全景');
  });

  it('故事板生成节点预览各帧描述', () => {
    const node = makeNode({
      id: 'sb1',
      type: CANVAS_NODE_TYPES.storyboardGen,
      data: {
        frames: [
          { id: 'f1', description: '开场远景', referenceIndex: null },
          { id: 'f2', description: '主角特写', referenceIndex: null },
        ],
        gridRows: 1,
        gridCols: 2,
        model: 'm',
      } as unknown as CanvasNodeData,
    });
    const rendered = buildSceneModel([node], []).byId.get('sb1');
    expect(rendered?.textPreview).toBe('开场远景\n主角特写');
    expect(rendered?.badge).toBe('2 格');
  });

  it('上传节点（无 prompt）不受影响', () => {
    const node = makeNode({
      id: 'up1',
      type: CANVAS_NODE_TYPES.upload,
      data: { imageUrl: '/tmp/a.png', sourceFileName: 'a.png' } as unknown as CanvasNodeData,
    });
    const rendered = buildSceneModel([node], []).byId.get('up1');
    expect(rendered?.textPreview).toBeNull();
    expect(rendered?.title).toBe('a.png');
  });
});

describe('buildSceneModel 边生成态业务规则（旧版对齐）', () => {
  function node(id: string, type: string, gen = false) {
    return makeNode({
      id,
      type: type as never,
      data: { isGenerating: gen, imageUrl: gen ? null : '/x.png' } as unknown as CanvasNodeData,
    });
  }
  it('AI图片→结果图 且生成中：边为 gen', () => {
    const model = buildSceneModel(
      [node('a', CANVAS_NODE_TYPES.imageEdit), node('b', CANVAS_NODE_TYPES.exportImage, true)],
      [{ id: 'e', source: 'a', target: 'b' } as CanvasEdge],
    );
    expect(model.edges[0]?.state).toBe('gen');
  });
  it('上传→AI图片（生成中）：入边点亮流光（宽规则，覆盖用户工作流）', () => {
    const model = buildSceneModel(
      [node('a', CANVAS_NODE_TYPES.upload), node('b', CANVAS_NODE_TYPES.imageEdit, true)],
      [{ id: 'e', source: 'a', target: 'b' } as CanvasEdge],
    );
    expect(model.edges[0]?.state).toBe('gen');
  });
});
