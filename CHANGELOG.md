# Changelog

本文件记录 godot-imagegen 的对外变更。格式沿袭本仓库其余文档：`## [版本] — 日期`，
下分 `Added / Changed / Fixed`。版本号与 `package.json` 的 `version` 保持一致。

## [0.1.0] — 2026-10-10

首个公开版本。一个包同时声明 `dsh.bundle` 与 `dsh.client`，**无构建步骤**；宿主半边
运行时**零第三方依赖**（只用 Node 内置模块），前端半边只 `require('react')`。

### Added

- **宿主插件**（`godot-imagegen.ts`）：
  - **10 个面向模型的 `image_*` 工具**：`image_backend_status`、`image_generate`、
    `image_edit`、`image_variants`、`image_upscale`、`image_cutout`、`image_interrogate`、
    `image_gallery`、`image_workflow`、`image_workshop`。
  - **同源 `/gig` REST 面**：状态、图库、原图字节、生成/编辑/放大/抠图/反推任务、
    任务轮询与取消、后端启停、设置与预设、工作流库读写、面板指令与画布中继轮询、
    画布桥接的安装与卸载。
  - **工作流层**：按 widget **名称**寻址而不是索引（索引会随 ComfyUI 版本漂移）；
    **插件本地的工作流库**（`$DSH_HOME/godot-imagegen/workflows/`，**从不写入用户的
    ComfyUI**），6 套游戏美术模板 + 任意新建与改写，元数据写在文档自身的 `extra` 里；
    节点布局缓存，避免每次重新拉取 `/object_info`。
  - **双后端**：SD WebUI（`/sdapi/v1/*`，默认 `:7860`）与 ComfyUI（默认 `:8188`），
    可在面板上启停；**绝不终止非本插件启动的进程**。
  - **后处理**：抠图（`rembg` / 色键）、放大（Real-ESRGAN / SwinIR / Lanczos）、
    无缝平铺——跑整合包**自带的** Python，因此插件不安装任何 Python 包。
  - **产物记录**：绝对路径、`res://` 路径（落在 Godot 项目内时）、尺寸、seed、模型、
    后端、抠图/放大方法。
  - **持久化**：独立 KV 单元 `godot_imagegen`（图库记录 + 用户预设 + 设置），
    经 DSH 的 `storage` 服务。
- **客户端**（`lib/client.js`，`dsh.client`）：
  - better-sidebar tab **「美术工坊」**（order 63），**三态**：侧边栏入口态、浮窗态、
    全屏态。
  - **内嵌真实 ComfyUI 前端**（iframe）——不是截图；宽 ≥700px 时三分栏（图库 /
    ComfyUI 画布 / 参数）。
  - 提示词预设、任务进度（含后端实时预览图）、图库灯箱（放大 / 抠图 / 反推 /
    发送到对话 / 注册资产 / 删除）。
- **ComfyUI 侧扩展**（`comfyui-extension/`，随插件分发）：
  - 走 **postMessage** 而不是 HTTP：DSH 会给"frame origin 不是载体 origin"的请求
    一律 403，iframe 自己发不出任何请求，父窗口是唯一通路。
  - 每次安装生成**一次性令牌**，双向校验 origin + 令牌。
  - **心跳**保活，否则画布约 15 秒后掉线；画布状态与正在执行的节点回传宿主。
  - 装卸都带 **`BEFORE.json` 时间戳备份 + 文件清单**，卸载只删清单里的路径，
    越界记录拒绝执行；只回收它自己创建的目录。
- **打包**：一个包两半，`dsh plugin --profile <name> add godot-imagegen` 即可安装。

### Changed

- `betterSidebar` 由硬依赖改为**可选**：插件级 `inject` 会在侧边栏宿主缺失时把客户端
  fiber 永久挂在 pending，而 DSH 的启动健康门会把非 active 的客户端条目判成渲染器启动
  失败、进而禁用整个插件。改走内层 `ctx.inject`，宿主一出现就激活。
- README 的安装章节改为**官方 CLI 优先**，手工 junction 退为本地开发备选；文档里
  本机绝对路径全部替换为占位符。

### Fixed

开发期间实测并修掉的问题（按用户能感知的行为记）：

- **画布心跳**：不加心跳时画布约 15 秒后被判为"未连接"。
- **载入回执时机**：载入完成后延后一拍再上报，避免抢在画布状态稳定之前。
- **折叠画布区不该重载 ComfyUI**。
- **面板此前没有任何停止按钮**（后端卡片根本没挂上）。
- **不再承诺"把 tab 拖到主会话区"**：该手势在 `dsh-better-sidebar` 0.18.x 上因锚点
  选择器过时而无法触发，这不是本插件能修的，改文档而不是留着一个假的承诺。
- **`item-icon` 模板产不出东西**：它的提示词没有主体。
- **后处理不再泄漏 `%TEMP%\gig-py-*`**：改用数据根下的固定目录。
- **输出记录去重**、从 PNG 补尺寸、记录耗时；Qwen/GGUF 权重预检。
- **`patch` 的 layout 刷新不再否掉缓存**；ComfyUI 启动参数加省显存三件套。

### Known issues

- **`image_workflow action=open to_canvas=true` 的载入在本机仍会失败**：推过去的图没有出现在画布上，
  ComfyUI 弹出「由于重新加载工作流数据出错，加载被中止」。**根因查明了一半**：扩展原来调用
  `app.loadGraphData(graph)` **没有 await**，而 ComfyUI 报失败走的是**弹模态**、不是抛异常——所以扩展
  在结构上无法区分成功与失败，把"调用了"当成了"成功了"。这解释了三件事同时成立：工具回报成功、画布
  弹错误框、`read-canvas` 还在报上一次成功载入的节点。另外那个分区**默认折叠**，所以模态连用户也看不见。
  [Unreleased] 已修好**回报**（await + 事后比对画布实际持有的图），但**为什么载入会失败本身还没定位**，
  所以这一条仍然开着。

## [Unreleased]

### Added

- **模板 checkpoint 前置预警**：`image_workflow action=run` 在提交之前先比对工作流
  钉住的 `ckpt_name` 与本机已装列表，缺了就点名说明，并给出最接近的那个——而不是等
  ComfyUI 在跑起来之后回一条校验错误。`image_generate` 一直是按已装列表解析 checkpoint
  的（显式指定但缺失会被拒绝并列出可用项，默认值失配则回落到第一个已装模型），工作流
  这条路径此前没有对应处理。**只警告，不拒绝运行**；已装列表读不到时保持沉默（空列表
  在这里意味着"读不到"，不是"没装"）。预警在**成功与失败两条路径上都回到调用方**：
  成功时随结果附上，失败时追加进错误——缺模型恰好会让运行失败，那正是它最该出现的
  时候，而第一版只在成功路径上附带，真机一跑就露了馅。

### Fixed

- **`models('comfyui')` 的 COMBO 形状**：原来按 `[0]` 读 `/object_info` 的 `ckpt_name`，
  在 `["COMBO", { options: [...] }]` 形状上读到的是字符串 `"COMBO"`，于是返回**空列表**。
  空列表不等于"没装 checkpoint"——它会让 `pickModel` 回落到空，使 `image_generate` 在
  明明有模型的机器上报「ComfyUI 中没有任何 checkpoint」。现在与测试里早已验证过的读法
  一致，两种形状都认（同一台机器上 `UpscaleModelLoader` 用一种、`CheckpointLoaderSimple`
  用另一种，所以任何一种形状都不能假设）。
- **`test-workflow-library.mjs` 不再因环境不同而红**：原先把"两个钉住的 checkpoint 都已
  安装"当作硬断言，于是任何开着 ComfyUI 但模型集不同的机器跑 `npm test` 都退出 1——那是
  一种正常配置，不是关于这份代码的结论。现在改为 `NOTE`，点名缺哪个模型、影响哪些模板；
  断言改为非空校验（确认推导出的 pinned 集合不空），存在性交给运行时预警。
  受影响的 `sd15-basic`（钉 `anything-v5.safetensors`）在本机仍跑不了，但现在它会**被
  说清楚**，而不是表现为一次莫名其妙的失败。
- 两处断言文案名不副实：写的是 "really exists on this machine"，实际只校验了文档里的
  字面量，从未碰过机器。
- **画布载入不再"报成功而实际没换图"**：扩展原来不 await `app.loadGraphData`（它是 async），
  把 Promise 当结果返回，于是"调用了"和"成功了"变成同一件事；而 ComfyUI 报失败是**弹模态**、
  不是抛异常，连 await 都不足以判定。现在 await 之后**再比对画布实际持有的图**——按
  `类型×数量` 取指纹（只比节点数会看不出"7 节点换 7 节点"，只比类名又会漏掉丢节点）——
  不一致就回报 `ok:false`，并把两边都写进错误里。**测试的问题也一并修了**：`test-extension.mjs`
  的假 app 此前只记录调用、**不替换 `app.graph`**，也就是它模拟的正是"载入没生效"这种失败状态，
  却断言成功了——所以这个 bug 在结构上不可能被测出来。现在假 app 会真的换图，并新增一条
  "静默没换图"的用例。
- **失败不再藏在折叠分区里**：画布分区默认折叠，而 ComfyUI 自己的错误提示是弹在**分区内部**的，
  折叠着就完全看不见。现在载入被拒时该分区**自动展开**，并在标题上标注
  `⚠ 画布拒绝了最近 N 次载入`（折叠状态下也看得见）。
- **面板不再教用户做一件已不存在的事**：`dsh-better-sidebar` 从 v0.19.0 起移除了 `floatWindows`，
  而面板头部**永远显示**「如何浮窗？」并在提示里让用户"右键点本 tab →「移动到自由窗口」"。
  现在按**能力**判断（`placement.known`）而不是版本号：侧边栏报不出 `floats` 时不显示这个按钮，
  一旦上游恢复浮窗，按钮与全屏控件会自己回来。README 的 §1 / §2 / §11 / §12 四处也一并改正
  （§11 还留着一段"如何修回拖拽手势"的补丁说明，而那个手势即使修好也无处可去）。

### 待处理

- 定位**为什么** `loadGraphData` 会拒绝这些图。回报这一环已经修好（失败现在会明确报出、并写明
  推过去的是什么、画布上实际是什么），可据此继续查：优先验证传进去的是 UI 格式还是 API 格式，
  以及与同一版 ComfyUI 自己导出的文档逐字段比对。
- ComfyUI 通道接线 ControlNet、放大与反推（目前这三项只走 SD WebUI）。
- `transparent_method: generative` 需要把 layerdiffuse 权重放进
  `ComfyUI/models/layerdiffuse`（`extra_model_paths` 没有映射它）。
