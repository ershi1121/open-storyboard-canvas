import { lazy, Suspense, useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  NODE_TOOL_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import { applyStripReorder } from './tool-editors/imageOrder';
import {
  canvasEventBus,
  canvasToolProcessor,
} from '@/features/canvas/application/canvasServices';
import { prepareNodeImage, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { readStoryboardImageMetadata } from '@/commands/image';
import { getToolPlugin, type ToolOptions } from '@/features/canvas/tools';
import {
  readBorderOptions,
  toBorderToolOptions,
} from '@/features/canvas/tools/border';
import {
  readAutoCropOptions,
  toAutoCropToolOptions,
} from '@/features/canvas/tools/autoCrop';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiButton, UiModal } from '@/components/ui';
import { UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { FormToolEditor } from './tool-editors/FormToolEditor';
import { CropToolEditor } from './tool-editors/CropToolEditor';
// Lazy-load the Konva-heavy annotate editor (~300 KB minified). It's
// only mounted when the user opens the annotation tool dialog, so
// there's no value in shipping it on cold start.
const AnnotateToolEditor = lazy(() =>
  import('./tool-editors/AnnotateToolEditor').then((m) => ({ default: m.AnnotateToolEditor })),
);
import { SplitStoryboardToolEditor } from './tool-editors/SplitStoryboardToolEditor';
import { MaskToolEditor } from './tool-editors/MaskToolEditor';
import {
  CROP_TOOL_STATE_KEY,
  buildCropToolStatePatch,
  mergeToolOptions,
  readCropToolState,
} from '@/features/canvas/tools/border/cropToolState';
import {
  TEXT_LAYERS_KEY,
  buildTextLayersPatch,
  readTextLayers,
} from '@/features/canvas/tools/text';

export function NodeToolDialog() {
  const { t } = useTranslation();
  const activeToolDialog = useCanvasStore((state) => state.activeToolDialog);
  const nodes = useCanvasStore((state) => state.nodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addStoryboardSplitNode = useCanvasStore((state) => state.addStoryboardSplitNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ToolOptions>({});
  const [isSplitImageReady, setIsSplitImageReady] = useState(true);
  const [displayToolDialog, setDisplayToolDialog] = useState(activeToolDialog);
  // 批量套用进行中：缩略图条上的按钮要禁用。
  const [isBatchApplying, setIsBatchApplying] = useState(false);
  /**
   * 批量套用刚完成时的短暂反馈（套用了几张）。
   *
   * ⚠️ 批量套用现在**只写参数、不落图**，界面上不会有任何可见变化 ——
   * 没有这个反馈，用户点完会以为「点了没反应」。
   */
  const [batchAppliedCount, setBatchAppliedCount] = useState<number | null>(null);
  const batchAppliedTimerRef = useRef<number | null>(null);
  // 上次写到 sourceNode 的 cropToolState 序列化结果 —— 用来防 options → cropToolState → sourceNode → options 的回环。
  // 用 ref 而非 state：写到 sourceNode 这件事不应该触发 React 重渲染。
  const lastWrittenCropStateRef = useRef<string | null>(null);
  // 文字图层同理：每张图存一份自己的图层参数（写在共享字段 textLayers 上，
  // 和 cropToolState 是两回事，不能混）。
  const lastWrittenTextLayersRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeToolDialog) {
      setDisplayToolDialog(activeToolDialog);
      return;
    }

    const timer = setTimeout(() => {
      setDisplayToolDialog(null);
    }, UI_DIALOG_TRANSITION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [activeToolDialog]);

  const sourceNode = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return nodes.find((node) => node.id === displayToolDialog.nodeId) ?? null;
  }, [displayToolDialog, nodes]);

  const sourceImageUrl = useMemo(() => {
    if (!sourceNode) {
      return null;
    }

    if (isUploadNode(sourceNode) || isImageEditNode(sourceNode) || isExportImageNode(sourceNode)) {
      return sourceNode.data.imageUrl;
    }

    return null;
  }, [sourceNode]);

  const activePlugin = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return getToolPlugin(displayToolDialog.toolType);
  }, [displayToolDialog]);

  const dialogKey = displayToolDialog
    ? `${displayToolDialog.nodeId}:${displayToolDialog.toolType}`
    : null;

  useEffect(() => {
    if (!sourceNode || !activePlugin) {
      return;
    }

    let cancelled = false;
    setError(null);
    // Tool plugins ship a default options bag (e.g. splitStoryboard ships
    // 3x3). When the dialog is opened with explicit overrides — typically
    // from GridSplitPanel after the user picked 2x2 / 4x4 / a custom
    // grid — merge those on top so the dialog opens already pointing at
    // the user's choice instead of the plugin default.
    const baseOptions = activePlugin.createInitialOptions(sourceNode);
    const initialOptions: ToolOptions = displayToolDialog?.initialOptionsOverride
      ? ({ ...baseOptions, ...displayToolDialog.initialOptionsOverride } as ToolOptions)
      : baseOptions;
    setOptions(initialOptions);

    if (activePlugin.editor !== 'split' || !sourceImageUrl) {
      return () => {
        cancelled = true;
      };
    }

    // For split-storyboard, the source image may carry embedded metadata
    // about the grid it was generated from. If the caller passed an
    // explicit override (the user just clicked a grid preset) we honor
    // that — overrides win over metadata. Otherwise fall back to the
    // metadata so reopening a previously-split image lands on its
    // original grid.
    if (displayToolDialog?.initialOptionsOverride) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const metadata = await readStoryboardImageMetadata(sourceImageUrl);
        if (!metadata || cancelled) {
          return;
        }

        const nextRows = Math.max(1, Math.min(8, Math.floor(metadata.gridRows)));
        const nextCols = Math.max(1, Math.min(8, Math.floor(metadata.gridCols)));
        if (!Number.isFinite(nextRows) || !Number.isFinite(nextCols)) {
          return;
        }

        setOptions((previous) => ({
          ...previous,
          rows: nextRows,
          cols: nextCols,
        }));
      } catch (error) {
        console.warn('[StoryboardMetadata] read failed on split dialog init', error);
      }
    })();

    return () => {
      cancelled = true;
    };
    // 依赖用 sourceNode.id 而不是 sourceNode 引用本身：
    // 否则下面把 cropToolState 写回 sourceNode 会让 sourceNode 引用变化，
    // 触发这个 effect 跑 setOptions，把正在拖的滑杆重置到上次存档值。
  }, [dialogKey, sourceNode?.id, activePlugin, sourceImageUrl, displayToolDialog?.initialOptionsOverride]);

  useEffect(() => {
    const requiresSplitPreload = activePlugin?.editor === 'split' && Boolean(sourceImageUrl);
    if (!requiresSplitPreload || !sourceImageUrl) {
      setIsSplitImageReady(true);
      return;
    }

    let cancelled = false;
    const image = new Image();
    const displayImageUrl = resolveImageDisplayUrl(sourceImageUrl);

    setIsSplitImageReady(false);

    image.onload = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.onerror = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.src = displayImageUrl;
    if (image.complete) {
      setIsSplitImageReady(true);
    }

    return () => {
      cancelled = true;
    };
  }, [activePlugin?.editor, sourceImageUrl]);

  /**
   * 把当前 CropToolEditor 的 options 写回 sourceNode.data.cropToolState —— 让每张图
   * 都存档自己的边框/裁剪参数，下次打开裁剪面板能看到自己之前调好的状态。
   *
   * 用 ref + JSON.stringify 做内容比较，避免反复写入造成 useEffect 反复触发
   * （sourceNode 引用变化会触发上面的初始化 effect，把正在拖的滑杆重置到上次存档值）。
   *
   * 只对 crop 工具执行 —— 其他工具（标注 / 切割 / 高清等）有自己的存档字段，
   * 写到这里会污染它们的 data。
   */
  useEffect(() => {
    if (!sourceNode || !sourceImageUrl) {
      return;
    }
    if (activePlugin?.type !== NODE_TOOL_TYPES.crop) {
      return;
    }

    const patch = buildCropToolStatePatch(options);
    const serialized = JSON.stringify(patch[CROP_TOOL_STATE_KEY]);
    if (serialized === lastWrittenCropStateRef.current) {
      return;
    }
    lastWrittenCropStateRef.current = serialized;
    updateNodeData(sourceNode.id, patch);
  }, [options, sourceNode?.id, sourceImageUrl, activePlugin?.type, updateNodeData]);

  /**
   * 文字参数写回 sourceNode.data.textLayers —— 这是裁剪面板里「文字」区块的唯一存档。
   *
   * ⚠️ 它**必须**和 cropToolState 分开写：createInitialOptions 里 `textLayers`
   * 是刻意以这个共享字段为准的（防止 cropToolState 里的旧副本复活），
   * 只写 cropToolState 的话，下次打开面板文字会整段消失。
   *
   * 存的只是图层参数（文字 / 位置 / 字体 / 颜色…），不含该图的编号 ——
   * 编号由这张图在画布里的位置决定，写死了反而会在换图 / 调顺序后错位。
   */
  useEffect(() => {
    if (!sourceNode || !sourceImageUrl) {
      return;
    }
    const toolType = activePlugin?.type;
    if (toolType !== NODE_TOOL_TYPES.crop) {
      return;
    }

    const raw = options[TEXT_LAYERS_KEY];
    if (typeof raw !== 'string') {
      return;
    }
    if (raw === lastWrittenTextLayersRef.current) {
      return;
    }
    lastWrittenTextLayersRef.current = raw;
    updateNodeData(sourceNode.id, buildTextLayersPatch(readTextLayers(raw)));
  }, [options, sourceNode?.id, sourceImageUrl, activePlugin?.type, updateNodeData]);

  const closeDialog = useCallback(() => {
    canvasEventBus.publish('tool-dialog/close', undefined);
  }, []);

  const isAsyncAiEditTool = useCallback((toolType: NodeToolType | undefined) => (
    toolType === NODE_TOOL_TYPES.hd
    || toolType === NODE_TOOL_TYPES.outpainting
    || toolType === NODE_TOOL_TYPES.inpainting
    || toolType === NODE_TOOL_TYPES.erase
    || toolType === NODE_TOOL_TYPES.matting
  ), []);

  const resolveToolLabel = useCallback((toolType: NodeToolType | undefined) => {
    if (!toolType) {
      return '';
    }
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    if (toolType === NODE_TOOL_TYPES.hd) {
      return '高清';
    }
    if (toolType === NODE_TOOL_TYPES.outpainting) {
      return '扩图';
    }
    if (toolType === NODE_TOOL_TYPES.inpainting) {
      return '重绘';
    }
    if (toolType === NODE_TOOL_TYPES.erase) {
      return '擦除';
    }
    if (toolType === NODE_TOOL_TYPES.matting) {
      return '抠图';
    }
    return '';
  }, [t]);
  const resolveResultNodeTitle = useCallback((toolType: NodeToolType | undefined) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('toolDialog.cropResultTitle');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('toolDialog.annotateResultTitle');
    }
    if (toolType === NODE_TOOL_TYPES.hd) {
      return '高清结果';
    }
    if (toolType === NODE_TOOL_TYPES.outpainting) {
      return '扩图结果';
    }
    if (toolType === NODE_TOOL_TYPES.inpainting) {
      return '重绘结果';
    }
    if (toolType === NODE_TOOL_TYPES.erase) {
      return '擦除结果';
    }
    if (toolType === NODE_TOOL_TYPES.matting) {
      return '抠图结果';
    }
    return EXPORT_RESULT_DISPLAY_NAME.generic;
  }, [t]);

  /**
   * 用户拖动缩略图条自定义的图片顺序（图片节点 id）。
   *
   * `null` = 还没拖过，按画布顺序（nodes 数组）走。
   * ⚠️ 它**同时决定文字里的「图像1 / 图像2…」** —— 拖动条就是在改编号分配，
   * 所以这个顺序必须是全局的（覆盖画布上所有图片节点），不能只当条里的显示顺序。
   */
  const [imageOrderOverride, setImageOrderOverride] = useState<string[] | null>(null);

  /** 画布上「有图的图片节点」id，按画布顺序。 */
  const canvasImageIds = useMemo(
    () =>
      nodes
        .filter(
          (node) =>
            (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) &&
            Boolean(node.data.imageUrl)
        )
        .map((node) => node.id),
    [nodes]
  );

  /**
   * 有效图片顺序 = 用户拖过的顺序（滤掉已删除的节点）+ 后来新增的图追加到末尾。
   *
   * 新增的图没法猜用户想把它插在哪，追加到末尾最不打扰用户已经拖好的排列
   * （条里也是按这个顺序排的，插到中间会让已排好的图整体错位）。
   */
  const orderedImageIds = useMemo(() => {
    if (!imageOrderOverride) {
      return canvasImageIds;
    }
    const existing = new Set(canvasImageIds);
    const kept = imageOrderOverride.filter((id) => existing.has(id));
    const keptSet = new Set(kept);
    return [...kept, ...canvasImageIds.filter((id) => !keptSet.has(id))];
  }, [canvasImageIds, imageOrderOverride]);

  /**
   * 画布图片节点 → 它在**有效图片顺序**里的 0-based 下标。
   *
   * ⚠️ 这个下标**不是文字编号**（编号 = 该图在选择条里排第几，见 CropToolEditor）。
   * 它只负责两件事：
   *  1. 决定选择条里谁在前谁在后（条按它排序）；
   *  2. 拖动条时算出该往全局顺序的哪个槽位写回。
   * 换句话说它是**排序键**，条一重排它跟着变，编号才跟着变。
   */
  const imageOrderIndexById = useMemo(() => {
    const map = new Map<string, number>();
    orderedImageIds.forEach((id, index) => map.set(id, index));
    return map;
  }, [orderedImageIds]);

  /**
   * 条里拖动排序 → 写进全局图片顺序。
   *
   * ⚠️ 条里只显示「当前图 ∪ 队列」这个**子集**，不能拿它直接当全局顺序 ——
   * 槽位映射的细节见 `tool-editors/imageOrder.ts`（纯函数，有单测兜着）。
   *
   * ⭐ 改完之后条里按新的 orderIndex 重排 → 条内位置变了 → 角标和文字编号
   * 立刻跟着变（不需要点「应用」，也不会碰画布上的图）。
   */
  const handleReorderStripItems = useCallback(
    (stripOrder: string[]) => {
      setImageOrderOverride(applyStripReorder(orderedImageIds, stripOrder));
    },
    [orderedImageIds]
  );

  /**
   * 裁剪面板「添加图片」候选清单的数据源：画布上全部图片节点（含当前节点），
   * 顺序 = 画布顺序。
   *
   * ⚠️ 它**只是候选清单，不会默认渲染**。
   * 选择条默认只画「当前图 + 用户手动加入的图」，这份清单仅在用户点开
   * 「添加图片」面板时才铺缩略图 —— 否则几十上百张图一起渲染会明显卡顿。
   *
   * 缩略图用 `previewImageUrl`（小图）而不是 `imageUrl`（原图）：
   * 候选面板一次要渲染整张画布的图，拿原图会白吃一大截内存和解码时间。
   *
   * 每项带 orderIndex —— 它只用来给选择条排序（条里谁在前），
   * 编号徽章和文字编号读的都是「条内位置」，不是它。
   */
  const canvasImageCandidates = useMemo(() => {
    if (!displayToolDialog) {
      return [] as Array<{
        id: string;
        label: string;
        imageUrl: string;
        width?: number | null;
        height?: number | null;
        orderIndex?: number;
      }>;
    }
    // 顺序取 orderedImageIds —— 用户拖过顺序之后，条里和候选弹窗都跟着新顺序排。
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return orderedImageIds
      .map((id) => nodeById.get(id))
      .filter((node): node is CanvasNode => Boolean(node))
      .map((node) => ({
        id: node.id,
        label:
          typeof node.data.label === 'string' && node.data.label.trim()
            ? node.data.label
            : '未命名图片',
        // 缩略图优先用小图；没有 previewImageUrl 的老节点才退回原图。
        imageUrl: (node.data.previewImageUrl as string | null | undefined) ?? (node.data.imageUrl as string),
        width: null,
        height: null,
        orderIndex: imageOrderIndexById.get(node.id),
      }));
  }, [displayToolDialog, imageOrderIndexById, nodes, orderedImageIds]);

  /**
   * 把当前编辑器里的参数**分发**到指定图片节点（不含当前图 —— 当前图走 footer 的「应用」路径）。
   *
   * ⭐ **只落参数，绝不落图**（裁剪 / 边框 / 文字一视同仁）。
   * 「批量应用」的定位是**让用户逐张切过去预览检查**，
   * **只有点右下角「应用」才算保存**。
   *
   * ⚠️ 早先这里对文字会真的重画一遍 imageUrl（原地烘焙 + 底图备份）——
   * 用户还没点应用，画布上那张图就已经变了，等于把「预览」当成了「保存」。
   * 现在文字和边框一样只写参数存档：切过去在裁剪面板预览里就能看到效果，
   * 点「应用」才真正落图。
   *
   * ⭐ 参数分两摞 —— 「批量套用」只推**共享规则**，保留每张图**各自的微调**：
   *  - 共享（写进目标图）：边框 / 描边 / 圆角 / 按比例补边（含留白）/ 文字图层 /
   *    自动裁剪规则（开关·识别色·参与边·保留边距）。
   *  - 各自（绝不覆盖）：每张图自己的目标比例、自定义比例、手动裁剪框 cropX/Y/W/H。
   *    自动裁剪的「结果」按每张图自己的像素现场重算 —— 所以推了规则，边界仍旧各自匹配。
   *
   * ⚠️ 文字编号（`textOrderIndex`）**必须一起套**：它来自 `textOrderIndexById`
   * （条内 0-based 位置），是「预览」的一部分 —— 用户切过去要看到自己排第几。
   * 而且面板一关条就没了，目标图只能靠这份存下来的编号记住自己的位置，
   * 否则逐张点「应用」时全都会退回 1。
   */
  const handleApplyBatch = useCallback(
    async (otherTargetIds: string[], textOrderIndexById?: Map<string, number>) => {
      setIsBatchApplying(true);
      try {
        // 只推共享规则（边框 / 补边 / 文字 / 自动裁剪）；裁剪框与目标比例留给每张图自己。
        const border = readBorderOptions(options);
        const autoCrop = readAutoCropOptions(options);
        const textLayersRaw = options[TEXT_LAYERS_KEY];
        const sharedOptions: ToolOptions = {
          ...toBorderToolOptions(border),
          ...toAutoCropToolOptions(autoCrop),
          ...(typeof textLayersRaw === 'string' ? { [TEXT_LAYERS_KEY]: textLayersRaw } : {}),
        };

        for (const targetId of otherTargetIds) {
          const target = nodes.find((node) => node.id === targetId);
          if (!target) {
            continue;
          }
          // 编号和共享规则合成一份「要覆盖的键」，再**盖到目标图已有的 cropToolState 上**：
          // existing 打底 → 目标图自己的裁剪框 / 目标比例这些没被 shared 提到的键原样保留。
          // 一次写进 cropToolState（整块替换该字段），避免分两次写互相抹掉。
          const orderIndex = textOrderIndexById?.get(targetId);
          const shared: ToolOptions =
            typeof orderIndex === 'number'
              ? { ...sharedOptions, textOrderIndex: orderIndex }
              : sharedOptions;
          const merged = mergeToolOptions(readCropToolState(target), shared);
          updateNodeData(targetId, buildCropToolStatePatch(merged));
          // ⚠️ 文字参数必须**另外**写一份到共享字段。
          // createInitialOptions 里 `[TEXT_LAYERS_KEY]` 是以节点上的共享字段为准的
          // （cropToolState 里那份会被盖掉，防止旧副本复活），所以只写 cropToolState
          // 的话，目标图重新打开面板会看到边框还在、文字却没了 —— 用户就没法再调整。
          updateNodeData(targetId, buildTextLayersPatch(readTextLayers(merged[TEXT_LAYERS_KEY])));
        }

        // 只写参数不落图，界面上不会有别的变化 —— 给个短暂反馈，
        // 否则用户点完会以为「点了没反应」。
        setBatchAppliedCount(otherTargetIds.length);
        if (batchAppliedTimerRef.current !== null) {
          window.clearTimeout(batchAppliedTimerRef.current);
        }
        batchAppliedTimerRef.current = window.setTimeout(() => {
          setBatchAppliedCount(null);
        }, 2200);
      } catch (applyError) {
        const message =
          applyError instanceof Error ? applyError.message : t('toolDialog.processFailed');
        // 不开模态对话框：错误先写日志，UI 留给后续补"行内错误条"。
        // 当前最关键的是套用逻辑打通；视觉提示缺失不会破坏主流程。
        console.error('[NodeToolDialog] batch apply failed', message);
      } finally {
        setIsBatchApplying(false);
      }
    },
    [nodes, options, updateNodeData, t]
  );

  // 卸载时清掉批量套用的反馈定时器。
  useEffect(
    () => () => {
      if (batchAppliedTimerRef.current !== null) {
        window.clearTimeout(batchAppliedTimerRef.current);
      }
    },
    []
  );

  const handleApply = useCallback(async () => {
    if (!activeToolDialog || !sourceNode || !sourceImageUrl || !activePlugin) {
      setError(t('toolDialog.noProcessableImage'));
      return;
    }

    setIsProcessing(true);
    setError(null);

    if (isAsyncAiEditTool(activeToolDialog.toolType)) {
      const newNodePosition = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const newNodeId = addNode(CANVAS_NODE_TYPES.exportImage, newNodePosition, {
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio: sourceNode.data.aspectRatio ?? '1:1',
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationDurationMs: 60000,
        resultKind: 'generic',
        displayName: resolveResultNodeTitle(activeToolDialog.toolType),
      });
      addEdge(sourceNode.id, newNodeId);
      closeDialog();
      setIsProcessing(false);

      void (async () => {
        try {
          const result = await activePlugin.execute(sourceImageUrl, options, {
            processTool: (toolType, imageUrl, toolOptions) =>
              canvasToolProcessor.process(toolType, imageUrl, toolOptions),
          });

          if (!result.outputImageUrl) {
            throw new Error(t('toolDialog.processFailed'));
          }

          const prepared = await prepareNodeImage(result.outputImageUrl);
          updateNodeData(newNodeId, {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            aspectRatio: prepared.aspectRatio,
            isGenerating: false,
            generationStartedAt: null,
            generationJobId: null,
            generationProviderId: null,
            generationClientSessionId: null,
            generationError: null,
            generationErrorDetails: null,
          });
        } catch (processError) {
          updateNodeData(newNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationJobId: null,
            generationProviderId: null,
            generationClientSessionId: null,
            generationError: processError instanceof Error ? processError.message : t('toolDialog.processFailed'),
            generationErrorDetails: null,
          });
        }
      })();
      return;
    }

    try {
      // 裁剪工具现在也会叠文字（裁剪 → 边框 → 文字）。
      //
      // ⚠️ 编号（{n}）**不在这里算** —— 裁剪面板已经把 `options.textOrderIndex` 同步成
      // 「这张图在选择条里排第几」，这里原样透传。之所以不能在这儿算：队列是裁剪面板的
      // 内部状态，这一层只能拿到「画布第几张」，算出来就是用户抱怨的 5,6,7,8,17。
      const executeOptions: ToolOptions = options;

      const result = await activePlugin.execute(sourceImageUrl, executeOptions, {
        processTool: (toolType, imageUrl, toolOptions) =>
          canvasToolProcessor.process(toolType, imageUrl, toolOptions),
      });

      if (result.storyboardFrames && result.rows && result.cols) {
        const createdNodeId = addStoryboardSplitNode(
          sourceNode.id,
          result.rows,
          result.cols,
          result.storyboardFrames,
          result.frameAspectRatio
        );
        if (createdNodeId) {
          addEdge(sourceNode.id, createdNodeId);
        }
      } else if (result.outputImageUrl) {
        const prepared = await prepareNodeImage(result.outputImageUrl);
        const createdNodeId = addDerivedExportNode(
          sourceNode.id,
          prepared.imageUrl,
          prepared.aspectRatio,
          prepared.previewImageUrl,
          {
            defaultTitle: resolveResultNodeTitle(activeToolDialog.toolType),
            resultKind: 'generic',
            aspectRatioStrategy: 'provided',
            sizeStrategy: 'autoMinEdge',
          }
        );
        if (createdNodeId) {
          addEdge(sourceNode.id, createdNodeId);
        }
      }

      closeDialog();
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : t('toolDialog.processFailed'));
    } finally {
      setIsProcessing(false);
    }
  }, [
    activeToolDialog,
    sourceNode,
    sourceImageUrl,
    activePlugin,
    options,
    addNode,
    addStoryboardSplitNode,
    addDerivedExportNode,
    addEdge,
    findNodePosition,
    updateNodeData,
    closeDialog,
    isAsyncAiEditTool,
    resolveResultNodeTitle,
    t,
  ]);

  const widthClassName = useMemo(() => {
    if (!activePlugin) {
      return 'w-[min(460px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'crop') {
      // 裁剪面板是左右分栏（左侧输出预览 / 右侧裁剪+边框参数），比其它工具宽不少。
      return 'w-[min(1440px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'annotate') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'split') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    return 'w-[min(460px,calc(100vw-40px))]';
  }, [activePlugin]);

  const editorContent = useMemo(() => {
    if (!activePlugin) {
      return null;
    }

    if (activePlugin.editor === 'crop' && sourceImageUrl) {
      // 切换当前节点：复用 tool-dialog/open 事件 + 同一个 toolType —— 等价于
      // "关掉当前对话框、打开另一张图的同名工具"。CreateInitialOptions 会从
      // 目标节点的 cropToolState 读出该图自己的边框参数，互不污染。
      const handleSwitchTarget = (targetId: string) => {
        if (!displayToolDialog) {
          return;
        }
        canvasEventBus.publish('tool-dialog/open', {
          nodeId: targetId,
          toolType: displayToolDialog.toolType,
        });
      };

      return (
        <CropToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
          onSwitchTarget={handleSwitchTarget}
          onApplyBatch={handleApplyBatch}
          onReorderImages={handleReorderStripItems}
          batchAppliedCount={batchAppliedCount}
          canvasImages={canvasImageCandidates}
          currentNodeId={displayToolDialog?.nodeId}
          currentOrderIndex={
            displayToolDialog ? imageOrderIndexById.get(displayToolDialog.nodeId) : undefined
          }
          isBatchApplying={isBatchApplying}
        />
      );
    }

    if (activePlugin.editor === 'annotate' && sourceImageUrl) {
      return (
        <Suspense fallback={<div className="p-6 text-sm text-white/60">正在加载标注编辑器…</div>}>
          <AnnotateToolEditor
            plugin={activePlugin}
            sourceImageUrl={sourceImageUrl}
            options={options}
            onOptionsChange={setOptions}
          />
        </Suspense>
      );
    }

    if (activePlugin.editor === 'split' && sourceImageUrl) {
      return (
        <SplitStoryboardToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    if (activePlugin.editor === 'mask' && sourceImageUrl) {
      return (
        <MaskToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    return (
      <FormToolEditor
        plugin={activePlugin}
        fields={activePlugin.fields}
        options={options}
        onOptionsChange={setOptions}
      />
    );
  }, [
    activePlugin,
    options,
    sourceImageUrl,
    displayToolDialog,
    canvasImageCandidates,
    handleApplyBatch,
    handleReorderStripItems,
    isBatchApplying,
    imageOrderIndexById,
  ]);

  const isOpen = Boolean(activeToolDialog && isSplitImageReady);

  return (
    <>
    <UiModal
      isOpen={isOpen}
      title={`${resolveToolLabel(activePlugin?.type)}${t('toolDialog.suffix')}`}
      onClose={closeDialog}
      widthClassName={widthClassName}
      footer={
        <>
          <UiButton variant="ghost" size="sm" onClick={closeDialog}>
            {t('common.cancel')}
          </UiButton>
          <UiButton size="sm" variant="primary" onClick={handleApply} disabled={isProcessing || !sourceImageUrl}>
            {isProcessing ? t('toolDialog.processing') : t('toolDialog.apply')}
          </UiButton>
        </>
      }
    >
      <div className="space-y-3 max-h-[82vh] overflow-y-auto pr-1">
        {editorContent}
        {error && <div className="text-xs text-red-300">{error}</div>}
      </div>
    </UiModal>
    </>
  );
}
