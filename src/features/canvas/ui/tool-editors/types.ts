import type { CanvasToolPlugin, ToolFieldSchema, ToolOptions } from '@/features/canvas/tools';

export interface ToolEditorBaseProps {
  plugin: CanvasToolPlugin;
  options: ToolOptions;
  onOptionsChange: (next: ToolOptions) => void;
}

export interface VisualToolEditorProps extends ToolEditorBaseProps {
  sourceImageUrl: string;
  /**
   * 仅裁剪面板用到 —— 批量套用选择条需要的回调：
   *  - onSwitchTarget：切换当前正在编辑的节点（图源 + 该节点自己的参数都跟着换）。
   *  - onApplyBatch：把当前编辑器里的参数套用到用户加入队列的图节点
   *    （不含当前节点 —— 当前节点由底部「应用」按钮负责）。
   *  - canvasImages：画布上的图片节点（含当前节点），顺序 = 画布顺序。
   *    ⚠️ 它只是"可加入队列的候选清单"，**不会默认渲染** ——
   *    选择条默认只画当前图 + 用户手动加入的图，候选清单仅在展开
   *    「添加图片」面板时才渲染缩略图。把整张画布的图默认全铺出来会明显卡顿。
   *
   *  旧的 onRequestBatchApply（弹出 BatchApplyBorderDialog）已废弃，
   *  批量入口现在直接嵌在选择条的右侧按钮上。
   */
  onSwitchTarget?: (nodeId: string) => void;
  /**
   * 「批量套用」= **预览**：把当前编辑器里的参数铺到队列里的图，让用户逐张切过去检查。
   * 只写参数、不落图 —— 落图由每张图各自的「应用」负责。
   *
   * `textOrderIndexById` = 条内 0-based 位置表（id → 排第几）。
   * ⚠️ 必须一并落盘：面板一关条就没了，目标图只能靠这份存下来的编号
   * 才知道自己在这批里排第几，否则切过去会看到编号退回 1。
   */
  onApplyBatch?: (targetIds: string[], textOrderIndexById?: Map<string, number>) => void;
  /**
   * 条里拖动排序 —— 传出**条里这些图**的新顺序（id 数组）。
   *
   * ⚠️ 条里只显示「当前图 ∪ 队列」这个子集，所以父组件要负责把这份子集顺序
   * 映射回全局图片顺序（没显示在条里的图原地不动）。
   * ⚠️ 这个顺序**同时决定文字编号**「图像1 / 图像2…」，不是纯视觉排序。
   */
  onReorderImages?: (orderedIds: string[]) => void;
  canvasImages?: Array<{
    id: string;
    label: string;
    /** 缩略图源：**应当是 previewImageUrl 这类小图**，不要传原图。 */
    imageUrl: string;
    width?: number | null;
    height?: number | null;
    /**
     * 该图在**有效图片顺序**中的 0-based 下标（默认画布顺序，用户拖过条之后按拖的顺序）。
     *
     * ⚠️ 它**只用来排序** —— 决定条里谁在前谁在后。
     * 文字编号（「图像1 / 图像2…」）读的不是它，而是「条内位置」（第 1 格 = 1）。
     */
    orderIndex?: number;
  }>;
  /** 父组件传 "当前正在编辑" 的节点 id，用来给选择条显示「当前」高亮。 */
  currentNodeId?: string;
  /**
   * 当前节点在有效图片顺序中的 0-based 下标。
   *
   * ⚠️ 同样**只用来排序**（当前图缺在 `canvasImages` 里时的兜底排序键）。
   * 文字编号读的是「条内位置」，由编辑器自己从当前图 + 队列算出来。
   */
  currentOrderIndex?: number;
  /** 批量套用进行中：选择条按钮要禁用，避免重复点击。 */
  isBatchApplying?: boolean;
  /**
   * 批量套用刚完成时的张数，用来在按钮上给一句「已套用 N 张」的短暂反馈。
   *
   * ⚠️ 批量套用**只写参数、不落图**，界面上不会有别的变化 ——
   * 没有这个反馈，用户点完会以为「点了没反应」。`null` = 不显示。
   */
  batchAppliedCount?: number | null;
}

export interface FormToolEditorProps extends ToolEditorBaseProps {
  fields: ToolFieldSchema[];
}
