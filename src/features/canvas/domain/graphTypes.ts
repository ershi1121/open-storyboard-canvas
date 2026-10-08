import type { CSSProperties } from 'react';

/**
 * 画布图数据的内部类型定义（唯一真源）。
 *
 * 字段与历史项目文件持久化格式逐一对齐，
 * 保证既有业务代码（canvasStore / projectStore / 节点组件）零语义变化。
 * 全项目唯一真源：字段结构沿袭历史数据格式（xy-edge__ 等 id 约定已随项目文件持久化，
 * 不可变更），保证旧项目文件双向兼容。
 */

export interface XYPosition {
  x: number;
  y: number;
}

export interface Dimensions {
  width?: number;
  height?: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type HandleType = 'source' | 'target';

/** 连接桩方位枚举（'left' | 'right' | 'top' | 'bottom'） */
export type HandlePosition = 'left' | 'right' | 'top' | 'bottom';

export type CoordinateExtent = [[number, number], [number, number]];

export interface NodeInternalsLike {
  positionAbsolute: XYPosition;
  measured: Dimensions;
  handleBounds?: unknown;
  userDragging?: boolean;
}

export interface NodeBase<TData = unknown, TType extends string = string> {
  id: string;
  position: XYPosition;
  data: TData;
  type: TType;
  parentId?: string;
  extent?: 'parent' | 'full' | CoordinateExtent;
  expandParent?: boolean;
  zIndex?: number;
  width?: number;
  height?: number;
  measured?: Dimensions;
  selected?: boolean;
  dragging?: boolean;
  resizing?: boolean;
  hidden?: boolean;
  className?: string;
  style?: CSSProperties;
  selectable?: boolean;
  deletable?: boolean;
  draggable?: boolean;
  connectable?: boolean | 'single';
  focusable?: boolean;
  sourcePosition?: HandlePosition;
  targetPosition?: HandlePosition;
  positionAbsolute?: XYPosition;
  origin?: [number, number];
  resizeHandle?: string;
  internals?: NodeInternalsLike;
}

export interface EdgeBase<TData = unknown> {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  type?: string;
  label?: unknown;
  data?: TData;
  style?: CSSProperties;
  className?: string;
  selected?: boolean;
  animated?: boolean;
  hidden?: boolean;
  deletable?: boolean;
  selectable?: boolean;
  focusable?: boolean;
  markerEnd?: unknown;
  markerStart?: unknown;
  zIndex?: number;
}

export interface Connection {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/* ---------------- 变更联合类型（历史数据层语义） ---------------- */

export type NodeAddChange<T> = { type: 'add'; item: T; index?: number };
export type NodeRemoveChange = { type: 'remove'; id: string };
export type NodeReplaceChange<T> = { type: 'replace'; id: string; item: T };
export type NodeSelectionChange = { type: 'select'; id: string; selected: boolean };
export type NodePositionChange = {
  type: 'position';
  id: string;
  position?: XYPosition;
  positionAbsolute?: XYPosition;
  dragging: boolean;
};
export type NodeDimensionChange = {
  type: 'dimensions';
  id: string;
  dimensions?: Dimensions;
  setAttributes?: boolean | 'width' | 'height';
  resizing?: boolean;
};

export type NodeChange<T> =
  | NodeAddChange<T>
  | NodeRemoveChange
  | NodeReplaceChange<T>
  | NodeSelectionChange
  | NodePositionChange
  | NodeDimensionChange;

export type EdgeAddChange<T> = { type: 'add'; item: T; index?: number };
export type EdgeRemoveChange = { type: 'remove'; id: string };
export type EdgeReplaceChange<T> = { type: 'replace'; id: string; item: T };
export type EdgeSelectionChange = { type: 'select'; id: string; selected: boolean };

export type EdgeChange<T> =
  | EdgeAddChange<T>
  | EdgeRemoveChange
  | EdgeReplaceChange<T>
  | EdgeSelectionChange;
