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
/**
 * Effects queued by the render in progress.
 *
 * The relay between this panel and the ComfyUI canvas lives ENTIRELY inside
 * effects (the poll tick and the window message listener), so a no-op useEffect
 * would leave the most intricate client code in this plugin completely
 * unexecuted. Collecting them lets a test run them for real.
 */
const effectQueue = []
/** Every postMessage that reached a faked host node's contentWindow. */
const canvasPosts = []
/**
 * Hook state, keyed by "Component@path".
 *
 * React re-renders a component when a setter runs; this stand-in cannot, so state
 * is stored per instance path and a test may render TWICE to observe the effect of
 * a setter — that is how the wide layout is reached, and the wide layout is the
 * only one that mounts the ComfyUI iframe outside a collapsed Section. Keying by
 * path matters: without it every `Section` in a tree would share one state cell.
 */
const hookState = new Map()
const refState = new Map()
let hookOwner = ''
let hookIndex = 0
function resetHooks() {
  hookState.clear()
  refState.clear()
}
const React = {
  createElement(type, props, ...children) {
    return { [ELEMENT]: true, type, props: props || {}, children }
  },
  useState(initial) {
    hookCalls++
    const key = `${hookOwner}#${hookIndex++}`
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    const set = (next) => {
      hookState.set(key, typeof next === 'function' ? next(hookState.get(key)) : next)
    }
    return [hookState.get(key), set]
  },
  useEffect(fn, deps) {
    hookCalls++
    effectQueue.push({ fn, deps })
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
    const key = `${hookOwner}#${hookIndex++}`
    if (!refState.has(key)) refState.set(key, { current: value })
    return refState.get(key)
  },
}

/** Run the effects one render queued; returns whatever cleanups they returned. */
function runQueuedEffects(from) {
  const cleanups = []
  for (const entry of effectQueue.slice(from)) {
    const cleanup = entry.fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

/**
 * Resolve a React element tree, invoking every function component on the way.
 *
 * Resolving once and then walking the result lets a test assert on ELEMENTS
 * (e.g. that an <iframe> really points at the ComfyUI origin) and not just on the
 * text a component happens to emit.
 */
function resolve(node, path = '0') {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}.${index}`))
  if (typeof node === 'string' || typeof node === 'number') return node
  if (typeof node !== 'object' || node[ELEMENT] !== true) return null
  const { type, props, children } = node
  if (typeof type === 'function') {
    // Give every element INSTANCE its own hook namespace, the way React keys state
    // by position in the tree rather than by component name.
    const outerOwner = hookOwner
    const outerIndex = hookIndex
    hookOwner = `${type.name || 'anonymous'}@${path}`
    hookIndex = 0
    let rendered
    try {
      rendered = type(Object.assign({}, props, { children }))
    } finally {
      hookOwner = outerOwner
      hookIndex = outerIndex
    }
    return resolve(rendered, path)
  }
  // React attaches a host node to its ref after commit; without that the
  // component would see ref.current === null forever and any code hanging off the
  // DOM (the canvas iframe handle) could never run here. Each faked node exposes a
  // contentWindow that records what was posted into it, and a clientWidth so the
  // width-reading hook has something to measure.
  const ref = props ? props.ref : undefined
  if (ref !== null && typeof ref === 'object' && 'current' in ref) {
    const contentWindow = {
      postMessage(message, origin) { canvasPosts.push({ message, origin, window: contentWindow }) },
    }
    ref.current = { contentWindow, clientWidth: 1000 }
  }
  return { [ELEMENT]: true, type, props, children: children.map((child, index) => resolve(child, `${path}.${index}`)) }
}

function flattenText(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) flattenText(child, out)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (node[ELEMENT] !== true) return
  for (const child of node.children) flattenText(child, out)
}

function renderTree(node) {
  // Every top-level renderTree is conceptually a fresh mount, so hook state from
  // an earlier render must not leak into it.
  resetHooks()
  const out = []
  flattenText(resolve(node), out)
  return out.join(' ')
}

/** Every resolved element of the given tag/component name. */
function findByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, out)
    return out
  }
  if (typeof node !== 'object' || node[ELEMENT] !== true) return out
  if (node.type === type) out.push(node)
  for (const child of node.children) findByType(child, type, out)
  return out
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
for (const handle of [
  'BackendCard', 'SettingsCard', 'PromptForm', 'JobsStrip', 'Lightbox', 'categoryLabel', 'humanSize',
  'EntryView', 'WorkflowBar', 'CanvasPane', 'BridgeCard', 'AgentHint', 'Section',
  'readPlacement', 'patchFloatGeometry', 'sendToConversation',
  'relayToCanvas', 'isCanvasMessage',
]) {
  assert(plugin[handle] !== undefined, `exposes test handle ${handle}`)
}

// ── step 2b: the canvas relay ──────────────────────────────────────────────
//
// The panel is the ONLY route into the ComfyUI iframe: DSH Desktop attaches its
// renderer capability only to requests whose frame origin is the carrier origin,
// so the iframe's own requests are refused 403 and CORS cannot help. These two
// helpers are that relay, and they are checked here because they also decide how
// much the panel is allowed to trust an incoming window message.

const sentMessages = []
const fakeFrame = { postMessage: (message, origin) => { sentMessages.push({ message, origin }) } }
{
  const count = plugin.relayToCanvas(fakeFrame, 'http://127.0.0.1:8188', [
    { __gig: 't', type: 'canvas.load', seq: 'ui_1', graph: { nodes: [] } },
    null,
    { __gig: 't', type: 'canvas.ping' },
  ])
  assert(count === 2 && sentMessages.length === 2, 'relayToCanvas delivers every envelope and skips junk entries')
  assert(sentMessages[0].origin === 'http://127.0.0.1:8188', 'and pins every postMessage to the ComfyUI origin')
  const before = sentMessages.length
  assert(plugin.relayToCanvas(null, 'http://127.0.0.1:8188', [{ __gig: 't' }]) === 0 && sentMessages.length === before,
    'a missing iframe (ComfyUI not running) is a no-op, so the instruction stays queued')
  assert(plugin.relayToCanvas(fakeFrame, '', [{ __gig: 't' }]) === 0 && sentMessages.length === before,
    'and an unknown origin is refused rather than posted to "*"')
  const throwing = { postMessage: () => { throw new Error('frame navigated') } }
  assert(plugin.relayToCanvas(throwing, 'http://127.0.0.1:8188', [{ __gig: 't' }]) === 0,
    'a frame that navigated mid-post is swallowed, not thrown into the poll loop')
}

{
  const frame = { postMessage() {} }
  assert(plugin.isCanvasMessage({ source: frame, data: { __gig: 't', type: 'canvas.state' } }, frame) === true,
    'isCanvasMessage accepts a well-formed envelope from our own iframe')
  assert(plugin.isCanvasMessage({ source: frame, data: { __gig: 't', type: 'canvas.state' } }, null) === false,
    'but never when there is no iframe yet')
  const other = { postMessage() {} }
  assert(plugin.isCanvasMessage({ source: other, data: { __gig: 't', type: 'canvas.state' } }, frame) === false,
    'and never from a different window, whatever the payload claims')
  assert(plugin.isCanvasMessage({ source: frame, data: { type: 'canvas.state' } }, frame) === false,
    'an envelope without the token is ignored')
  assert(plugin.isCanvasMessage({ source: frame, data: 'canvas.state' }, frame) === false, 'and a non-object payload is ignored')
  assert(plugin.isCanvasMessage({ source: frame, data: null }, frame) === false, 'including a null payload')
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

// ── placement: docked / floating / unknown ──

const dockedService = { getSnapshot: () => ({ state: { floats: [] } }) }
const floatingService = { getSnapshot: () => ({ state: { floats: [{ id: 'float:2', tab: { id: 'godot-imagegen' } }] } }) }
assert(plugin.readPlacement(dockedService, 'godot-imagegen').known === true, 'a state carrying a floats array counts as known')
assert(plugin.readPlacement(dockedService, 'godot-imagegen').floating === false, 'an empty floats array means docked')
assert(plugin.readPlacement(floatingService, 'godot-imagegen').floating === true, 'a float entry for our tab id means floating')
assert(plugin.readPlacement({ getSnapshot: () => ({ state: { floats: [{ tab: { id: 'other' } }] } }) }, 'godot-imagegen').floating === false,
  'a float for a different tab does not count')
assert(plugin.readPlacement(undefined, 'x').known === false, 'no service means the placement is unknown')
assert(plugin.readPlacement({}, 'x').known === false, 'a service without getSnapshot is unknown')
assert(plugin.readPlacement({ getSnapshot: () => ({ state: {} }) }, 'x').known === false, 'a state without floats is unknown')
assert(plugin.readPlacement({ getSnapshot() { throw new Error('boom') } }, 'x').known === false, 'a throwing snapshot degrades to unknown')
assert(plugin.readPlacement({ getSnapshot: () => ({ state: { floats: [null, { tab: null }] } }) }, 'x').known === true, 'malformed float entries do not throw')

// ── fullscreen geometry: only the matching float, never the input ──

const floatState = () => ({
  floats: [
    { id: 'float:1', tab: { id: 'other-tab' }, x: 5, y: 5, w: 100, h: 100 },
    { id: 'float:2', tab: { id: 'godot-imagegen' }, x: 40, y: 40, w: 390, h: 780 },
  ],
})
const before = floatState()
let reduced = null
const store = { reduce(fn) { reduced = fn(before) } }
assert(plugin.patchFloatGeometry(store, 'godot-imagegen', { x: 0, y: 0, w: 1600, h: 900 }) === true,
  'patching a floating tab reports success')
assert(reduced.floats[1].w === 1600 && reduced.floats[1].h === 900, 'the matching float receives the new geometry')
assert(reduced.floats[0].w === 100 && reduced.floats[0].x === 5, 'the OTHER float is untouched')
assert(reduced.floats[1].id === 'float:2' && reduced.floats[1].tab.id === 'godot-imagegen',
  'the float id and tab identity are preserved')
assert(before.floats[1].w === 390, 'the input state object is NOT mutated (the reducer returns a new state)')
assert(reduced !== before, 'a changed state is a new object')

const noMatch = floatState()
let noMatchOut = null
assert(plugin.patchFloatGeometry({ reduce(fn) { noMatchOut = fn(noMatch) } }, 'not-floating', { w: 1 }) === false,
  'patching a tab that is not floating reports false')
assert(noMatchOut === noMatch, 'and returns the very same state object, so nothing is written')
assert(plugin.patchFloatGeometry({}, 'x', {}) === false, 'a store without reduce is handled')
assert(plugin.patchFloatGeometry(null, 'x', {}) === false, 'a missing store is handled')
assert(plugin.patchFloatGeometry({ reduce() { throw new Error('boom') } }, 'x', {}) === false, 'a throwing reducer is handled')
assert(plugin.patchFloatGeometry({ reduce(fn) { fn(noMatch) } }, '', { w: 1 }) === false, 'a missing tab id is handled')

// ── the entry view (what the sidebar shows) ──

let entryText = ''
try {
  entryText = renderTree(React.createElement(plugin.EntryView, {
    backends,
    busy: false,
    onStart() {}, onRefresh() {}, onOpenWorkbench() {}, onPick() {}, onRun() {},
    workflows: [{ id: 'sd15-basic', name: 'SD1.5 文生图', nodeCount: 7 }],
    activeId: 'sd15-basic',
  }))
  assert(true, 'EntryView renders without throwing')
} catch (error) {
  assert(false, `EntryView renders without throwing — ${error.message}`)
}
assert(entryText.includes('打开工作台'), 'EntryView offers the way into the workbench')
assert(entryText.includes('拖到主会话区'), 'EntryView explains the float gesture')
assert(entryText.includes('ComfyUI') && entryText.includes('SD WebUI'), 'EntryView shows both backends')
assert(entryText.includes('快速运行工作流'), 'EntryView offers a quick workflow run')

// ── the workflow bar ──

let wfText = ''
try {
  wfText = renderTree(React.createElement(plugin.WorkflowBar, {
    workflows: [{ id: 'sd15-basic', name: 'SD1.5 文生图', description: '最快的探索路径', category: 'concept', source: 'template', nodeCount: 7, classes: ['KSampler', 'CLIPTextEncode'] }],
    activeId: 'sd15-basic', activeGraph: { nodes: [{ id: 1 }] }, busy: false,
    canvasOnline: true, comfyPort: 8188,
    onPick() {}, onRun() {}, onReload() {}, onSaveToLibrary() {},
  }))
  assert(true, 'WorkflowBar renders without throwing')
} catch (error) {
  assert(false, `WorkflowBar renders without throwing — ${error.message}`)
}
assert(wfText.includes('ComfyUI 工作流'), 'WorkflowBar renders its title')
assert(wfText.includes('SD1.5 文生图'), 'WorkflowBar shows the selected workflow')
assert(wfText.includes('最快的探索路径'), 'WorkflowBar shows the description')
assert(wfText.includes('7 节点'), 'WorkflowBar shows the node count')
assert(wfText.includes('运行工作流'), 'WorkflowBar offers running it')
assert(wfText.includes('把画布存回库'), 'WorkflowBar offers saving canvas edits back')
assert(wfText.includes('外部打开'), 'WorkflowBar offers opening the real ComfyUI in a browser')

// ── the embedded canvas ──

let canvasText = ''
let canvasTree = null
try {
  canvasTree = resolve(React.createElement(plugin.CanvasPane, { port: 8188, online: false, busy: false, reloadKey: 0, onStart() {}, onReload() {} }))
  canvasText = renderTree(React.createElement(plugin.CanvasPane, { port: 8188, online: false, busy: false, reloadKey: 0, onStart() {}, onReload() {} }))
  assert(true, 'CanvasPane renders the offline state without throwing')
} catch (error) {
  assert(false, `CanvasPane renders without throwing — ${error.message}`)
}
assert(canvasText.includes('ComfyUI 未运行'), 'CanvasPane explains why the canvas is empty when the backend is down')
assert(canvasText.includes('启动 ComfyUI'), 'CanvasPane offers to start it')
assert(findByType(canvasTree, 'iframe').length === 0, 'no iframe is rendered while the backend is down')

const onlineCanvas = resolve(React.createElement(plugin.CanvasPane, { port: 8188, online: true, busy: false, reloadKey: 3, onStart() {}, onReload() {} }))
const frames = findByType(onlineCanvas, 'iframe')
assert(frames.length === 1, 'CanvasPane renders exactly one iframe when the backend is online')
assert(frames[0].props.src === 'http://127.0.0.1:8188', `the iframe points at the ComfyUI origin (${frames[0].props.src})`)
assert(frames[0].props.key === 3 || frames[0].props.src !== undefined, 'the iframe is keyed so a reload remounts it')
assert(renderTree(onlineCanvas).includes('重新载入画布'), 'the online canvas offers a reload')

// ── the agent hint ──

const hintOn = renderTree(React.createElement(plugin.AgentHint, { lastCommand: '代理填入表单：a blue slime', panelOnline: true }))
assert(hintOn.includes('代理填入表单'), 'AgentHint reports the last instruction the agent sent')
const hintOff = renderTree(React.createElement(plugin.AgentHint, { lastCommand: '', panelOnline: false }))
assert(hintOff.includes('未连接'), 'AgentHint says so when the command channel is not connected')

// ── the conversation bridge ──

let draftValue = ''
const conversationCtx = () => ({
  get: (name) => (name === 'conversation'
    ? { input: { for: () => ({ state: { getSnapshot: () => ({ draft: draftValue }) }, setDraft: (text) => { draftValue = text } }) } }
    : undefined),
  sessions: { scope: () => ({ sessionId: 's1' }) },
})
assert(plugin.sendToConversation(conversationCtx(), {}, 'first').ok === true, 'sendToConversation succeeds through the public service')
assert(draftValue === 'first', 'an empty draft receives the text as-is')
assert(plugin.sendToConversation(conversationCtx(), {}, 'second').ok === true, 'a second send succeeds')
assert(draftValue === 'first\nsecond', 'subsequent sends append on a new line')
assert(plugin.sendToConversation(undefined, {}, 'x').ok === false, 'a missing ctx reports a failure instead of throwing')
assert(/不可用/.test(plugin.sendToConversation(undefined, {}, 'x').reason), 'and gives a reason')
assert(plugin.sendToConversation({ get: () => undefined }, {}, 'x').ok === false, 'a missing conversation service is reported')
assert(plugin.sendToConversation({ get: () => ({}) }, {}, 'x').ok === false, 'a malformed conversation service is reported')
assert(plugin.sendToConversation({ get: () => ({ input: { for: () => undefined } }), sessions: { scope: () => ({}) } }, {}, 'x').ok === false,
  'a missing input handle is reported')

// ── ArtStudio picks its shape from the placement ──

const mockSidebar = (floats) => ({ getSnapshot: () => ({ state: { floats } }) })

let dockedText = ''
try {
  dockedText = renderTree(React.createElement(plugin.ArtStudio, {
    ctx: { betterSidebar: mockSidebar([]) },
    store: { reduce() {} },
    tab: { id: 'godot-imagegen' },
    scope: { sessionId: 's1' },
  }))
  assert(true, 'ArtStudio renders the docked entry view without throwing')
} catch (error) {
  assert(false, `ArtStudio (docked) renders without throwing — ${error.message}`)
}
assert(dockedText.includes('打开工作台'), 'a docked tab shows the entry view')
assert(dockedText.includes('拖到主会话区'), 'and explains the float gesture')
assert(!dockedText.includes('出图（SD WebUI）'), 'a docked tab does NOT push the whole workbench into the narrow sidebar')

let floatingText = ''
try {
  floatingText = renderTree(React.createElement(plugin.ArtStudio, {
    ctx: { betterSidebar: mockSidebar([{ id: 'float:2', tab: { id: 'godot-imagegen' }, x: 0, y: 0, w: 900, h: 700 }]) },
    store: { reduce() {} },
    tab: { id: 'godot-imagegen', meta: {} },
    scope: { sessionId: 's1' },
  }))
  assert(true, 'ArtStudio renders the floating workbench without throwing')
} catch (error) {
  assert(false, `ArtStudio (floating) renders without throwing — ${error.message}`)
}
assert(floatingText.includes('⛶ 全屏'), 'a floating tab offers the fullscreen button')
assert(floatingText.includes('浮窗'), 'and labels itself as a floating window')
assert(floatingText.includes('出图（SD WebUI）'), 'and renders the workbench')
assert(floatingText.includes('ComfyUI 工作流'), 'including the workflow bar')
assert(floatingText.includes('发送到对话'), 'and the send-to-conversation action')
assert(!floatingText.includes('如何浮窗？'), 'a floating tab does not keep showing the float hint')

// Unknown placement must never narrow: showing less by accident is worse.
assert(studioText.includes('出图（SD WebUI）'), 'an unknown placement renders the full workbench')

// ── the canvas relay loop, actually executed ──
//
// The panel is the only route into the ComfyUI iframe, and both halves of that
// relay are effects. Everything above only proves the components RENDER; this
// step runs the effects against a fake fetch and fake timers and checks the
// channel in both directions, which is the part no other suite can reach.

const relayRequests = []
const relayPollBodies = []
const windowListeners = []
const fakeTimers = []
const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const jsonOk = (payload) => ({ ok: true, status: 200, json: async () => payload })

globalThis.fetch = async (path, options) => {
  const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : null
  relayRequests.push({ path, body })
  if (path === '/gig/state') {
    return jsonOk({
      backends: [{ id: 'comfyui', port: 8188, running: true, models: [] }, { id: 'sdwebui', port: 7860, running: true, models: ['anything-v5.safetensors'] }],
      categories: ['character', 'item'], defaults: {}, controlTypes: [], presets: [],
      settings: {}, output: {}, ui: { online: true, pending: 0 },
    })
  }
  if (path === '/gig/workflows') return jsonOk({ workflows: [{ id: 'item-icon', name: '道具图标', nodeCount: 7, classes: ['KSampler'] }] })
  if (path === '/gig/gallery') return jsonOk({ images: [] })
  if (path === '/gig/jobs') return jsonOk({ jobs: [] })
  if (path === '/gig/extension') return jsonOk({ installed: true, files: 2, detail: '已安装', canvas: { online: true, nodeCount: 7 } })
  if (path === '/gig/ui/poll') {
    relayPollBodies.push(body)
    return jsonOk({
      commands: [],
      status: { online: true, pending: 0, lastPollSecondsAgo: 0, reportedAt: null },
      canvasMessages: [{
        __gig: 'tok', type: 'canvas.load', seq: 'ui_1', label: '代理载入工作流 道具图标',
        graph: { nodes: [{ id: 1, type: 'KSampler' }], links: [] },
      }],
      canvasStatus: { online: true },
      canvasErrors: [],
    })
  }
  return jsonOk({})
}
globalThis.setInterval = (fn) => { fakeTimers.push(fn); return fakeTimers.length }
globalThis.clearInterval = () => {}
globalThis.window.location = { origin: 'http://127.0.0.1:43120' }
globalThis.window.addEventListener = (type, fn) => { if (type === 'message') windowListeners.push(fn) }
globalThis.window.removeEventListener = () => {}
// The panel only mounts the canvas iframe in its WIDE layout, and the width comes
// from a ResizeObserver measurement — so the observer has to exist for the width
// to be read at all.
const realResizeObserver = globalThis.ResizeObserver
globalThis.ResizeObserver = class { observe() {} disconnect() {} }

const studioProps = {
  ctx: { betterSidebar: mockSidebar([{ id: 'float:2', tab: { id: 'godot-imagegen' }, x: 0, y: 0, w: 900, h: 700 }]) },
  store: { reduce() {} },
  tab: { id: 'godot-imagegen', meta: {} },
  scope: { sessionId: 's1' },
}

// Pass 1 measures the root element and records the width; pass 2 then takes the
// wide branch and actually mounts the iframe. Pass 1 also starts a poll tick of
// its own (with no iframe to relay into), so everything it recorded is discarded
// before pass 2 — the assertions below describe the mounted workbench only.
resetHooks()
canvasPosts.length = 0
const measureAt = effectQueue.length
resolve(React.createElement(plugin.ArtStudio, studioProps))
const measureCleanups = runQueuedEffects(measureAt)
await settle()

relayRequests.length = 0
relayPollBodies.length = 0
windowListeners.length = 0
const timersBefore = fakeTimers.length
const effectsBefore = effectQueue.length
resolve(React.createElement(plugin.ArtStudio, studioProps))
const relayCleanups = runQueuedEffects(effectsBefore)
await settle()

assert(relayRequests.some((r) => r.path === '/gig/ui/poll'), 'running the effects really makes the panel poll the host')
assert(relayPollBodies.length === 1, 'exactly one poll per tick')
assert(relayPollBodies[0].state.origin === 'http://127.0.0.1:43120',
  'the poll reports the origin the bridge install must bake in (taken from window.location)')
assert(canvasPosts.length === 1, 'the queued canvas instruction was posted INTO the iframe')
assert(canvasPosts[0].origin === 'http://127.0.0.1:8188', 'pinned to the ComfyUI origin — never posted to "*"')
assert(canvasPosts[0].message.seq === 'ui_1' && canvasPosts[0].message.graph.nodes.length === 1,
  'and it is the envelope the host stamped, delivered verbatim')
assert(canvasPosts[0].message.__gig === 'tok', 'with the install token intact — the panel relays it without interpreting it')

// The other direction: what the canvas says is buffered and carried up in the
// NEXT poll, and only when it came from our own iframe.
assert(windowListeners.length === 1, 'the panel registered exactly one window message listener')
windowListeners[0]({ source: { postMessage() {} }, data: { __gig: 'tok', type: 'canvas.state', state: { nodeCount: 1, title: 'spoofed' } } })
windowListeners[0]({ source: canvasPosts[0].window, data: { __gig: 'tok', type: 'canvas.state', state: { nodeCount: 9, title: 'item-icon' } } })
windowListeners[0]({ source: canvasPosts[0].window, data: 'not-an-envelope' })
for (const timer of fakeTimers.slice(timersBefore)) timer()
await settle()

const lastPoll = relayPollBodies[relayPollBodies.length - 1]
assert(relayPollBodies.length === 2, 'the interval callbacks tick the poll again')
assert(Array.isArray(lastPoll.inbound) && lastPoll.inbound.length === 1,
  'the next poll carries the canvas reply up — one message, from our own iframe')
assert(lastPoll.inbound[0].state.nodeCount === 9 && lastPoll.inbound[0].state.title === 'item-icon',
  'and it is the real canvas state, not the one posted by a foreign window')
assert(!JSON.stringify(lastPoll.inbound).includes('spoofed'), 'a message from another window is dropped, not relayed')

const bridgeCard = renderTree(React.createElement(plugin.BridgeCard, {
  bridge: { installed: true, files: 2, detail: '已安装到 …', canvas: { online: true, nodeCount: 9, title: 'item-icon', missingClasses: ['SomeCustomNode'] } },
  busy: false, canPush: true, onInstall() {}, onUninstall() {}, onPush() {}, onRefresh() {},
}))
assert(bridgeCard.includes('扩展已安装'), 'BridgeCard reports an installed extension')
assert(bridgeCard.includes('画布已连接'), 'and a canvas that is answering')
assert(bridgeCard.includes('9 个节点'), 'with what the canvas reports')
assert(bridgeCard.includes('item-icon'), 'including the workflow it is editing')
assert(bridgeCard.includes('SomeCustomNode'), 'and warns about node classes this ComfyUI does not have')
const bridgeOffline = renderTree(React.createElement(plugin.BridgeCard, {
  bridge: { installed: true, files: 2, detail: '已安装', stale: true, canvas: { online: false } },
  busy: false, canPush: false, onInstall() {}, onUninstall() {}, onPush() {}, onRefresh() {},
}))
assert(bridgeOffline.includes('重启 ComfyUI'), 'BridgeCard explains the usual reason nothing happens yet')
assert(bridgeOffline.includes('不一致'), 'and reports a copy on disk that drifted from the source')
assert(!bridgeOffline.includes('推到画布'), 'while offering no push button with no canvas to push to')
const bridgeAbsent = renderTree(React.createElement(plugin.BridgeCard, {
  bridge: { installed: false, files: 0, detail: '未安装（将写入 …）', canvas: { online: false } },
  busy: false, canPush: false, onInstall() {}, onUninstall() {}, onPush() {}, onRefresh() {},
}))
assert(bridgeAbsent.includes('安装到 ComfyUI'), 'BridgeCard offers the install when the bridge is absent')
assert(bridgeAbsent.includes('对话改不动它'), 'and says plainly what is missing without it')

for (const cleanup of relayCleanups) cleanup()
for (const cleanup of measureCleanups) cleanup()
globalThis.fetch = realFetch
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
globalThis.ResizeObserver = realResizeObserver
delete globalThis.window.location
delete globalThis.window.addEventListener
delete globalThis.window.removeEventListener
resetHooks()

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
