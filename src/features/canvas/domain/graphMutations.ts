/**
 * 图变更应用工具 —— @xyflow/react 运行时依赖的内部替代实现。
 *
 * 语义与 @xyflow/system v12 的 applyChanges / addEdge 逐行对齐
 * （对照 node_modules/@xyflow/system/dist/esm/index.js 移植）：
 * - remove 优先于同元素的其他变更
 * - replace 直接替换为新对象（浅拷贝）
 * - 同一元素的多个变更合并为一次浅拷贝后依次可变应用
 * - add 支持 index 插入，否则追加
 * - dimensions 变更写 measured；setAttributes 时同步 width/height
 * - addEdge 按 source/target/handles 去重（handle 空值等价），
 *   无 id 时生成 `xy-edge__{source}{sourceHandle}-{target}{targetHandle}`
 *
 * 类型仍暂借 @xyflow 的 NodeChange/EdgeChange（纯类型导入，编译期擦除，
 * 运行时零依赖）；P4 移除 RF 时将类型一并内部化。
 */

type XYPos = { x: number; y: number };

export interface GraphElementChange<T> {
  type: 'select' | 'position' | 'dimensions' | 'remove' | 'add' | 'replace';
  id?: string;
  selected?: boolean;
  position?: XYPos;
  dragging?: boolean;
  dimensions?: { width?: number; height?: number };
  setAttributes?: boolean | 'width' | 'height';
  resizing?: boolean;
  item?: T;
  index?: number;
}

interface Identified {
  id: string;
}

interface MutableElementFields {
  position?: XYPos;
  dragging?: boolean;
  selected?: boolean;
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  resizing?: boolean;
}

/** 单个变更的可变应用（与 @xyflow applyChange 一致） */
function applyChange<T extends Identified>(change: GraphElementChange<T>, element: T): void {
  const target = element as T & MutableElementFields;
  switch (change.type) {
    case 'select': {
      target.selected = change.selected;
      break;
    }
    case 'position': {
      if (typeof change.position !== 'undefined') {
        target.position = change.position;
      }
      if (typeof change.dragging !== 'undefined') {
        target.dragging = change.dragging;
      }
      break;
    }
    case 'dimensions': {
      if (typeof change.dimensions !== 'undefined') {
        target.measured = { ...change.dimensions };
        if (change.setAttributes) {
          if (change.setAttributes === true || change.setAttributes === 'width') {
            target.width = change.dimensions.width;
          }
          if (change.setAttributes === true || change.setAttributes === 'height') {
            target.height = change.dimensions.height;
          }
        }
      }
      if (typeof change.resizing === 'boolean') {
        target.resizing = change.resizing;
      }
      break;
    }
    default:
      break;
  }
}

/** 变更批量应用（与 @xyflow applyChanges 一致） */
export function applyChanges<T extends Identified>(
  changes: Array<GraphElementChange<T>>,
  elements: T[],
): T[] {
  const updatedElements: T[] = [];
  const changesMap = new Map<string, Array<GraphElementChange<T>>>();
  const addItemChanges: Array<GraphElementChange<T>> = [];

  for (const change of changes) {
    if (change.type === 'add') {
      addItemChanges.push(change);
      continue;
    }
    const id = change.id as string;
    if (change.type === 'remove' || change.type === 'replace') {
      changesMap.set(id, [change]);
    } else {
      const existing = changesMap.get(id);
      if (existing) {
        existing.push(change);
      } else {
        changesMap.set(id, [change]);
      }
    }
  }

  for (const element of elements) {
    const elementChanges = changesMap.get(element.id);
    if (!elementChanges) {
      updatedElements.push(element);
      continue;
    }
    if (elementChanges[0].type === 'remove') {
      continue;
    }
    if (elementChanges[0].type === 'replace') {
      updatedElements.push({ ...(elementChanges[0].item as T) });
      continue;
    }
    const updatedElement = { ...element };
    for (const change of elementChanges) {
      applyChange(change, updatedElement);
    }
    updatedElements.push(updatedElement);
  }

  if (addItemChanges.length > 0) {
    for (const change of addItemChanges) {
      if (change.index !== undefined) {
        updatedElements.splice(change.index, 0, { ...(change.item as T) });
      } else {
        updatedElements.push({ ...(change.item as T) });
      }
    }
  }

  return updatedElements;
}

export function applyNodeChangesInternal<NodeType extends Identified>(
  changes: Array<GraphElementChange<NodeType>>,
  nodes: NodeType[],
): NodeType[] {
  return applyChanges(changes, nodes);
}

export function applyEdgeChangesInternal<EdgeType extends Identified>(
  changes: Array<GraphElementChange<EdgeType>>,
  edges: EdgeType[],
): EdgeType[] {
  return applyChanges(changes, edges);
}

/* ---------------- addEdge ---------------- */

export interface ConnectionLike {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

interface EdgeLike extends Identified {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export function getEdgeIdInternal(connection: ConnectionLike): string {
  return `xy-edge__${connection.source}${connection.sourceHandle || ''}-${connection.target}${connection.targetHandle || ''}`;
}

function connectionExists<E extends EdgeLike>(edge: E, edges: E[]): boolean {
  return edges.some(
    (el) =>
      el.source === edge.source &&
      el.target === edge.target &&
      (el.sourceHandle === edge.sourceHandle || (!el.sourceHandle && !edge.sourceHandle)) &&
      (el.targetHandle === edge.targetHandle || (!el.targetHandle && !edge.targetHandle)),
  );
}

/** 与 @xyflow addEdge 一致：去重、无 id 时按约定生成、清理 null handle */
export function addEdgeInternal<EdgeType extends EdgeLike>(
  edgeParams: Partial<EdgeType> & ConnectionLike & { id?: string },
  edges: EdgeType[],
): EdgeType[] {
  if (!edgeParams.source || !edgeParams.target) {
    return edges;
  }
  let edge: EdgeType;
  if ('id' in edgeParams && edgeParams.id) {
    edge = { ...edgeParams } as EdgeType;
  } else {
    edge = { ...edgeParams, id: getEdgeIdInternal(edgeParams) } as EdgeType;
  }
  if (connectionExists(edge, edges)) {
    return edges;
  }
  if (edge.sourceHandle === null) {
    delete (edge as { sourceHandle?: string | null }).sourceHandle;
  }
  if (edge.targetHandle === null) {
    delete (edge as { targetHandle?: string | null }).targetHandle;
  }
  return edges.concat(edge);
}
