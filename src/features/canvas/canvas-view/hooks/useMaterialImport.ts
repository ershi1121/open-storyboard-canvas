import { useCallback, useEffect } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  prepareNodeImage,
  prepareNodeImageFromFile,
} from '@/features/canvas/application/imageData';
import {
  dataTransferHasExternalFilePayload,
  dataTransferHasMaterialFile,
  isAudioFile,
  isImageFile,
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
  type AudioNodeData,
  type CanvasNodeData,
  type CanvasNodeType,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';

interface UseMaterialImportOptions {
  scheduleCanvasPersist: (delay?: number) => void;
}

export interface CreatedMaterialNode {
  nodeId: string;
  type: CanvasNodeType;
}

export function useMaterialImport({ scheduleCanvasPersist }: UseMaterialImportOptions) {
  const reactFlowInstance = useReactFlow();
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);

  const createUploadImageNodeAtFlowPosition = useCallback(
    async (file: File, flowPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareNodeImageFromFile(file);
        const newNodeId = addNode(CANVAS_NODE_TYPES.upload, flowPosition, {
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
    [addNode, scheduleCanvasPersist, setSelectedNode]
  );

  const createUploadImageNodeAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) => {
      await createUploadImageNodeAtFlowPosition(
        file,
        reactFlowInstance.screenToFlowPosition(clientPosition)
      );
    },
    [createUploadImageNodeAtFlowPosition, reactFlowInstance]
  );

  const createVideoNodeFromFileAtFlowPosition = useCallback(
    async (file: File, flowPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareVideoNodeDataFromFile(file);
        const nodeData: Partial<VideoNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle) {
          nodeData.displayName = file.name;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, flowPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import video onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle]
  );

  const createAudioNodeFromFileAtFlowPosition = useCallback(
    async (file: File, flowPosition: { x: number; y: number }): Promise<string | null> => {
      try {
        const prepared = await prepareAudioNodeDataFromFile(file);
        const nodeData: Partial<AudioNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle) {
          nodeData.displayName = file.name;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.audio, flowPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import audio onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle]
  );

  const createUploadImageNodeFromSourceAtFlowPosition = useCallback(
    async (
      source: string,
      flowPosition: { x: number; y: number },
      sourceFileName?: string | null
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
        const newNodeId = addNode(CANVAS_NODE_TYPES.upload, flowPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import image source onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle]
  );

  const createVideoNodeFromSourceAtFlowPosition = useCallback(
    async (
      source: string,
      flowPosition: { x: number; y: number },
      sourceFileName?: string | null
    ): Promise<string | null> => {
      try {
        const prepared = await prepareVideoNodeDataFromSource(source, sourceFileName);
        const nodeData: Partial<VideoNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle && sourceFileName) {
          nodeData.displayName = sourceFileName;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, flowPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import video source onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle]
  );

  const createAudioNodeFromSourceAtFlowPosition = useCallback(
    async (
      source: string,
      flowPosition: { x: number; y: number },
      sourceFileName?: string | null
    ): Promise<string | null> => {
      try {
        const prepared = await prepareAudioNodeDataFromSource(source, sourceFileName);
        const nodeData: Partial<AudioNodeData> = { ...prepared };
        if (useUploadFilenameAsNodeTitle && sourceFileName) {
          nodeData.displayName = sourceFileName;
        }
        const newNodeId = addNode(CANVAS_NODE_TYPES.audio, flowPosition, nodeData);
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import audio source onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, useUploadFilenameAsNodeTitle]
  );

  const createMaterialNodeFromFileAtFlowPosition = useCallback(
    async (
      file: File,
      flowPosition: { x: number; y: number }
    ): Promise<CreatedMaterialNode | null> => {
      const fileType = file.type;
      const fileName = file.name;
      if (isImageFile(file)) {
        const nodeId = await createUploadImageNodeAtFlowPosition(file, flowPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.upload } : null;
      }
      if (isVideoFile(file)) {
        const nodeId = await createVideoNodeFromFileAtFlowPosition(file, flowPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.video } : null;
      }
      if (isAudioFile(file)) {
        const nodeId = await createAudioNodeFromFileAtFlowPosition(file, flowPosition);
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.audio } : null;
      }
      console.warn('Unsupported material file dropped onto canvas', fileType, fileName);
      return null;
    },
    [
      createAudioNodeFromFileAtFlowPosition,
      createUploadImageNodeAtFlowPosition,
      createVideoNodeFromFileAtFlowPosition,
    ]
  );

  const createMaterialNodeFromSourceAtFlowPosition = useCallback(
    async (
      material: DroppedMaterialSource,
      flowPosition: { x: number; y: number }
    ): Promise<CreatedMaterialNode | null> => {
      if (material.kind === 'image') {
        const nodeId = await createUploadImageNodeFromSourceAtFlowPosition(
          material.source,
          flowPosition,
          material.fileName
        );
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.upload } : null;
      }
      if (material.kind === 'video') {
        const nodeId = await createVideoNodeFromSourceAtFlowPosition(
          material.source,
          flowPosition,
          material.fileName
        );
        return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.video } : null;
      }
      const nodeId = await createAudioNodeFromSourceAtFlowPosition(
        material.source,
        flowPosition,
        material.fileName
      );
      return nodeId ? { nodeId, type: CANVAS_NODE_TYPES.audio } : null;
    },
    [
      createAudioNodeFromSourceAtFlowPosition,
      createUploadImageNodeFromSourceAtFlowPosition,
      createVideoNodeFromSourceAtFlowPosition,
    ]
  );

  const createMaterialNodeFromFileAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) => (
      await createMaterialNodeFromFileAtFlowPosition(
        file,
        reactFlowInstance.screenToFlowPosition(clientPosition)
      )
    ),
    [createMaterialNodeFromFileAtFlowPosition, reactFlowInstance]
  );

  // 阻止浏览器在画布外松开文件时直接打开文件
  useEffect(() => {
    const handleWindowFileDragOver = (event: DragEvent) => {
      if (!dataTransferHasExternalFilePayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = (
          dataTransferHasMaterialFile(event.dataTransfer)
          || dataTransferHasExternalFilePayload(event.dataTransfer)
        )
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
    event.dataTransfer.dropEffect = (
      dataTransferHasMaterialFile(event.dataTransfer)
      || dataTransferHasExternalFilePayload(event.dataTransfer)
    )
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
      const materialFile = resolveDroppedMaterialFile(event.dataTransfer);
      if (!materialFile) {
        const materialSource = resolveDroppedMaterialSource(event.dataTransfer);
        if (!materialSource) {
          return;
        }
        void createMaterialNodeFromSourceAtFlowPosition(
          materialSource,
          reactFlowInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          })
        );
        return;
      }
      void createMaterialNodeFromFileAtClientPosition(materialFile, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [
      createMaterialNodeFromFileAtClientPosition,
      createMaterialNodeFromSourceAtFlowPosition,
      reactFlowInstance,
    ]
  );

  return {
    createUploadImageNodeAtFlowPosition,
    createUploadImageNodeAtClientPosition,
    createMaterialNodeFromFileAtFlowPosition,
    createMaterialNodeFromFileAtClientPosition,
    handleCanvasDragOver,
    handleCanvasDrop,
  };
}