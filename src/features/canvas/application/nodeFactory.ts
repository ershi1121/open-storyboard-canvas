import type { XYPosition } from '@xyflow/react';

import type { CanvasNode, CanvasNodeData, CanvasNodeType } from '../domain/canvasNodes';
import type { IdGenerator, NodeCatalog, NodeFactory } from './ports';

export class CanvasNodeFactory implements NodeFactory {
  constructor(
    private readonly idGenerator: IdGenerator,
    private readonly nodeCatalog: NodeCatalog
  ) {}

  createNode(
    type: CanvasNodeType,
    position: XYPosition,
    data: Partial<CanvasNodeData> = {}
  ): CanvasNode {
    const definition = this.nodeCatalog.getDefinition(type);
    const nodeData = {
      ...definition.createDefaultData(),
      ...data,
    } as CanvasNodeData;

    const node: CanvasNode = {
      id: this.idGenerator.next(),
      type,
      position,
      data: nodeData,
    };

    if (definition.defaultSize) {
      // ⚠️ 不要写进 node.style：style.width/height 是固定的行内 CSS，
      // 会在每次渲染时把 DOM 强制钉死到创建时的初始尺寸，导致
      // NodeResizeControl 缩小节点后一松手又弹回原始大小。
      // React Flow 通过节点顶层的 width/height 字段来管理可变尺寸，
      // 缩放产生的 dimensions change（见 canvasStore.onNodesChange）
      // 更新的也正是这两个字段，所以初始值也应该写在这里。
      node.width = definition.defaultSize.width;
      node.height = definition.defaultSize.height;
    }

    return node;
  }
}