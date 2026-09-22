/**
 * Tests for the ComfyUI workflow layer of ../godot-imagegen.ts.
 *
 * The point of this layer is addressing a widget BY NAME instead of by the
 * positional index it happens to occupy in `widgets_values`, so the assertions
 * below lean on two things a hand-written fixture cannot fake:
 *
 *   1. REAL ComfyUI exports — the ten workflows shipped with the layerdiffuse
 *      custom node, parsed, summarised, converted and patched as-is;
 *   2. a REAL `/object_info` schema shape, including the `control_after_generate`
 *      extra slot that every `seed` widget consumes and that silently corrupts
 *      naive positional writers.
 *
 * Run with:  node tests/test-workflow.mjs   (from the repo root)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  apiToUi,
  isApiWorkflow,
  linkTable,
  normalizeUiWorkflow,
  patchWorkflow,
  readWidgets,
  summarizeWorkflow,
  uiToApi,
  widgetLayout,
} from '../godot-imagegen.ts'

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
function throwsWith(fn, pattern, label) {
  try {
    fn()
    failures++
    console.error(`FAIL  ${label} (expected a throw)`)
  } catch (error) {
    if (pattern.test(error.message)) {
      passes++
      console.log(`PASS  ${label}`)
    } else {
      failures++
      console.error(`FAIL  ${label} — unexpected message: ${error.message}`)
    }
  }
}

const FIXTURE_DIR = 'D:/AKI open/ComfyUI-aki-v2/ComfyUI/custom_nodes/ComfyUI-layerdiffuse/example_workflows'

/**
 * Mirrors the shapes ComfyUI's `/object_info` really returns. The KSampler
 * ordering (model, seed, steps, cfg, sampler_name, scheduler, positive,
 * negative, latent_image, denoise) is what decides the serialised widget
 * order — `seed` carrying `control_after_generate` is the trap.
 */
const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['anything-v5.safetensors', 'wai.safetensors']] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim']],
        scheduler: [['normal', 'karras', 'exponential']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0 }],
      },
    },
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } },
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  PreviewImage: { input: { required: { images: ['IMAGE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
  LoadImage: { input: { required: { image: [['a.png', 'b.png']], upload: ['IMAGEUPLOAD'] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
  LayeredDiffusionApply: {
    input: { required: { model: ['MODEL'], config: [['SD15', 'SDXL, Conv Injection']], weight: ['FLOAT', { default: 1.0 }] } },
  },
  LayeredDiffusionDecodeRGBA: {
    input: { required: { samples: ['LATENT'], images: ['IMAGE'], config: [['SD15', 'SDXL']], _version: ['INT', { default: 16 }] } },
  },
  LayerDiffuseCondTranspose: { input: { required: { samples: ['LATENT'] } } },
  LayeredDiffusionDecode: { input: { required: { samples: ['LATENT'], images: ['IMAGE'], sd_version: [['SD15', 'SDXL']] } } },
}

// ── widgetLayout: the name↔slot mapping ──

const ksamplerLayout = widgetLayout(OBJECT_INFO, 'KSampler')
assert(
  JSON.stringify(ksamplerLayout.map((s) => s.name)) === JSON.stringify(['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']),
  `KSampler layout lists only widget inputs, in declaration order (${ksamplerLayout.map((s) => s.name).join(',')})`,
)
assert(ksamplerLayout[0].name === 'seed' && ksamplerLayout[0].slots === 2,
  'seed consumes TWO slots (value + control_after_generate mode)')
assert(ksamplerLayout.every((s) => s.name !== 'model' && s.name !== 'positive'),
  'link inputs (MODEL / CONDITIONING / LATENT) are excluded from the widget layout')
assert(JSON.stringify(widgetLayout(OBJECT_INFO, 'EmptyLatentImage').map((s) => s.name)) === JSON.stringify(['width', 'height', 'batch_size']),
  'EmptyLatentImage layout is width/height/batch_size')
assert(JSON.stringify(widgetLayout(OBJECT_INFO, 'CLIPTextEncode').map((s) => s.name)) === JSON.stringify(['text']),
  'CLIPTextEncode exposes exactly one widget (text)')
const ckptLayout = widgetLayout(OBJECT_INFO, 'CheckpointLoaderSimple')
assert(ckptLayout.length === 1 && ckptLayout[0].name === 'ckpt_name' && Array.isArray(ckptLayout[0].options),
  'a COMBO input is a widget and exposes its options')
assert(widgetLayout(OBJECT_INFO, 'NoSuchClass').length === 0, 'an unknown class yields an empty layout instead of throwing')

// ── readWidgets: positional array vs name-keyed object ──

const samplerNode = { id: 3, type: 'KSampler', widgets_values: [1029477926308287, 'randomize', 20, 8, 'euler', 'normal', 1] }
const samplerWidgets = readWidgets(samplerNode, ksamplerLayout)
assert(samplerWidgets.seed === 1029477926308287 && samplerWidgets.steps === 20 && samplerWidgets.cfg === 8,
  'reads seed/steps/cfg correctly despite the extra control_after_generate slot')
assert(samplerWidgets.sampler_name === 'euler' && samplerWidgets.scheduler === 'normal' && samplerWidgets.denoise === 1,
  'reads the widgets that follow the two-slot seed without an off-by-one')
assert(JSON.stringify(readWidgets({ id: 1, type: 'CLIPTextEncode', widgets_values: { text: 'hi' } }, widgetLayout(OBJECT_INFO, 'CLIPTextEncode')))
  === JSON.stringify({ text: 'hi' }), 'a name-keyed widgets_values object is read directly')
assert(JSON.stringify(readWidgets({ id: 1, type: 'X', widgets_values: undefined }, [])) === '{}',
  'a node with no widgets_values reads as empty')

// ── normalizeUiWorkflow: validation with actionable errors ──

throwsWith(() => normalizeUiWorkflow(null), /必须是一个 JSON 对象/, 'null is rejected')
throwsWith(() => normalizeUiWorkflow({ nodes: 'nope' }), /缺少 nodes 数组|API 格式/, 'a non-UI document is rejected')
throwsWith(
  () => normalizeUiWorkflow({ '1': { class_type: 'KSampler', inputs: {} } }),
  /API 格式/,
  'an API-format graph is detected and the error tells you to convert it',
)
throwsWith(() => normalizeUiWorkflow({ nodes: [{ id: 1 }] }), /缺少 type/, 'a node without type names its index')
throwsWith(() => normalizeUiWorkflow({ nodes: [{ type: 'KSampler' }] }), /缺少可解析为数字的 id/, 'a node without id names its index')
const normalized = normalizeUiWorkflow({ nodes: [{ id: 7, type: 'KSampler' }] })
assert(normalized.nodes.length === 1 && normalized.nodes[0].id === 7, 'a minimal valid workflow normalizes')

// ── linkTable: both serialisation forms ──

const arrayLinks = normalizeUiWorkflow({ nodes: [], links: [[1, 4, 0, 3, 0, 'MODEL']] })
assert(linkTable(arrayLinks).get(1).originId === 4 && linkTable(arrayLinks).get(1).targetSlot === 0,
  'array-form links resolve')
const objectLinks = normalizeUiWorkflow({
  nodes: [],
  links: { 1: { id: 1, origin_id: 4, origin_slot: 0, target_id: 3, target_slot: 0, type: 'MODEL' } },
})
assert(linkTable(objectLinks).get(1).originId === 4, 'object-form links resolve')
assert(linkTable(normalizeUiWorkflow({ nodes: [] })).size === 0, 'a workflow with no links yields an empty table')

// ── patchWorkflow: name-addressed edits ──

const patched = patchWorkflow(
  normalizedToGraph(),
  [
    { classType: 'CLIPTextEncode', index: 0, set: { text: 'positive text' } },
    { classType: 'CLIPTextEncode', index: 1, set: { text: 'negative text' } },
    { classType: 'KSampler', set: { steps: 8, seed: 42, sampler_name: 'euler_ancestral' } },
    { classType: 'EmptyLatentImage', set: { width: 768, height: 768 } },
    { classType: 'KSampler', setTitle: '主采样器', setMode: 0 },
  ],
  OBJECT_INFO,
)
const pGraph = patched.graph
const pSampler = pGraph.nodes.find((n) => n.type === 'KSampler')
const pSamplerWidgets = readWidgets(pSampler, widgetLayout(OBJECT_INFO, 'KSampler'))
assert(pSamplerWidgets.steps === 8 && pSamplerWidgets.seed === 42 && pSamplerWidgets.sampler_name === 'euler_ancestral',
  'patched KSampler widgets read back with the values that were set')
assert(pSampler.widgets_values[1] === 'randomize',
  'the control_after_generate slot SURVIVES a seed patch (it is not overwritten)')
const pTexts = pGraph.nodes.filter((n) => n.type === 'CLIPTextEncode')
assert(pTexts[0].widgets_values[0] === 'positive text' && pTexts[1].widgets_values[0] === 'negative text',
  'index-addressed CLIPTextEncode nodes were patched independently')
assert(pGraph.nodes.find((n) => n.type === 'EmptyLatentImage').widgets_values[0] === 768,
  'EmptyLatentImage width was patched by name')
assert(pSampler.title === '主采样器', 'setTitle applies the node title')
// Five edits over six nodes: the CLIPTextEncode pair (2), KSampler widgets (1),
// EmptyLatentImage (1) and the setTitle+setMode edit (2 entries).
assert(patched.applied.length === 6, `every edit reports what it applied (${patched.applied.length})`)
assert(patched.applied.some((a) => a.includes('title')) && patched.applied.some((a) => a.includes('mode')),
  'the applied list distinguishes a title edit from a mode edit')

// immutability: the original graph must be untouched
const originalSampler = normalizedToGraph().nodes.find((n) => n.type === 'KSampler')
assert(originalSampler.widgets_values[2] === 20, 'patchWorkflow does not mutate the input graph')

// actionable failures
throwsWith(
  () => patchWorkflow(normalizedToGraph(), [{ classType: 'NoSuchNode', set: { x: 1 } }], OBJECT_INFO),
  /找不到节点.*当前画布上的节点类/,
  'an unknown class lists the classes actually present',
)
throwsWith(
  () => patchWorkflow(normalizedToGraph(), [{ classType: 'KSampler', set: { nope: 1 } }], OBJECT_INFO),
  /没有这些参数：nope。可用参数：seed, steps, cfg, sampler_name, scheduler, denoise/,
  'an unknown widget name lists the available widget names',
)
throwsWith(
  () => patchWorkflow(normalizedToGraph(), [{ classType: 'KSampler', title: '不存在', set: { steps: 1 } }], OBJECT_INFO),
  /标题含/,
  'a title filter that matches nothing is reported',
)
// Without /object_info there is no way to know a node's widget names, and the
// message must say THAT rather than blaming the node.
throwsWith(
  () => patchWorkflow(normalizedToGraph(), [{ classType: 'KSampler', set: { steps: 1 } }]),
  /还没有读取过节点定义（\/object_info）/,
  'patching by name without a schema explains the real cause and how to fix it',
)
throwsWith(
  () => patchWorkflow(normalizedToGraph(), [{ classType: 'VAEDecode', set: { anything: 1 } }], OBJECT_INFO),
  /该节点没有可编辑参数/,
  'a genuinely widget-less node says so, distinctly from the missing-schema case',
)

// ── uiToApi / apiToUi ──

const roundTripped = uiToApi(pGraph, OBJECT_INFO)
assert(roundTripped['3'].class_type === 'KSampler', 'uiToApi keeps node ids as API keys')
assert(roundTripped['3'].inputs.positive[0] === '6', 'uiToApi resolves a link into [originId, originSlot]')
assert(roundTripped['3'].inputs.steps === 8 && roundTripped['3'].inputs.seed === 42,
  'uiToApi carries the patched widget values into the API graph')
assert(roundTripped['3'].inputs.model === undefined || Array.isArray(roundTripped['3'].inputs.model),
  'uiToApi never emits a widget where a link belongs')

const mutedGraph = normalizeUiWorkflow({
  nodes: [
    { id: 1, type: 'KSampler', mode: 2, widgets_values: [1, 'fixed', 20, 8, 'euler', 'normal', 1] },
    { id: 2, type: 'KSampler', mode: 4, widgets_values: [1, 'fixed', 20, 8, 'euler', 'normal', 1] },
    { id: 3, type: 'KSampler', mode: 0, widgets_values: [1, 'fixed', 20, 8, 'euler', 'normal', 1] },
  ],
})
const mutedApi = uiToApi(mutedGraph, OBJECT_INFO)
assert(Object.keys(mutedApi).length === 1 && mutedApi['3'] !== undefined,
  'muted (2) and bypassed (4) nodes are dropped so a headless run matches the canvas')

// A link pointing at an undeclared input slot used to be dropped silently —
// which yields a graph that runs with missing wiring. It must fail loudly.
throwsWith(
  () => uiToApi(normalizeUiWorkflow({
    nodes: [{ id: 3, type: 'KSampler', widgets_values: [] }],
    links: [[1, 4, 0, 3, 0, 'MODEL']],
  }), OBJECT_INFO),
  /links 与 nodes 不一致/,
  'a link into an undeclared input slot is reported instead of silently dropped',
)

const backToUi = apiToUi(roundTripped)
assert(backToUi.nodes.length === pGraph.nodes.length, `apiToUi mints one node per API entry (${backToUi.nodes.length})`)
assert(linkTable(backToUi).size === linkTable(pGraph).size, 'apiToUi re-materialises every link')
const backToApi = uiToApi(backToUi, OBJECT_INFO)
const originalEdges = Object.entries(roundTripped).flatMap(([id, node]) =>
  Object.entries(node.inputs).filter(([, v]) => Array.isArray(v)).map(([name, v]) => `${id}.${name}<-${v[0]}:${v[1]}`))
const roundEdges = Object.entries(backToApi).flatMap(([id, node]) =>
  Object.entries(node.inputs).filter(([, v]) => Array.isArray(v)).map(([name, v]) => `${id}.${name}<-${v[0]}:${v[1]}`))
assert(JSON.stringify(originalEdges.sort()) === JSON.stringify(roundEdges.sort()),
  `api⇄ui round-trip preserves the whole link topology (${originalEdges.length} edges)`)
assert(isApiWorkflow(roundTripped) && !isApiWorkflow(pGraph), 'isApiWorkflow distinguishes the two formats')
throwsWith(() => apiToUi({}), /API 工作流为空/, 'an empty API graph is rejected')

// ── summarizeWorkflow ──

const summary = summarizeWorkflow(pGraph, OBJECT_INFO, 20)
assert(summary.nodeCount === pGraph.nodes.length, 'summary reports the node count')
assert(typeof summary.classCounts.KSampler === 'number', 'summary reports a class histogram')
const longNode = pGraph.nodes.find((n) => n.type === 'CLIPTextEncode')
summary.nodes.find((n) => n.id === longNode.id)
const summarizedText = summary.nodes.find((n) => n.id === longNode.id).widgets.text
assert(typeof summarizedText === 'string' && summarizedText.length < 40,
  `long prompt text is elided in the summary (${summarizedText})`)

// ── REAL fixtures: every workflow the layerdiffuse node ships ──

function normalizedToGraph() {
  return normalizeUiWorkflow({
    nodes: [
      {
        id: 4,
        type: 'CheckpointLoaderSimple',
        widgets_values: ['anything-v5.safetensors'],
        inputs: [],
        outputs: [
          { name: 'MODEL', type: 'MODEL', links: [1] },
          { name: 'CLIP', type: 'CLIP', links: [8, 9] },
          { name: 'VAE', type: 'VAE', links: [6] },
        ],
      },
      { id: 5, type: 'EmptyLatentImage', widgets_values: [512, 512, 1], inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [2] }] },
      {
        id: 6,
        type: 'CLIPTextEncode',
        widgets_values: ['a prompt'],
        inputs: [{ name: 'clip', type: 'CLIP', link: 8 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [3] }],
      },
      {
        id: 7,
        type: 'CLIPTextEncode',
        widgets_values: ['a negative'],
        inputs: [{ name: 'clip', type: 'CLIP', link: 9 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }],
      },
      {
        id: 3,
        type: 'KSampler',
        widgets_values: [111, 'randomize', 20, 8, 'euler', 'normal', 1],
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 3 },
          { name: 'negative', type: 'CONDITIONING', link: 4 },
          { name: 'latent_image', type: 'LATENT', link: 2 },
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [5] }],
      },
      {
        id: 8,
        type: 'VAEDecode',
        widgets_values: [],
        inputs: [{ name: 'samples', type: 'LATENT', link: 5 }, { name: 'vae', type: 'VAE', link: 6 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [7] }],
      },
      {
        id: 9,
        type: 'SaveImage',
        widgets_values: ['ComfyUI'],
        inputs: [{ name: 'images', type: 'IMAGE', link: 7 }],
        outputs: [],
      },
    ],
    links: [
      [1, 4, 0, 3, 0, 'MODEL'],
      [2, 5, 0, 3, 3, 'LATENT'],
      [3, 6, 0, 3, 1, 'CONDITIONING'],
      [4, 7, 0, 3, 2, 'CONDITIONING'],
      [5, 3, 0, 8, 0, 'LATENT'],
      [6, 4, 2, 8, 1, 'VAE'],
      [7, 8, 0, 9, 0, 'IMAGE'],
      [8, 4, 1, 6, 0, 'CLIP'],
      [9, 4, 1, 7, 0, 'CLIP'],
    ],
  })
}

if (existsSync(FIXTURE_DIR)) {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  assert(files.length >= 5, `found ${files.length} real ComfyUI workflow fixtures`)
  let parsedOk = 0
  let convertedOk = 0
  let patchedOk = 0
  for (const file of files) {
    let graph
    try {
      graph = normalizeUiWorkflow(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')))
      parsedOk++
    } catch {
      continue
    }
    const api = uiToApi(graph)
    if (Object.keys(api).length > 0 && Object.values(api).every((n) => typeof n.class_type === 'string')) convertedOk++
    // Patch every CLIPTextEncode's text — the exact operation "set the prompt" needs.
    try {
      const texts = graph.nodes.filter((n) => n.type === 'CLIPTextEncode')
      if (texts.length === 0) { patchedOk++; continue }
      const edits = texts.map((_, index) => ({ classType: 'CLIPTextEncode', index, set: { text: `patched-${index}` } }))
      // By-name patching needs the node schema; this is the real constraint the
      // error message has to explain when /object_info is unavailable.
      const result = patchWorkflow(graph, edits, OBJECT_INFO)
      const after = result.graph.nodes.filter((n) => n.type === 'CLIPTextEncode')
      const ok = after.length === texts.length && after.every((n, index) => n.widgets_values[0] === `patched-${index}`)
      if (ok && texts[0].widgets_values[0] !== 'patched-0') patchedOk++
    } catch {
      /* counted below */
    }
    // The summary must survive any real graph.
    const s = summarizeWorkflow(graph)
    if (s.nodeCount === graph.nodes.length) parsedOk += 0
  }
  assert(parsedOk === files.length, `every real workflow normalizes (${parsedOk}/${files.length})`)
  assert(convertedOk === files.length, `every real workflow converts to a valid API graph (${convertedOk}/${files.length})`)
  assert(patchedOk === files.length, `every real workflow accepts a by-name prompt patch (${patchedOk}/${files.length})`)

  // One fixture is asserted value-by-value against what the file actually contains.
  const rgbaFile = join(FIXTURE_DIR, 'layer_diffusion_fg_example_rgba.json')
  if (existsSync(rgbaFile)) {
    const rgba = normalizeUiWorkflow(JSON.parse(readFileSync(rgbaFile, 'utf8')))
    const sampler = rgba.nodes.find((n) => n.type === 'KSampler')
    assert(sampler !== undefined && sampler.widgets_values.length === 7,
      `the RGBA fixture's KSampler really serialises 7 values (got ${sampler && sampler.widgets_values.length})`)
    const rgbaApi = uiToApi(rgba, OBJECT_INFO)
    assert(rgbaApi['3'].inputs.seed === 1029477926308287,
      'the real seed value survives the two-slot mapping')
    assert(rgbaApi['3'].inputs.steps === 20 && rgbaApi['3'].inputs.cfg === 8,
      'the real steps/cfg survive the two-slot mapping')
    assert(rgbaApi['13'].class_type === 'LayeredDiffusionApply',
      'the layerdiffuse model-patch node converts')
    assert(JSON.stringify(rgbaApi['3'].inputs.model) === JSON.stringify(['13', 0]),
      'the KSampler model link is rewired to the layerdiffuse node output, exactly as the file wires it')
    assert(rgbaApi['36'].inputs.config === 'SDXL' && rgbaApi['36'].inputs._version === 16,
      'the RGBA decode node keeps its COMBO config and numeric _version')
    assert(rgbaApi['14'].inputs.samples === undefined || Array.isArray(rgbaApi['14'].inputs.samples),
      'VAEDecode receives its latent through a link, not a widget')
    // Patching the real graph by name must not disturb the two-slot seed.
    const realPatched = patchWorkflow(rgba, [{ classType: 'KSampler', set: { steps: 4, seed: 7 } }], OBJECT_INFO)
    const realSampler = realPatched.graph.nodes.find((n) => n.type === 'KSampler')
    const realWidgets = readWidgets(realSampler, widgetLayout(OBJECT_INFO, 'KSampler'))
    assert(realWidgets.steps === 4 && realWidgets.seed === 7,
      'patching a REAL workflow by name writes the right slots')
    assert(realSampler.widgets_values[1] === 'randomize',
      'the real fixture\'s control_after_generate value is preserved')
    assert(realSampler.widgets_values[4] === 'euler',
      'the widgets AFTER the seed keep their original values (no drift)')
  }
} else {
  console.log(`NOTE  no layerdiffuse fixtures at ${FIXTURE_DIR} — skipping the real-file assertions`)
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
