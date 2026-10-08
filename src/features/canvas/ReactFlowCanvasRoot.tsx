import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Canvas';

/**
 * React Flow 画布的独立入口（懒加载块）。
 *
 * 仅当 settingsStore.canvasRenderer === 'reactflow' 时才会被动态 import，
 * 保证 Canvas2D 模式下 @xyflow/* 的代码完全不加载、不执行。
 * P4 移除 React Flow 时删除本文件及其懒加载引用即可。
 */
export function ReactFlowCanvasRoot() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
