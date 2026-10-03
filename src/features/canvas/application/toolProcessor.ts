import {
  NODE_TOOL_TYPES,
  type NodeToolType,
  type StoryboardFrameItem,
} from '../domain/canvasNodes';
import {
  canvasToDataUrl,
  detectAspectRatio,
  imageUrlToDataUrl,
  loadImageElement,
  parseAspectRatio,
  persistImageLocally,
} from './imageData';
import { cropImageSource, readStoryboardImageMetadata } from '@/commands/image';
import { drawAnnotations, parseAnnotationItems } from '../tools/annotation';
import {
  measureAutoCrop,
  readAutoCropOptions,
  readCropRect,
  resolveEffectiveCropRect,
  type CropRect,
} from '../tools/autoCrop';
import {
  drawImageWithBorder,
  isBorderNoop,
  readBorderOptions,
  resolveBorderGeometry,
} from '../tools/border';
import { drawTextLayersFromOptions } from '../tools/text';
import type {
  AiGateway,
  IdGenerator,
  ImageSplitGateway,
  ToolProcessor,
  ToolProcessorResult,
} from './ports';
import { applyTemplate } from './panelPromptBuilders';
import {
  resolvePromptTemplateText,
  type PromptTemplateId,
  type PromptTemplateSettingsSnapshot,
} from './promptTemplates';

function renderToolPrompt(
  id: PromptTemplateId,
  settings: PromptTemplateSettingsSnapshot,
  values: Record<string, string> = {}
): string {
  return applyTemplate(resolvePromptTemplateText(id, settings), values);
}

export class CanvasToolProcessor implements ToolProcessor {
  constructor(
    private readonly splitGateway: ImageSplitGateway,
    private readonly idGenerator: IdGenerator,
    private readonly aiGateway?: AiGateway
  ) {}

  async process(
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ): Promise<ToolProcessorResult> {
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      const metadata = await this.readStoryboardMetadata(sourceImageUrl);
      return await this.splitStoryboard(
        sourceImageUrl,
        Number(options.rows ?? metadata?.gridRows ?? 3),
        Number(options.cols ?? metadata?.gridCols ?? 3),
        Number(options.lineThicknessPercent),
        Number(options.lineThickness ?? 0),
        metadata?.frameNotes
      );
    }

    switch (toolType) {
      case NODE_TOOL_TYPES.crop:
        // 顺序固定：先裁剪 → 再补边 / 描边 / 圆角 → 最后叠文字。
        // 文字的位置百分比是相对「最终画幅」的，和裁剪面板预览里看到的一致。
        return {
          outputImageUrl: await this.applyTextLayersToImage(
            await this.applyBorderToImage(await this.cropImage(sourceImageUrl, options), options),
            options
          ),
        };
      case NODE_TOOL_TYPES.annotate:
        // Keep annotate on frontend for now because it supports free-form vector annotations.
        // Prefer local source first to avoid CORS taint and repeated remote fetches.
        return {
          outputImageUrl: await this.annotateImage(
            await persistImageLocally(sourceImageUrl),
            options
          ),
        };
      case NODE_TOOL_TYPES.hd:
      case NODE_TOOL_TYPES.outpainting:
      case NODE_TOOL_TYPES.inpainting:
      case NODE_TOOL_TYPES.erase:
      case NODE_TOOL_TYPES.matting:
        return {
          outputImageUrl: await this.runAiEditTool(toolType, sourceImageUrl, options),
        };
      default:
        throw new Error('不支持的工具类型');
    }
  }

  /**
   * Route the five AI edit tools through the shared canvas gateway. Uses the
   * last-used AI image model from settings (the one the ImageEditNode / panel
   * pickers last committed) so the user gets the same routing as a normal
   * generation call.
   */
  private async runAiEditTool(
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ): Promise<string> {
    if (!this.aiGateway) {
      throw new Error('未注入 AI gateway — 请重启应用');
    }
    const { useSettingsStore } = await import('@/stores/settingsStore');
    const settings = useSettingsStore.getState();
    const lastConfig = settings.lastModelConfigByPanel?.edit
      ?? settings.lastModelConfigByPanel?.multiFunction
      ?? settings.lastModelConfigByPanel?.multiAngle
      ?? null;
    // Prefer the user's last Edit-panel model pick; fall back to any other
    // panel's last choice; else bail with a helpful error.
    const entryId = lastConfig?.entryId ?? null;
    if (!entryId) {
      throw new Error('请先在「编辑」面板右上角的「配置模型」里选一个模型。');
    }
    // The model id shape is `builtin:<id>` | `custom:...` | `dreamina:...`.
    // The gateway expects a plain model id for builtin (strip the prefix) but
    // the compound id for custom/dreamina.
    const model = entryId.startsWith('builtin:') ? entryId.slice('builtin:'.length) : entryId;
    const ratio = lastConfig?.ratio ?? 'auto';

    // HD runs a dedicated 2-pass pipeline (lineart → composite); the other
    // AI edit tools share the single-pass path below.
    if (toolType === NODE_TOOL_TYPES.hd) {
      const userHint = String(options.prompt ?? '').trim();
      return await this.runHdPipeline(sourceImageUrl, model, ratio, userHint, settings);
    }

    // Build the prompt per tool.
    let prompt: string;
    const extraParams: Record<string, unknown> = {};
    switch (toolType) {
      case NODE_TOOL_TYPES.matting: {
        const userSubject = String(options.prompt ?? '').trim();
        prompt = renderToolPrompt('tool.matting', settings, {
          targetSubject: userSubject ? `目标主体：${userSubject}` : '',
        });
        if (options.maskImage) extraParams.maskImage = options.maskImage;
        break;
      }
      case NODE_TOOL_TYPES.outpainting: {
        const dir = (options.direction as 'balanced' | 'horizontal' | 'vertical') ?? 'balanced';
        const userExtra = String(options.prompt ?? '').trim();
        const promptId = dir === 'horizontal'
          ? 'tool.outpaint.horizontal'
          : dir === 'vertical'
            ? 'tool.outpaint.vertical'
            : 'tool.outpaint.balanced';
        const base = renderToolPrompt(promptId, settings);
        prompt = userExtra ? `${base}\n${userExtra}` : base;
        break;
      }
      case NODE_TOOL_TYPES.inpainting: {
        const userPrompt = String(options.prompt ?? '').trim();
        prompt = renderToolPrompt('tool.inpaint', settings, {
          targetContent: userPrompt ? `目标内容：${userPrompt}` : '',
        });
        if (options.maskImage) extraParams.maskImage = options.maskImage;
        break;
      }
      case NODE_TOOL_TYPES.erase:
        prompt = renderToolPrompt('tool.erase', settings);
        if (options.maskImage) extraParams.maskImage = options.maskImage;
        break;
      default:
        throw new Error(`unhandled AI tool type: ${toolType}`);
    }

    // Most adapters want a data URL reference — convert up front.
    const referenceDataUrl = await imageUrlToDataUrl(sourceImageUrl);
    const jobId = await this.aiGateway.submitGenerateImageJob({
      prompt,
      model,
      size: '2K',
      aspectRatio: ratio,
      referenceImages: [referenceDataUrl],
      extraParams,
    });

    // Poll up to 5 min at 1s intervals for the result.
    for (let i = 0; i < 300; i++) {
      const status = await this.aiGateway.getGenerateImageJob(jobId);
      if (status.status === 'succeeded' && status.result) return status.result;
      if (status.status === 'failed') throw new Error(status.error ?? 'AI 编辑失败');
      if (status.status === 'not_found') throw new Error(`任务不存在：${jobId}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('AI 编辑超时（5 分钟未返回结果）');
  }

  /**
   * HD 2-pass pipeline:
   *   1. Generate a clean line-sketch of the source image (structure anchor).
   *   2. Feed both images + an optional user hint back into the AI for the
   *      final high-resolution refined result.
   *
   * Each pass polls the gateway for up to 5 minutes. If pass 1 fails we fall
   * back to a single-pass upscale on the original so the user at least gets
   * an output.
   */
  private async runHdPipeline(
    sourceImageUrl: string,
    model: string,
    ratio: string,
    userHint: string,
    settings: PromptTemplateSettingsSnapshot
  ): Promise<string> {
    if (!this.aiGateway) throw new Error('未注入 AI gateway');
    const sourceDataUrl = await imageUrlToDataUrl(sourceImageUrl);

    const submitAndWait = async (prompt: string, refs: string[]): Promise<string> => {
      const jobId = await this.aiGateway!.submitGenerateImageJob({
        prompt,
        model,
        size: '2K',
        aspectRatio: ratio,
        referenceImages: refs,
        extraParams: {},
      });
      for (let i = 0; i < 300; i++) {
        const status = await this.aiGateway!.getGenerateImageJob(jobId);
        if (status.status === 'succeeded' && status.result) return status.result;
        if (status.status === 'failed') throw new Error(status.error ?? 'AI 编辑失败');
        if (status.status === 'not_found') throw new Error(`任务不存在：${jobId}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('AI 编辑超时（5 分钟未返回结果）');
    };

    // Pass 1: clean line sketch. If it fails (e.g. network hiccup), we still
    // want a usable HD result — fall through with just the source image.
    let sketchDataUrl: string | null = null;
    try {
      const sketchResult = await submitAndWait(renderToolPrompt('tool.hdSketch', settings), [sourceDataUrl]);
      sketchDataUrl = await imageUrlToDataUrl(sketchResult);
    } catch {
      sketchDataUrl = null;
    }

    // Pass 2: original + sketch + user hint → HD output.
    const hdCompositePrompt = renderToolPrompt('tool.hdComposite', settings);
    const compositePrompt = userHint
      ? `${hdCompositePrompt}\n用户补充：${userHint}`
      : hdCompositePrompt;
    const refs = sketchDataUrl ? [sourceDataUrl, sketchDataUrl] : [sourceDataUrl];
    return await submitAndWait(compositePrompt, refs);
  }

  /**
   * 按颜色扫描出「内容边界」，算出自动裁剪矩形（原图像素空间）。
   *
   * 返回 null = 没开自动裁剪，或者检测跑不了（图片还没就绪 / 跨域污染画布）。
   * 两种情况都当作「这一步没生效」，退回用户手画的裁剪框 ——
   * 检测失败不该让整次出图失败。
   */
  private async resolveAutoCropRect(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<CropRect | null> {
    const autoCrop = readAutoCropOptions(options);
    if (!autoCrop.enabled) {
      return null;
    }

    try {
      const image = await loadImageElement(sourceImage);
      return measureAutoCrop(image, autoCrop)?.contentRect ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 裁剪。顺序上自动裁剪在**最底层**：
   *
   *     自动裁剪（只动底图边界）→ 手动裁剪框 → 边框 / 描边 / 圆角 → 文字
   *
   * 所以这里先把「手动框 ∩ 内容边界」算成**一个**矩形再交给下游，
   * 而不是先裁一次再裁一次 —— 边框是后面才叠上去的，永远不会被自动裁剪吃掉，
   * 也就得到了用户要的「PS 图层」效果：上层的不会影响下层的。
   */
  private async cropImage(sourceImage: string, options: Record<string, unknown>): Promise<string> {
    const effectiveCrop = resolveEffectiveCropRect(
      readCropRect(options),
      await this.resolveAutoCropRect(sourceImage, options)
    );

    try {
      return await cropImageSource({
        source: sourceImage,
        aspectRatio: String(options.aspectRatio ?? '1:1'),
        cropX: effectiveCrop ? effectiveCrop.x : Number(options.cropX),
        cropY: effectiveCrop ? effectiveCrop.y : Number(options.cropY),
        cropWidth: effectiveCrop ? effectiveCrop.width : Number(options.cropWidth),
        cropHeight: effectiveCrop ? effectiveCrop.height : Number(options.cropHeight),
      });
    } catch {
      // Fallback to local canvas implementation when backend command is unavailable.
    }

    const aspectRatio = String(options.aspectRatio ?? '1:1');
    const targetRatio = parseAspectRatio(aspectRatio);
    const image = await loadImageElement(sourceImage);

    const cropX = effectiveCrop ? effectiveCrop.x : Number(options.cropX);
    const cropY = effectiveCrop ? effectiveCrop.y : Number(options.cropY);
    const cropWidthOption = effectiveCrop ? effectiveCrop.width : Number(options.cropWidth);
    const cropHeightOption = effectiveCrop ? effectiveCrop.height : Number(options.cropHeight);

    const hasManualCropArea =
      Number.isFinite(cropX) &&
      Number.isFinite(cropY) &&
      Number.isFinite(cropWidthOption) &&
      Number.isFinite(cropHeightOption) &&
      cropWidthOption > 0 &&
      cropHeightOption > 0;

    let cropWidth = image.naturalWidth;
    let cropHeight = image.naturalHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (hasManualCropArea) {
      offsetX = Math.min(image.naturalWidth - 1, Math.max(0, Math.floor(cropX)));
      offsetY = Math.min(image.naturalHeight - 1, Math.max(0, Math.floor(cropY)));
      cropWidth = Math.max(1, Math.min(Math.floor(cropWidthOption), image.naturalWidth - offsetX));
      cropHeight = Math.max(1, Math.min(Math.floor(cropHeightOption), image.naturalHeight - offsetY));
    } else if (aspectRatio === 'free') {
      offsetX = 0;
      offsetY = 0;
      cropWidth = image.naturalWidth;
      cropHeight = image.naturalHeight;
    } else {
      const sourceRatio = image.naturalWidth / image.naturalHeight;
      if (sourceRatio > targetRatio) {
        cropWidth = image.naturalHeight * targetRatio;
      } else {
        cropHeight = image.naturalWidth / targetRatio;
      }

      offsetX = (image.naturalWidth - cropWidth) / 2;
      offsetY = (image.naturalHeight - cropHeight) / 2;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(cropWidth));
    canvas.height = Math.max(1, Math.floor(cropHeight));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(
      image,
      offsetX,
      offsetY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvasToDataUrl(canvas);
  }

  /**
   * 裁剪面板里的「边框」是可选收尾步骤：先裁再补边 / 描边。
   *
   * 之所以放在裁剪之后而不是之前，是因为边框的参数都以最终画幅为基准：
   * 圆角半径按裁剪结果短边算，按比例补边也要知道裁剪后的真实比例。
   * 全程走前端 canvas，不依赖 Tauri 命令，所以 Web 预览和桌面端行为一致。
   *
   * 边框可以是多层（每层一个颜色）。没有「开关」：层列表为空就是没有边框。
   */
  private async applyBorderToImage(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<string> {
    const border = readBorderOptions(options);

    const image = await loadImageElement(sourceImage);
    const geometry = resolveBorderGeometry(image.naturalWidth, image.naturalHeight, border);
    if (isBorderNoop(geometry)) {
      // 没有边框层、参数也全是 0，等价于没开，别白跑一次 PNG 编码。
      return sourceImage;
    }

    const canvas = document.createElement('canvas');
    canvas.width = geometry.canvasWidth;
    canvas.height = geometry.canvasHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    drawImageWithBorder(context, image, geometry);
    return canvasToDataUrl(canvas);
  }

  private async annotateImage(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<string> {
    const image = await loadImageElement(sourceImage);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const annotations = parseAnnotationItems(options.annotations);

    if (annotations.length > 0) {
      drawAnnotations(context, annotations);
    } else {
      const text = String(options.text ?? '').trim();
      const position = String(options.position ?? 'bottom');
      const color = String(options.color ?? '#FFFFFF');

      if (!text) {
        return canvasToDataUrl(canvas);
      }

      const fontSize = Math.max(24, Math.round(canvas.width * 0.04));
      context.font = `600 ${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      const textWidth = context.measureText(text).width;
      const paddingX = Math.round(fontSize * 0.8);
      const paddingY = Math.round(fontSize * 0.6);
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = fontSize + paddingY * 2;

      const x = canvas.width / 2;
      const y = this.resolveAnnotateY(position, canvas.height, boxHeight);

      context.fillStyle = 'rgba(0, 0, 0, 0.45)';
      context.fillRect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight);
      context.fillStyle = color;
      context.fillText(text, x, y);
    }

    return canvasToDataUrl(canvas);
  }

  /**
   * 文字落图：把（裁剪 + 边框之后的）图铺到同尺寸 canvas 上，再按图层叠文字。
   *
   * options.textOrderIndex 是这张图**在选择条里排第几**（0-based）—— 文字里的 {n} 由它决定。
   * 这个值由裁剪面板同步进 options（拖条就变），这里只负责读，不去猜。
   */
  private async applyTextLayersToImage(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<string> {
    const image = await loadImageElement(sourceImage);

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const rawIndex = Number(options.textOrderIndex);
    const orderIndex = Number.isFinite(rawIndex) ? Math.max(0, Math.floor(rawIndex)) : 0;
    const drew = drawTextLayersFromOptions(
      context,
      canvas.width,
      canvas.height,
      options,
      orderIndex
    );
    if (!drew) {
      // 没有可见文字层 —— 没必要白跑一次 PNG 编码。
      return sourceImage;
    }

    return canvasToDataUrl(canvas);
  }

  private resolveAnnotateY(position: string, canvasHeight: number, boxHeight: number): number {
    if (position === 'top') {
      return boxHeight / 2 + 24;
    }

    if (position === 'center') {
      return canvasHeight / 2;
    }

    return canvasHeight - boxHeight / 2 - 24;
  }

  private async splitStoryboard(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThicknessPercent: number,
    lineThicknessPxFallback: number,
    frameNotes?: string[]
  ): Promise<ToolProcessorResult> {
    const normalizedRows = Number.isFinite(rows) ? rows : 3;
    const normalizedCols = Number.isFinite(cols) ? cols : 3;
    const normalizedLineThicknessPercent = Number.isFinite(lineThicknessPercent)
      ? lineThicknessPercent
      : NaN;
    const normalizedLineThicknessPxFallback = Number.isFinite(lineThicknessPxFallback)
      ? lineThicknessPxFallback
      : 0;

    const safeRows = Math.max(1, Math.floor(normalizedRows));
    const safeCols = Math.max(1, Math.floor(normalizedCols));
    const safeLineThickness = await this.resolveSplitLineThicknessPx(
      sourceImage,
      safeRows,
      safeCols,
      normalizedLineThicknessPercent,
      normalizedLineThicknessPxFallback
    );

    if (safeRows <= 0 || safeCols <= 0) {
      throw new Error('分镜行列必须大于 0');
    }

    let outputs: string[];
    try {
      outputs = await this.splitGateway.split(
        sourceImage,
        safeRows,
        safeCols,
        safeLineThickness
      );
    } catch {
      // Fallback when Tauri command is unavailable or fails.
      outputs = await this.localSplit(sourceImage, safeRows, safeCols, safeLineThickness);
    }

    const persistedFrameImages = await Promise.all(
      outputs.map(async (imageUrl) => await persistImageLocally(imageUrl))
    );

    let frameAspectRatio: string | undefined;
    const firstFrameImage = persistedFrameImages[0];
    if (firstFrameImage) {
      try {
        frameAspectRatio = await detectAspectRatio(firstFrameImage);
      } catch {
        frameAspectRatio = undefined;
      }
    }

    const resolvedFrameAspectRatio = frameAspectRatio ?? `${safeCols}:${safeRows}`;
    const frames: StoryboardFrameItem[] = persistedFrameImages.map((imageUrl, index) => ({
      id: this.idGenerator.next(),
      imageUrl,
      previewImageUrl: imageUrl,
      aspectRatio: resolvedFrameAspectRatio,
      note: typeof frameNotes?.[index] === 'string' ? frameNotes[index].trim() : '',
      order: index,
    }));

    return {
      storyboardFrames: frames,
      rows: safeRows,
      cols: safeCols,
      frameAspectRatio: resolvedFrameAspectRatio,
    };
  }

  private resolveMaxAllowedLineThickness(
    imageWidth: number,
    imageHeight: number,
    rows: number,
    cols: number
  ): number {
    const maxLineByWidth = cols > 1 ? Math.floor((imageWidth - cols) / (cols - 1)) : Number.MAX_SAFE_INTEGER;
    const maxLineByHeight = rows > 1 ? Math.floor((imageHeight - rows) / (rows - 1)) : Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(maxLineByWidth, maxLineByHeight));
  }

  private async resolveSplitLineThicknessPx(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThicknessPercent: number,
    lineThicknessPxFallback: number
  ): Promise<number> {
    if (!Number.isFinite(lineThicknessPercent)) {
      return Math.max(0, Math.floor(lineThicknessPxFallback));
    }

    const normalizedPercent = Math.max(0, lineThicknessPercent);
    if (normalizedPercent <= 0) {
      return 0;
    }

    const image = await loadImageElement(sourceImage);
    const imageWidth = Math.max(1, image.naturalWidth);
    const imageHeight = Math.max(1, image.naturalHeight);
    const basis = Math.max(1, Math.min(imageWidth, imageHeight));
    const rawPixelThickness = Math.max(1, Math.round((basis * normalizedPercent) / 100));
    const maxAllowedThickness = this.resolveMaxAllowedLineThickness(imageWidth, imageHeight, rows, cols);
    return Math.max(0, Math.min(rawPixelThickness, maxAllowedThickness));
  }

  private async readStoryboardMetadata(
    sourceImage: string
  ): Promise<{ gridRows: number; gridCols: number; frameNotes: string[] } | null> {
    try {
      const metadata = await readStoryboardImageMetadata(sourceImage);
      if (!metadata) {
        return null;
      }

      return {
        gridRows: metadata.gridRows,
        gridCols: metadata.gridCols,
        frameNotes: Array.isArray(metadata.frameNotes) ? metadata.frameNotes : [],
      };
    } catch {
      return null;
    }
  }

  private splitIntoSegments(totalSize: number, segmentCount: number): number[] {
    const baseSize = Math.floor(totalSize / segmentCount);
    const remainder = totalSize % segmentCount;

    return Array.from(
      { length: segmentCount },
      (_item, index) => baseSize + (index < remainder ? 1 : 0)
    );
  }

  private async localSplit(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThickness: number
  ): Promise<string[]> {
    const image = await loadImageElement(sourceImage);

    const maxAllowedLine = this.resolveMaxAllowedLineThickness(
      image.naturalWidth,
      image.naturalHeight,
      rows,
      cols
    );
    const resolvedLineThickness = Math.min(Math.max(0, lineThickness), maxAllowedLine);

    const usableWidth = image.naturalWidth - (cols - 1) * resolvedLineThickness;
    const usableHeight = image.naturalHeight - (rows - 1) * resolvedLineThickness;

    if (usableWidth < cols || usableHeight < rows) {
      throw new Error('分割线过粗，无法完成切割');
    }

    const columnWidths = this.splitIntoSegments(usableWidth, cols);
    const rowHeights = this.splitIntoSegments(usableHeight, rows);

    const results: string[] = [];

    const yOffsets: number[] = [];
    let yCursor = 0;
    for (let row = 0; row < rows; row += 1) {
      yOffsets.push(yCursor);
      yCursor += rowHeights[row];
      if (row < rows - 1) {
        yCursor += resolvedLineThickness;
      }
    }

    const xOffsets: number[] = [];
    let xCursor = 0;
    for (let col = 0; col < cols; col += 1) {
      xOffsets.push(xCursor);
      xCursor += columnWidths[col];
      if (col < cols - 1) {
        xCursor += resolvedLineThickness;
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const targetWidth = columnWidths[col];
        const targetHeight = rowHeights[row];

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('无法初始化画布');
        }

        context.drawImage(
          image,
          xOffsets[col],
          yOffsets[row],
          targetWidth,
          targetHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );
        results.push(canvasToDataUrl(canvas));
      }
    }

    return results;
  }
}
