# Canvas2D 渲染引擎架构设计

> 状态：已落地（Canvas2D 为唯一渲染引擎，React Flow 已全量移除）
> 代码入口：`src/features/canvas/canvas2d/`、`src/features/canvas/compat/`
> 关联提交：`40d2069`（v0）→ `788f678`（v1）→ `a376df5`（数据层解耦）→ `58b2085`（物理移除 RF）→ 本次收尾（残留清除 + 功能补齐）

## 1. 目标

面向数百至上千节点的画布渲染：

- 平移/缩放帧成本与节点总量解耦（视口裁剪 + 空间索引 + LOD）；
- 手势期间零 store 写入、零 React 渲染，松手一次性 commit；
- 项目文件数据格式不变，与历史版本双向兼容。

## 2. 分层

```
canvas2d/
  sceneModel.ts    文档模型 → 渲染模型（绝对坐标、类型归类、状态归一），纯函数可单测
  spatialGrid.ts   均匀网格空间索引（512px 单元）+ 拖拽后代过滤 + 磁吸跟随簇计算
  imageCache.ts    LRU 图片缓存（仅淘汰已完成条目，防全览加载风暴）
  renderer.ts      纯绘制：点阵背景 / 边（三态）/ 节点（三级 LOD）/ 叠加层 / 小地图
  engine.ts        相机、手势状态机、磁吸（对齐参考线 + 跟随移动）、rAF 循环
  Canvas2DView.tsx React 宿主：store 桥接、持久化、菜单/面板生态、批量工具条、快捷键
compat/
  engineBridge.ts  引擎单例注册 + 坐标换算（client ↔ world）+ 低频视口快照
  nodeHostApi.tsx  节点编辑组件宿主 API（Handle/NodeToolbar/NodeResizeControl/
                   useCanvasApi/useViewport/useEdges/useUpdateNodeInternals）
domain/
  graphTypes.ts    Node/Edge/Change/Connection/Viewport 唯一真源
  graphMutations.ts applyNodeChanges/applyEdgeChanges/addEdge 内部实现
  batchToolbar.ts  多选批量工具条派生状态（纯函数可单测）
```

要点：

- **文档模型与渲染模型分离**：`canvasStore`（zustand）持有 nodes/edges；
  `buildSceneModel` 仅在引用变化时重建扁平渲染结构；拖拽等每帧手势不触碰 store。
- **节点编辑零重写 + 画布内联（DOM 岛混合渲染）**：原节点编辑组件（nodes/、
  SelectedNodeOverlay、NodeActionToolbar 等约 1.5 万行业务逻辑）通过 `nodeHostApi`
  宿主 API 运行。视口内节点以 DOM 岛形式内嵌原版组件（与旧版画布内编辑一致，
  无右侧检视面板）：单层 world 容器跟随相机 transform，岛内指针按 nodrag 约定
  路由，尺寸经 ResizeObserver 回写 store；缩小到极端全览或超出上限（60）时
  回退画布卡片，选中节点始终入岛。NodeInspector 仅作为岛层整体异常的兜底。
- **数据语义内部化**：`graphMutations` 逐行对齐历史数据层语义（含 `xy-edge__` 边 id
  约定——该前缀已随项目文件持久化，属数据格式兼容约定，不可变更）。

## 3. 手势与提交模型

engine 内部维护手势状态机（pan / drag / marquee / connect / resize / minimap /
rightPending），经 `EngineHost` 回调在手势边界一次性提交：

| 回调 | 时机 | 语义 |
| --- | --- | --- |
| onSelect | 点选/框选/全选/清空 | 同步 store.selectedNodeId 与视图多选镜像 |
| onDragStart / onDragCommit | 越过拖拽阈值 / 松手 | position changes（dragging 标志驱动历史快照） |
| onDragRequestDuplicate | Alt+拖拽越阈值 | 复制快照挂 dragHistorySnapshot，撤销一步还原 |
| onResizeStart / onResizeCommit | 手柄拖拽 | dimensions change + isSizeManuallyAdjusted 语义 |
| onViewportCommit | 平移/缩放 200ms 防抖 | setViewportState 持久化 |
| onConnect / onConnectEndEmpty | 连线松手 | 落节点=连接；落空白=新建节点菜单 |

撤销/重做：全图快照入栈（canvasStore.history），拖拽类操作经 dragHistorySnapshot
合并为一步。

## 4. 功能对齐清单（与旧版画布）

已完成迁移：

- **画布内联节点编辑**（DOM 岛，见 §2）：点击节点直接在画布内编辑/生成，
  与旧版 React Flow 体验一致；
- 连线拖出（合法/非法预览、标签单源规则、文本内容传递）；
- 框选（右键拖 / Ctrl+左键拖，部分相交即选中）；
- 磁吸：对齐参考线（滞回锁定）+ **贴合跟随移动**（间隙 ≤1px 的节点簇随动，
  Shift/Alt 拖拽不跟随，`collectFollowCluster` 见 spatialGrid.ts）；
- Alt+拖拽复制、单节点缩放手柄、右键菜单、双击（看图/跳源/建节点）；
- 内部剪贴板 Ctrl+C/V（节点+内部连线+父子结构）、Ctrl+A、Ctrl+G 打组/解组；
- WASD 平移、小地图导航、Esc 取消手势；
- **多选批量工具条**（复制/打组/解组/批量触发/删除）：
  - 定位：rAF 读引擎实时选区包围盒（含拖拽偏移），独立组件内 state，不重渲染画布宿主；
  - 多选联合包围盒由渲染器绘制（浅色虚线框）；
  - **批量触发**：可触发类型见 `CANVAS_BATCH_TRIGGER_TYPES`（图片编辑/AI视频/AI文本/
    分镜生成/标签）。检视面板中已挂载的节点直接发布 `generation-node/trigger`；
    其余节点经 `HiddenTriggerHost` 隐藏挂载（1px 容器，`HiddenHostContext` 抑制浮动
    工具栏）补齐事件订阅后统一发布，20s 兜底卸载、选区变化即卸载。生成提交后的
    轮询与结果落盘由视图级 `useCanvasGenerationPolling` 接管，与组件挂载状态无关；
- **系统剪贴板图片/媒体/文本粘贴**（`useCanvasSystemClipboard`）：
  - 双通道：document paste 事件（同步 clipboardData）优先，40ms 未触发回退
    readClipboardContent（Tauri 优先、浏览器 API 兜底）；
  - 新鲜度指纹：内部复制时把单节点内容同步写系统剪贴板并记录指纹基线，
    粘贴时比对判定 internal/system 来源；
  - 目标规则：选中上传节点→素材替换事件；提示词类节点→图片建参考节点连线/
    视频源/文本追加 prompt；文本批注→追加 content；其余→建节点（落点=最近指针）；
  - 右键菜单粘贴走同一决策树（Tauri 通道优先）；
- **素材文件拖入**（`useMaterialImport`）：OS 文件（图片/视频/音频→对应节点）与
  本地路径文本（text/uri-list、file:// 前缀）两类拖拽源；窗口级 dragover/drop
  拦截防止浏览器直接打开文件。

## 5. 已知差异与约束

- DOM 岛同屏上限 60 个（选中豁免）；极端全览（zoom < 0.2）仅挂载选中节点；
- **相机运动期间 DOM 岛挂起**（缩放/平移/WASD）：非选中岛 display:none 保留挂载、
  引擎 domIslands 清空由画布卡片接管，静止 220ms 后恢复——消除缩放时的
  DOM 重绘与挂载抖动；选中节点的岛保持可见（编辑焦点不丢失）；
- 连线视觉为 Canvas2D 自绘三态（空闲/生成中流动虚线/失败红色），旧版 SVG
  "三股麻花流光"特效未复刻（canvas 光栅下成本高，按需再评估）；
- 批量触发依赖节点组件内的生成逻辑，隐藏挂载数量极大时（数百个重型编辑组件）
  会有一次性挂载开销；
- 系统剪贴板读取受 WebView 权限约束，失败时静默回退（readFailed 语义保留）。

## 6. 验证基线

- `npx tsc --noEmit` 通过；
- `npx vitest run` 全绿（含 sceneModel / graphMutations / followCluster / batchToolbar 单测）;
- `grep -rniE "reactflow|react-flow|xyflow" src/` = 0（`xy-edge__` 为数据格式约定除外）；
- vite dev 全模块转换通过。
