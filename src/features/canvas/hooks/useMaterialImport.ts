import { useCallback, useEffect } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';

import { resolveFreeNodePosition, useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { clientToWorldPosition } from '@/features/canvas/compat/engineBridge';
import {
  prepareNodeImage,
  prepareNodeImageFromFile,
} from '@/features/canvas/application/imageData';
import {
  dataTransferHasExternalFilePayload,
  dataTransferHasMaterialFile,
  isAudioFile,
  isImageFile,
  isMaterialFile,
  isVideoFile,
  resolveDroppedMaterialFile,
  resolveDroppedMaterialSource,
  type DroppedMaterialSource,
} from '@/features/canvas/application/imageDragDrop';
import {
  prepareVideoNodeDataFromFile,
  prepareVideoNodeDataFromSource,
} from '@/features/canvas/application/videoUpload';
import {
  prepareAudioNodeDataFromFile,
  prepareAudioNodeDataFromSource,
} from '@/features/canvas/application/audioUpload';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type AudioNodeData,
  type CanvasNodeData,
  type CanvasNodeType,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 素材拖入画布（Canvas2D 版）。
 *
 * 支持两类拖拽源：
 * - 操作系统文件拖入（图片 / 视频 / 音频 → 上传 / 视频 / 音频节点）
 * - 文本形式的本地路径或 file:// URI（text/uri-list、text/plain → 按扩展名推断素材类型）
 *
 * 坐标换算经 engineBridge.clientToWorldPosition 走 Canvas2D 引擎相机；
 * 引擎未挂载时回退到 store 中最近一次提交的视口。
 */

interface UseMaterialImportOptions {
  scheduleCanvasPersist: (delay?: number) => void;
}

export interface CreatedMaterialNode {
  nodeId: string;
  type: CanvasNodeType;
}

export function useMaterialImport({ scheduleCanvasPersist }: UseMaterialImportOptions) {
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);

  const createUploadImageNodeAtWorldPosition = useCallback(
    async (file: File, worldPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareNodeImageFromFile(file);
        const newNodeId = addNode(CANVAS_NODE_TYPES.upload, worldPosition, {
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: file.name,
        });
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import image onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode],
  );

  const createUploadImageNodeAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) => {
      await createUploadImageNodeAtWorldPosition(file, clientToWorldPosition(clientPosition));
    },
    [createUploadImageNodeAtWorldPosition],
  );

  const createVideoNodeFromFileAtWorldPosition = useCallback(
    async (file: File, worldPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareVideoNodeDataFromFile(file);
        const nodeData: Partial<VideoNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle) {
          nodeData.displayName = file.name;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, worldPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import video onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle],
  );

  const createAudioNodeFromFileAtWorldPosition = useCallback(
    async (file: File, worldPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareAudioNodeDataFromFile(file);
        const nodeData: Partial<AudioNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle) {
          nodeData.displayName = file.name;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.audio, worldPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import audio onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle],
  );

  const createUploadImageNodeFromSourceAtWorldPosition = useCallback(
    async (
      source: string,
      worldPosition: { x: number; y: number },
      sourceFileName?: string | null,
    ): Promise<string | null> => {
      try {
        const prepared = await prepareNodeImage(source);
        const nodeData: Partial<CanvasNodeData> = {
          imageUrl: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: sourceFileName ?? null,
        };
        if (useUploadFilenameAsNodeTitle && sourceFileName) {
          nodeData.displayName = sourceFileName;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.upload, worldPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import image source onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle],
  );

  const createVideoNodeFromSourceAtWorldPosition = useCallback(
    async (
      source: string,
      worldPosition: { x: number; y: number },
      sourceFileName?: string | null,
    ): Promise<string | null> => {
      try {
        const prepared = await prepareVideoNodeDataFromSource(source, sourceFileName);
        const nodeData: Partial<VideoNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle && sourceFileName) {
          nodeData.displayName = sourceFileName;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, worldPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import video onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle],
  );

  const createAudioNodeFromSourceAtWorldPosition = useCallback(
    async (
      source: string,
      worldPosition: { x: number; y: number },
      sourceFileName?: string | null,
    ): Promise<string | null> => {
      try {
        const prepared = await prepareAudioNodeDataFromSource(source, sourceFileName);
        const nodeData: Partial<AudioNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle && sourceFileName) {
          nodeData.displayName = sourceFileName;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.audio, worldPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import audio onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle],
  );

  const createMaterialNodeFromFileAtWorldPosition = useCallback(
    async (
      file: File,
      worldPosition: { x: number; y: number },
    ): Promise<CreatedMaterialNode | null> => {
      const fileType = file.type;
      const fileName = file.name;
      if (isImageFile(file)) {
        const nodeId = await createUploadImageNodeAtWorldPosition(file, worldPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.upload } : null;
      }
      if (isVideoFile(file)) {
        const nodeId = await createVideoNodeFromFileAtWorldPosition(file, worldPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.video } : null;
      }
      if (isAudioFile(file)) {
        const nodeId = await createAudioNodeFromFileAtWorldPosition(file, worldPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.audio } : null;
      }
      console.warn('Unsupported material file dropped onto canvas', fileType, fileName);
      return null;
    },
    [
      createAudioNodeFromFileAtWorldPosition,
      createUploadImageNodeAtWorldPosition,
      createVideoNodeFromFileAtWorldPosition,
    ],
  );

  const createMaterialNodeFromSourceAtWorldPosition = useCallback(
    async (
      material: DroppedMaterialSource,
      worldPosition: { x: number; y: number },
    ): Promise<CreatedMaterialNode | null> => {
      if (material.kind === 'image') {
        const nodeId = await createUploadImageNodeFromSourceAtWorldPosition(
          material.source,
          worldPosition,
          material.fileName,
        );
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.upload } : null;
      }
      if (material.kind === 'video') {
        const nodeId = await createVideoNodeFromSourceAtWorldPosition(
          material.source,
          worldPosition,
          material.fileName,
        );
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.video } : null;
      }
      const nodeId = await createAudioNodeFromSourceAtWorldPosition(
        material.source,
        worldPosition,
        material.fileName,
      );
      return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.audio } : null;
    },
    [
      createAudioNodeFromSourceAtWorldPosition,
      createUploadImageNodeFromSourceAtWorldPosition,
      createVideoNodeFromSourceAtWorldPosition,
    ],
  );

  const createMaterialNodeFromFileAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) =>
      await createMaterialNodeFromFileAtWorldPosition(
        file,
        clientToWorldPosition(clientPosition),
      ),
    [createMaterialNodeFromFileAtWorldPosition],
  );

  // 阻止浏览器在画布外松开文件时直接打开文件
  useEffect(() => {
    const handleWindowFileDragOver = (event: DragEvent) => {
      if (!dataTransferHasExternalFilePayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          dataTransferHasMaterialFile(event.dataTransfer) ||
          dataTransferHasExternalFilePayload(event.dataTransfer)
            ? 'copy'
            : 'none';
      }
    };
    const handleWindowFileDrop = (event: DragEvent) => {
      if (!dataTransferHasExternalFilePayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('dragover', handleWindowFileDragOver, true);
    window.addEventListener('drop', handleWindowFileDrop, true);
    document.addEventListener('dragover', handleWindowFileDragOver, true);
    document.addEventListener('drop', handleWindowFileDrop, true);
    return () => {
      window.removeEventListener('dragover', handleWindowFileDragOver, true);
      window.removeEventListener('drop', handleWindowFileDrop, true);
      document.removeEventListener('dragover', handleWindowFileDragOver, true);
      document.removeEventListener('drop', handleWindowFileDrop, true);
    };
  }, []);

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!dataTransferHasExternalFilePayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      dataTransferHasMaterialFile(event.dataTransfer) ||
      dataTransferHasExternalFilePayload(event.dataTransfer)
        ? 'copy'
        : 'none';
  }, []);

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasExternalFilePayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dropPoint = clientToWorldPosition({ x: event.clientX, y: event.clientY });

      // 多文件拖入：全部导入，并按文件名自然序（1 < 2 < 10）排成网格 —— 序号顺序 = 摆放顺序
      const droppedFiles = Array.from(event.dataTransfer.files ?? []).filter(isMaterialFile);
      if (droppedFiles.length > 1) {
        droppedFiles.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
        );
        const cols = Math.min(droppedFiles.length, 6);
        const cell = DEFAULT_NODE_WIDTH + 24;
        void (async () => {
          for (let i = 0; i < droppedFiles.length; i += 1) {
            const base = {
              x: dropPoint.x + (i % cols) * cell,
              y: dropPoint.y + Math.floor(i / cols) * cell,
            };
            // 每轮读最新 nodes：既避开画布原有节点，也避开这一批刚放下的
            const free = resolveFreeNodePosition(useCanvasStore.getState().nodes, base);
            await createMaterialNodeFromFileAtWorldPosition(droppedFiles[i], free);
          }
        })();
        return;
      }

      // 单文件 / 路径拖入：落点避让后放一个
      const freePoint = resolveFreeNodePosition(useCanvasStore.getState().nodes, dropPoint);
      const materialFile = droppedFiles[0] ?? resolveDroppedMaterialFile(event.dataTransfer);
      if (!materialFile) {
        const materialSource = resolveDroppedMaterialSource(event.dataTransfer);
        if (!materialSource) {
          return;
        }
        void createMaterialNodeFromSourceAtWorldPosition(materialSource, freePoint);
        return;
      }
      void createMaterialNodeFromFileAtWorldPosition(materialFile, freePoint);
    },
    [createMaterialNodeFromFileAtWorldPosition, createMaterialNodeFromSourceAtWorldPosition],
  );

  return {
    createUploadImageNodeAtWorldPosition,
    createUploadImageNodeAtClientPosition,
    createMaterialNodeFromFileAtWorldPosition,
    createMaterialNodeFromFileAtClientPosition,
    handleCanvasDragOver,
    handleCanvasDrop,
  };
}
