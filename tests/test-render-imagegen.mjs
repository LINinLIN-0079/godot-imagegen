/**
 * Browser-half smoke test for ../lib/client.js.
 *
 * React itself is not resolvable from disk (the DSH client runtime lives inside
 * app.asar), so instead of react-dom/server this drives the bundle with a
 * MINIMAL React stand-in that still executes every component function:
 *
 *   1. the bundle runs as a classic script and hands off via
 *      window.__ModuleLoader__.load({ id, factory });
 *   2. the factory is materialized with a require() that resolves 'react' to the
 *      stand-in;
 *   3. apply() runs against a mock ctx whose `betterSidebar` service captures
 *      the registerTab descriptor;
 *   4. the registered component (and every sub-component) is rendered by
 *      recursively invoking function components, so an undefined identifier, a
 *      bad destructure or a broken createElement call surfaces here.
 *
 * Run with:  node tests/test-render-imagegen.mjs   (from the repo root)
 */
import { readFileSync } from 'node:fs'

let failures = 0
let passes = 0
function assert(cond, label) {
  if (cond) {
    passes++
    console.log(`PASS  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`)
  }
}

// ── minimal React stand-in ──

const ELEMENT = Symbol('element')
let hookCalls = 0
const React = {
  createElement(type, props, ...children) {
    return { [ELEMENT]: true, type, props: props || {}, children }
  },
  useState(initial) {
    hookCalls++
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {
    hookCalls++
  },
  useCallback(fn) {
    hookCalls++
    return fn
  },
  useMemo(fn) {
    hookCalls++
    return fn()
  },
  useRef(value) {
    hookCalls++
    return { current: value }
  },
}

/** Recursively invoke function components; collect rendered text. */
function render(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) render(child, out)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (node[ELEMENT] !== true) return
  const { type, props, children } = node
  if (typeof type === 'function') {
    render(type(Object.assign({}, props, { children })), out)
    return
  }
  for (const child of children) render(child, out)
}

function renderTree(node) {
  const out = []
  render(node, out)
  return out.join(' ')
}

// ── step 1: run the classic-script bundle ──

globalThis.window = {}
let handoff = null
globalThis.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
;(0, eval)(code)

assert(handoff !== null, 'bundle registers a factory via window.__ModuleLoader__.load')
assert(handoff && handoff.id === 'godot-imagegen', 'handoff id matches the client graph entry')

// ── step 2: materialize the factory ──

const plugin = handoff.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
assert(plugin.name === 'godot-imagegen', 'plugin exports its name')
assert(plugin.inject.includes('betterSidebar'), 'plugin injects betterSidebar')
assert(typeof plugin.apply === 'function', 'plugin exports apply')
assert(typeof plugin.ArtStudio === 'function', 'exposes the tab component as a test handle')
for (const handle of ['BackendCard', 'SettingsCard', 'PromptForm', 'JobsStrip', 'Lightbox', 'categoryLabel', 'humanSize']) {
  assert(plugin[handle] !== undefined, `exposes test handle ${handle}`)
}

// ── step 3: apply() against a capturing betterSidebar ──

const descriptors = []
const disposers = []
const ctx = {
  effect(callback) {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  betterSidebar: {
    registerTab(desc) {
      descriptors.push(desc)
      return () => {}
    },
  },
}
plugin.apply(ctx)
assert(descriptors.length === 1, 'apply registers exactly one tab')
assert(descriptors.length === 1 && descriptors[0].id === 'godot-imagegen', 'tab id is godot-imagegen')
assert(descriptors.length === 1 && descriptors[0].title === '美术工坊', 'tab title is 美术工坊')
assert(descriptors.length === 1 && descriptors[0].order === 63, 'tab order is 63 (after the three planner tabs)')
assert(descriptors.length === 1 && descriptors[0].single === true, 'tab is single-instance')
assert(typeof descriptors[0].icon === 'function', 'tab exposes an icon renderer')
assert(descriptors[0].icon(16) && descriptors[0].icon(16)[ELEMENT] === true, 'icon renderer returns an element')
assert(disposers.length === 1 && typeof disposers[0] === 'function', 'apply registers a disposer for the tab')

// ── step 4: render every component ──

const backends = [
  { id: 'sdwebui', label: 'SD WebUI (秋叶 v4.10)', port: 7860, root: 'D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10', running: true, managed: false, detail: '当前模型 waiIllustriousSDXL_v150；ControlNet 16 个', models: ['waiIllustriousSDXL_v150.safetensors', 'anything-v5.safetensors'] },
  { id: 'comfyui', label: 'ComfyUI (秋叶 v2)', port: 8188, root: 'D:/AKI open/ComfyUI-aki-v2', running: false, managed: false, detail: '未运行（端口 8188 无响应）', models: [] },
]

// ArtStudio — the whole panel, with its initial (pre-fetch) state.
let studioText = ''
try {
  studioText = renderTree(React.createElement(plugin.ArtStudio, { ctx }))
  assert(true, 'ArtStudio renders without throwing')
} catch (error) {
  assert(false, `ArtStudio renders without throwing — ${error.message}`)
}
assert(studioText.includes('后端'), 'ArtStudio renders the backend section')
assert(studioText.includes('设置'), 'ArtStudio renders the settings section')
assert(studioText.includes('出图'), 'ArtStudio renders the prompt/generate section')
assert(studioText.includes('图库'), 'ArtStudio renders the gallery section')
assert(studioText.includes('生成'), 'ArtStudio renders the generate button')
assert(studioText.includes('透明背景'), 'ArtStudio renders the transparency toggle')
assert(studioText.includes('无缝平铺'), 'ArtStudio renders the seamless toggle')

// BackendCard — the running/stopped states and the stop-refusal hint.
let backendText = ''
try {
  backendText = renderTree(React.createElement(plugin.BackendCard, {
    backends, postProcessing: { ready: true, detail: '后处理 Python：…python.exe' },
    busy: false, onStart() {}, onStop() {}, onRefresh() {},
  }))
  assert(true, 'BackendCard renders without throwing')
} catch (error) {
  assert(false, `BackendCard renders without throwing — ${error.message}`)
}
assert(backendText.includes('SD WebUI'), 'BackendCard renders the SD WebUI row')
assert(backendText.includes('ComfyUI'), 'BackendCard renders the ComfyUI row')
assert(backendText.includes('7860') && backendText.includes('8188'), 'BackendCard renders both ports')
assert(backendText.includes('启动') && backendText.includes('停止'), 'BackendCard renders start and stop controls')
assert(backendText.includes('后处理'), 'BackendCard renders the post-processing status')

// SettingsCard — the res://-available branch, the no-project warning, and the
// collapsed-by-default behaviour once a project is configured.
let settingsOk = ''
let settingsWarn = ''
let settingsCollapsed = ''
try {
  // Project supplied by plugin config rather than the UI store: the section is
  // still expanded, and the res:// mapping is reported as available.
  settingsOk = renderTree(React.createElement(plugin.SettingsCard, {
    output: { root: 'D:/game/assets/generated', godotProject: 'D:/game' },
    settings: {}, onSave() {},
  }))
  settingsWarn = renderTree(React.createElement(plugin.SettingsCard, {
    output: { root: 'C:/Users/x/.dsh/imagegen-out', godotProject: null },
    settings: {}, onSave() {},
  }))
  // Project persisted by the UI store: the section collapses to save sidebar space.
  settingsCollapsed = renderTree(React.createElement(plugin.SettingsCard, {
    output: { root: 'D:/game/assets/generated', godotProject: 'D:/game' },
    settings: { godotProject: 'D:/game' }, onSave() {},
  }))
  assert(true, 'SettingsCard renders without throwing in all three states')
} catch (error) {
  assert(false, `SettingsCard renders without throwing — ${error.message}`)
}
assert(settingsOk.includes('res:// 映射可用'), 'SettingsCard confirms res:// mapping when a project is set')
assert(settingsOk.includes('已保存'), 'SettingsCard shows the saved state when nothing is dirty')
assert(settingsWarn.includes('未配置 Godot 项目'), 'SettingsCard warns when no Godot project is set')
assert(settingsCollapsed.includes('设置'), 'SettingsCard still renders its header when collapsed')
assert(!settingsCollapsed.includes('Godot 项目根目录'), 'SettingsCard collapses its body once a project is configured')

// PromptForm — presets, params, conditional transparency controls.
const presets = [{
  id: 'item-icon', name: '道具图标', category: 'item', builtin: true,
  prompt: 'game item icon, potion bottle', negativePrompt: 'blurry', width: 1024, height: 1024,
  steps: 28, cfgScale: 7, transparent: true,
}]
const form = {
  presetId: '', category: 'character', prompt: 'test', negativePrompt: '',
  width: 832, height: 1216, steps: 30, cfgScale: 7, seed: -1, count: 1,
  backend: 'auto', model: '', transparent: true, transparentMethod: 'auto',
  seamless: false, controlType: '', controlImage: '',
}
let formText = ''
try {
  formText = renderTree(React.createElement(plugin.PromptForm, {
    form, setForm() {}, presets,
    categories: ['character', 'item', 'ui', 'tile', 'background', 'texture', 'concept'],
    defaults: { character: { width: 832, height: 1216, steps: 30, cfgScale: 7, transparent: true, hint: '角色立绘' } },
    controlTypes: ['openpose', 'lineart', 'canny'], models: ['wai.safetensors'],
    busy: false, onGenerate() {}, onSavePreset() {},
  }))
  assert(true, 'PromptForm renders without throwing (transparent on)')
} catch (error) {
  assert(false, `PromptForm renders without throwing — ${error.message}`)
}
assert(formText.includes('道具图标'), 'PromptForm renders the preset library')
assert(formText.includes('角色'), 'PromptForm renders the category labels')
assert(formText.includes('openpose'), 'PromptForm renders the ControlNet types')
assert(formText.includes('透明方式'), 'PromptForm renders the cutout-method selector when transparency is on')
assert(formText.includes('wai.safetensors'), 'PromptForm renders the model list')

let formHidden = ''
try {
  formHidden = renderTree(React.createElement(plugin.PromptForm, {
    form: Object.assign({}, form, { transparent: false }),
    setForm() {}, presets, categories: ['item'], defaults: {}, controlTypes: [], models: [],
    busy: false, onGenerate() {}, onSavePreset() {},
  }))
  assert(true, 'PromptForm renders without throwing (transparent off, empty option lists)')
} catch (error) {
  assert(false, `PromptForm renders without throwing (transparent off) — ${error.message}`)
}
assert(!formHidden.includes('透明方式'), 'PromptForm hides the cutout-method selector when transparency is off')

// JobsStrip — empty and populated (progress, preview, error).
assert(renderTree(React.createElement(plugin.JobsStrip, { jobs: [], onCancel() {} })) === '',
  'JobsStrip renders nothing when there are no jobs')

let jobsText = ''
try {
  jobsText = renderTree(React.createElement(plugin.JobsStrip, {
    jobs: [
      { id: 'job_1', kind: 'generate', label: '文生图 · potion', status: 'running', progress: 0.42, message: '采样 12/28，剩余约 5s', preview: 'data:image/png;base64,AAAA', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'job_2', kind: 'cutout', label: '抠图 · potion', status: 'error', progress: null, message: 'rembg failed', error: 'rembg failed', images: [], startedAt: '2026-01-01T00:00:00Z' },
    ],
    onCancel() {},
  }))
  assert(true, 'JobsStrip renders without throwing')
} catch (error) {
  assert(false, `JobsStrip renders without throwing — ${error.message}`)
}
assert(jobsText.includes('文生图 · potion'), 'JobsStrip renders the job label')
assert(jobsText.includes('采样 12/28'), 'JobsStrip renders the live progress message')
assert(jobsText.includes('rembg failed'), 'JobsStrip renders the failure message')
assert(jobsText.includes('取消'), 'JobsStrip renders a cancel control for running jobs')

// Lightbox — the full detail overlay including one-click asset registration.
let boxText = ''
try {
  boxText = renderTree(React.createElement(plugin.Lightbox, {
    image: {
      id: 'img_abcdef123456', name: 'potion', category: 'item', op: 'generate',
      filePath: 'D:/game/assets/generated/item/potion.png',
      resPath: 'res://assets/generated/item/potion.png',
      size: 123456, width: 1024, height: 1024, seed: 42,
      backend: 'sdwebui', method: 'rembg', prompt: 'game item icon', projectId: 'default',
      createdAt: '2026-01-01T00:00:00Z',
    },
    plannerProject: 'default', busy: false,
    onClose() {}, onAction() {}, onRegister() {},
  }))
  assert(true, 'Lightbox renders without throwing')
} catch (error) {
  assert(false, `Lightbox renders without throwing — ${error.message}`)
}
assert(boxText.includes('res://assets/generated/item/potion.png'), 'Lightbox shows the res:// path')
assert(boxText.includes('注册为 Godot 资产'), 'Lightbox offers one-click asset registration')
assert(boxText.includes('一键注册'), 'Lightbox renders the register button')
assert(boxText.includes('放大 2×'), 'Lightbox offers upscale')
assert(boxText.includes('抠透明'), 'Lightbox offers cutout')
assert(boxText.includes('反推提示词'), 'Lightbox offers interrogate')
assert(boxText.includes('删除'), 'Lightbox offers delete')
assert(boxText.includes('item'), 'Lightbox labels the category')

// Lightbox with no selection must render nothing rather than throwing.
assert(renderTree(React.createElement(plugin.Lightbox, {
  image: null, plannerProject: 'default', busy: false, onClose() {}, onAction() {}, onRegister() {},
})) === '', 'Lightbox renders nothing when no image is selected')

// Helpers.
assert(plugin.categoryLabel('character') === '角色', 'categoryLabel maps character to 角色')
assert(plugin.categoryLabel('tile') === '瓦片', 'categoryLabel maps tile to 瓦片')
assert(plugin.categoryLabel('unknown') === 'unknown', 'categoryLabel falls back to the raw value')
assert(plugin.humanSize(2048) === '2.0 KB', 'humanSize formats kilobytes')
assert(plugin.humanSize(1048576) === '1.0 MB', 'humanSize formats megabytes')

// Every component must have exercised the stand-in's hooks (i.e. actually run).
assert(hookCalls > 40, `components executed their hooks (${hookCalls} hook calls)`)

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
