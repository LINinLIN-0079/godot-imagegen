# godot-imagegen

**本地 AI 出图 → Godot 可用美术资产** 的 DSH 插件。

它把本机已装好的两套秋叶出图后端接进 DeepSeek Harness：模型通过 8 个 `image_*` 工具在对话里直接出图，
你通过右侧边栏的 **「美术工坊」** 面板点选提示词、看图、抠图、放大；产物自动落进 Godot 项目的
`assets/generated/<品类>/`，并给出 `res://` 路径，一键注册进 `godot-asset-planner` 的资产库。

---

## 1. 能力范围

| 层 | 内容 |
| --- | --- |
| 模型工具（10） | `image_backend_status` `image_generate` `image_edit` `image_variants` `image_upscale` `image_cutout` `image_interrogate` `image_gallery` `image_workflow` `image_workshop` |
| REST（`/gig/*`） | 面板与宿主的同源通道：状态、图库、原图字节、生成/编辑/放大/抠图/反推任务、任务轮询与取消、后端启停、设置与预设、工作流库读写、面板指令轮询 |
| 工作流库 | 插件本地（`$DSH_HOME/godot-imagegen/workflows/`，**从不写入你的 ComfyUI**）：6 套游戏美术模板 + 任意新建/改写；元数据写在文档自身的 `extra` 里 |
| 对话驱动 | 代理可通过 `image_workflow` / `image_workshop` 改写工作流、把提示词与参数填进面板、在面板里定位图片——你只需在对话里说
| 浏览器面板 | better-sidebar tab「美术工坊」（order 63）：后端卡片、设置、提示词预设库、参数面板、任务进度（含后端实时预览图）、图库缩略图 + 灯箱（放大/抠图/反推/复制路径/注册资产/删除） |
| DSH 技能 | `D:\游戏开发skill\game-art` —— 游戏美术提示词手册、分品类尺寸与透明规范、端到端工作流、21 条样例提示词、色键抠图脚本 |
| 持久化 | 独立 KV 单元 `godot_imagegen`（图库记录 + 用户预设 + 设置） |

**每个产物都会带上**：绝对路径、`res://` 路径（落在 Godot 项目内时）、尺寸、seed、模型、后端、抠图/放大方法。

## 2. 后端：本机实测的能力矩阵

插件自动探测、可手动指定，`auto` 会优先用 `defaultBackend` 并自动回落。

| 能力 | SD WebUI（秋叶 v4.10，`:7860`） | ComfyUI（秋叶 v2，`:8188`） |
| --- | --- | --- |
| 出图 / 图生图 | ✅ `waiIllustriousSDXL_v150`（SDXL/Illustrious）、`anything-v5`（SD1.5） | ✅ 同 3 个 checkpoint（经 `extra_model_paths` 共享 SD WebUI 目录） |
| ControlNet | ✅ **15 个模型**（openpose / lineart_anime / depth / canny / normalbae / seg / scribble / softedge / tile …） | ✅ 权重可见（同 15 个）——**但本插件的 ComfyUI 通道尚未实现 ControlNet** |
| 放大 | ✅ 16 个可选（R-ESRGAN 4x+ Anime6B、4x-AnimeSharp、BSRGAN、ESRGAN_4x、SwinIR_4x …） | ✅ 权重可见（6 个 .pth）——**同上，未实现** |
| 反推提示词 | ✅ **WD14 tagger 扩展**（16 个模型，默认 `wd14-convnextv2-v2`；内置 `/sdapi/v1/interrogators` 在本机是 404） | ⚠️ 节点在、ONNX 权重缺失 |
| 人脸修复 | ✅ GFPGAN + CodeFormer | — |
| 生成式透明 | ❌ | ⚠️ layerdiffuse 节点已装但 `models/layerdiffuse` **权重未下载** |
| 面板一键启动 | ✅ `python launch.py --api …` | ✅ `python -S main.py …` |

> **关键事实**：秋叶 ComfyUI 的 `extra_model_paths.yaml` 把 `a111.base_path` 指向了 SD WebUI 安装目录，
> 所以 ComfyUI **能看到**同一批 checkpoint / ControlNet / 放大权重（`image_backend_status` 会实测报告数量）。
> 但本插件的 ComfyUI 通道目前**只实现文生图与图生图**——ControlNet、放大、反推请走 SD WebUI，
> 工具返回值里也会这样提示。

> 本机实测（`test-imagegen-live.mjs` / `test-imagegen-live-comfy.mjs`，RTX 5060 Laptop / 8GB 显存）：
>
> | 任务 | 耗时 |
> | --- | --- |
> | SD1.5 512²/14 步 · SD WebUI | 冷启动 ≈24s（含 7GB 换模型），模型已就位 **≈7s** |
> | SD1.5 512²/12 步 · ComfyUI | **≈8.5s**；图生图 ≈2.4s |
> | rembg(u2net) 抠图 | **≈6s** |
> | R-ESRGAN 4x+ Anime6B 放大 ×2 | **≈1.2s** |
> | ControlNet(lineart_anime) 512²/12 步 | **≈4s** |
> | **SDXL 768²** | **≈60–77 秒/步** —— 18 步实测超过 15 分钟（GPU 99%、显存 7.7/8.1GB 打满） |
>
> 所以默认 `requestTimeoutMs` 定为 **30 分钟**。草稿阶段优先 **ComfyUI + SD1.5**（最快）或 SD WebUI + SD1.5，
> 尺寸 ≤640×640，定稿后再 `image_upscale`。`image_generate` 在检测到 SDXL + ≥768² 时会把耗时提示放进返回值。

**所以默认后端是 SD WebUI**；ComfyUI 作为 SD1.5 / 自定义工作流的第二后端。

后处理（抠图 / 放大 / 无缝平铺）走秋叶自带的 Python，它已经装了
**Pillow、numpy、OpenCV、scipy、rembg、onnxruntime**，所以插件不额外安装任何依赖。

## 3. 安装与挂载

插件本体在 `D:\deepseek\my-imagegen\`（独立仓库），通过与 `godot-asset-planner` **完全相同的 bundle 通道**挂载：

1. **Junction**（把包放进 profile 的 `node_modules`，客户端半端才能被 client-modules 扫描到）

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\godot-imagegen" `
     -Target "D:\deepseek\my-imagegen"
   ```

2. **profile 的 package.json**：`dependencies` 加 `"godot-imagegen": "link:D:/deepseek/my-imagegen"`，
   `dsh.profile.bundles` 数组追加 `"godot-imagegen"`。包自身的 `cordis.patch.yml` 会插入宿主插件行。

   `profiles/desktop`（桌面应用）与 `profiles/web`（`dsh web`）都已按上述方式挂载。

3. **重启 DSH Desktop**：新增 bundle 行在启动时合并，重启前 `/gig` 路由与 `image_*` 工具都不存在。
   之后纯客户端改动（`lib/client.js`）刷新页面即可；宿主改动（`godot-imagegen.ts`）需再次重启。

安装后：

- 工具出现在会话的工具目录里（所有 profile 下的会话共享）；
- 「美术工坊」出现在 better-sidebar（需要 `dsh-better-sidebar`，desktop / web profile 都有）；
- 在面板「设置」里填 **Godot 项目根目录**，之后产物才会带 `res://` 路径。

## 4. 配置项

都写在 profile 的 `cordis.patch.yml` 里，作为 `godot-imagegen` 行的 `config`（全部可选，都有可用默认值）：

```yaml
- id: godot-imagegen
  config:
    godotProject: D:/my-game          # 产物落 <root>/assets/generated 并获得 res:// 路径
    # outDir: D:/art-out              # 显式覆盖输出根目录（优先于 godotProject）
    # unitName: godot_imagegen        # 图库 KV 单元名
    # sdwebuiRoot: D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10
    # sdwebuiPython: D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10/python/python.exe
    # sdwebuiPort: 7860
    # comfyRoot: D:/AKI open/ComfyUI-aki-v2
    # comfyPython: D:/AKI open/ComfyUI-aki-v2/python/python.exe
    # comfyPort: 8188
    # postPython: 后处理解释器（默认用 ComfyUI 的那个）
    # defaultBackend: sdwebui | comfyui
    # sdwebuiModel / comfyModel: 默认 checkpoint 文件名
    # requestTimeoutMs: 1800000     # 单次后端操作超时（默认 30 分钟；SDXL 长任务需要）
    # startTimeoutMs: 360000        # 「启动后端」等待就绪的上限
```

`godotProject` 也可以直接在面板「设置」里填，会存进插件自己的 storage（跨会话保留），不必改配置。

## 5. 工具速查

### `image_generate` — 文生图

必填 `prompt`。关键参数：`category`（`character` / `item` / `ui` / `tile` / `background` / `texture` / `concept`）、
`width` `height` `steps` `cfg_scale` `sampler` `seed` `batch` `model` `backend`、
`transparent` + `transparent_method`（`auto` / `rembg` / `chroma` / `generative`）、`seamless`、
`control_image` + `control_type` + `control_weight`、`project_id` `out_dir`。

`category` 决定落盘子目录、默认尺寸与默认是否透明：

| category | 默认尺寸 | 默认透明 | 说明 |
| --- | --- | --- | --- |
| character | 832×1216 | ✅ | 角色立绘 / 精灵图 |
| item | 1024×1024 | ✅ | 道具 / 技能 / 状态图标 |
| ui | 1024×1024 | ✅ | 按钮 / 边框 / 九宫格 |
| tile | 768×768 | ❌ | 瓦片（默认做无缝平铺后处理） |
| background | 1344×768 | ❌ | 背景 / 视差层 |
| texture | 1024×1024 | ❌ | 3D / PBR 贴图（默认做无缝平铺） |
| concept | 1024×1024 | ❌ | 概念图 |

### 其余七个

- `image_edit` — 图生图 / 局部重绘（`image` + `mask` + `denoise`），支持 ControlNet 保姿势
- `image_variants` — 一次出多个变体（`count`），SD WebUI 走单次 batch
- `image_upscale` — `method: auto|esrgan|lanczos`，优先 SD WebUI 的动漫向 RealESRGAN
- `image_cutout` — `method: auto|rembg|chroma`，输出带 alpha 的 PNG（**首次 rembg 会下载 ~176 MB 的 u2net 模型**）
- `image_interrogate` — 反推提示词：先试内置 deepdanbooru，404 时自动改用 WD14 tagger 扩展
  （**首次调用会下载所选的 ONNX 模型，可能数分钟**），用来对齐已有美术风格
- `image_gallery` — `list` / `delete` / `clear`，按项目与品类过滤
- `image_backend_status` — `status` / `models` / `start` / `stop`

`image` 参数接受三种形式：**绝对路径**、**`res://` 路径**、**图库 id**（如 `img_1a2b3c4d5e6f`）。

### `image_workflow` — 把 ComfyUI 工作流当成可编辑对象

`action`：`list` / `read` / `create` / `patch` / `save` / `to-api` / `to-ui` / `run` / `open` / `delete`

关键是 **`patch` 按参数名改，而不是按下标**：

```jsonc
{ "action": "patch", "id": "sd15-basic",
  "edits": [
    { "classType": "CLIPTextEncode", "title": "正向提示词", "set": { "text": "a red potion, game icon" } },
    { "classType": "KSampler", "set": { "steps": 9, "seed": 1234 } }
  ] }
```

为什么这点很重要：UI 格式的 `widgets_values` 是**位置数组**，而 ComfyUI 给任何带
`control_after_generate` 的 widget（也就是每个 `seed`）**多留一个槽位**。按下标改会让 seed
之后的每个字段整体错位——**不报错，只是安静地出一张参数全乱的图**。本插件的布局是从
`/object_info` 推导的，并且会缓存，所以后端关着也能继续编辑。

`run` 会把工作流跑出来的图按普通生成物一样归档：落进 `<项目>/assets/generated/<品类>/`、
拿到 `res://` 路径、进图库。工作流没有 SaveImage/PreviewImage 节点时会明确报错，而不是空转到超时。

### `image_workshop` — 让代理直接操作面板

`action`：`fill-form` / `focus` / `select-image` / `toast` / `read-state` / `status`

面板在它已有的 1.5s 轮询里一次往返完成两件事：上报自己在看什么（含**未保存的草稿**），取走代理排队的指令。
面板没打开时指令会排队（保留 10 分钟），工具会明确告诉你"已排队、未送达"，而不是假装成功。

## 6. 与 godot-asset-planner 的协作

**不共享 storage。** `godot_asset_planner` 这个 KV 单元每个后端只允许一个活动句柄，归 godot-asset-planner 所有，
所以本插件用自己的 `godot_imagegen` 单元，二者互不干扰。

两条联动路径：

1. **对话里**：`image_generate` 的返回值里就带着 `res://` 路径，直接
   `godot_register_asset(asset_name, asset_type="image", file_path="res://assets/generated/...")`。
2. **面板里**：灯箱的「一键注册」走**同源 HTTP** 调 godot-asset-planner 的 `POST /gap/assets`
   （`{ assetName, assetType:"image", filePath, projectId, linkedGoal? }`），不碰它的存储实现。
   面板顶部会显示从 `/gap/state` 读到的当前 planner 项目作为归属。

## 7. 安全边界

- **只接管、不重复启动**：后端已在运行时 `action=start` 直接复用，绝不新起一个抢端口。
- **绝不终止非本插件启动的进程**：`action=stop` 对你自己用绘世启动器拉起的实例会明确拒绝并说明原因。
- 后端启动是**面板上点按钮才发生**，不会在你不知情时占显存。
- 插件 dispose 时会 abort 在飞任务并关闭 KV 单元，避免热重载后 `unit is already open`。
- **阶段一不写入你的 ComfyUI 安装目录**：工作流库、节点布局缓存、备份目录全部在
  `$DSH_HOME/godot-imagegen/` 下。任何写入 `D:\AKI open\` 的动作（阶段二同步 web 扩展）都会先备份，
  并维护可一键卸载的文件清单。

## 8. 验证

```powershell
cd D:\deepseek\my-imagegen            # 本仓库根目录
npm test                              # = 下面四条离线套件
node tests/test-workflow.mjs          # 65 条断言（工作流层，含 10 个真实 ComfyUI 导出文件）
node tests/test-workflow-library.mjs  # 271 条断言（工作流库、6 套模板、布局缓存）
node tests/test-imagegen.mjs          # 181 条断言（10 个工具 + REST + 真实 Python 后处理）
node tests/test-render-imagegen.mjs   # 71 条断言（客户端面板渲染）
node tests/test-imagegen-live.mjs          # 真实 SD WebUI 端到端（后端没起时自动跳过）
node tests/test-imagegen-live-comfy.mjs    # 真实 ComfyUI 端到端，含真跑内置模板（没起时跳过）
node --check lib/client.js
node D:\deepseek\my-plugins\check-skill-frontmatter.mjs "D:\游戏开发skill"   # 技能 frontmatter / 行尾校验
```

后端起来时总计 **611 条断言**（65 + 271 + 181 + 71 + 23）。

- **离线套件**用两个真实 HTTP 服务冒充 A1111 与 ComfyUI（覆盖 `/sdapi/v1/*`、`/controlnet/model_list`、
  `/tagger/v1/*`、`/prompt`、`/history`、`/view`），并用**真实的秋叶 Python** 跑抠图与放大，
  因此断言的是真实行为而不是 mock 行为；同时覆盖重启持久化与热重载时的 KV 单元释放。
- **客户端套件**用最小 React 替身递归执行每个组件函数（本机磁盘上没有 react/react-dom，
  DSH 的客户端运行时在 app.asar 内），因此未定义标识符、错误的解构、坏的 createElement 调用都会暴露。
- **实时套件**驱动真正安装的 SD WebUI：真实 SD1.5/SDXL 出图、真实 rembg 抠图、真实 R-ESRGAN 放大、
  真实 ControlNet 引导，并断言产物真的落在 Godot 项目的 `assets/generated/<品类>/` 且带 `res://` 路径。

## 9. 已知限制

- **后端调用不使用全局 `fetch`**：undici 有 300s 的 `headersTimeout`/`bodyTimeout` 且无法在无 undici 包时调高，
  真实 SDXL 出图（7GB 换模型 + 采样）会超过它并抛 `UND_ERR_HEADERS_TIMEOUT`。插件改用 `node:http`，
  超时只受自身的 `requestTimeoutMs` 控制。
- **ComfyUI 通道只实现文生图 / 图生图**。它能看到 SD WebUI 共享来的 ControlNet / 放大权重，
  但通过工作流 JSON 驱动 ControlNet、UltimateSDUpscale、WD14 尚未接线；这些能力请走 SD WebUI。
- `transparent_method: generative`（ComfyUI layerdiffuse 直出）已实现工作流接线，
  但需要先把 layerdiffuse 权重放进 `ComfyUI/models/layerdiffuse`（`extra_model_paths` 没有映射它）。
- `image_cutout` 的 `rembg` 首次运行会下载约 176 MB 的 u2net 模型（本机已缓存则瞬间完成）。
- 面板不做九宫格切片、图集打包、调色板量化等"后期"加工——那些更适合放在 Godot 导入侧或技能里。
- RTX 5060 Laptop 上 SDXL 出图偏慢，建议先用 SD1.5 试参数再放大。
