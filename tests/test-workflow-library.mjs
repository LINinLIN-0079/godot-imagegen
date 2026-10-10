/**
 * Tests for the plugin-local workflow library and the layout cache
 * (../godot-imagegen.ts).
 *
 * The library is where a workflow stops being a JSON blob and becomes something
 * the user owns: built-in templates seeded on first use, plain JSON files under
 * the DSH data root, metadata carried inside the document itself.
 *
 * The load-bearing assertions here are about the TEMPLATES actually being valid
 * ComfyUI documents — in particular that every KSampler serialises SEVEN widget
 * values (seed, control_after_generate, steps, cfg, sampler, scheduler, denoise).
 * A template with six would open on the canvas with every field after the seed
 * shifted by one, and nothing would complain.
 *
 * Run with:  node tests/test-workflow-library.mjs   (from the repo root)
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKFLOW_META_KEY,
  WORKFLOW_TEMPLATES,
  compactLayouts,
  createLayoutCache,
  createWorkflowLibrary,
  linkTable,
  readWidgets,
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
async function rejects(fn, pattern, label) {
  try {
    await fn()
    failures++
    console.error(`FAIL  ${label} (expected a rejection)`)
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

const workRoot = await mkdtemp(join(tmpdir(), 'giglib-'))
const cfg = { dataRoot: join(workRoot, 'data') }
const library = createWorkflowLibrary(cfg)

/**
 * A compact layout map mirroring the REAL slot shapes (verified against the live
 * server), so the offline assertions do not need ComfyUI running. The live block
 * at the bottom re-checks every template against the real `/object_info`.
 */
const TEMPLATE_LAYOUTS = {
  CheckpointLoaderSimple: [{ name: 'ckpt_name', slots: 1 }],
  CLIPTextEncode: [{ name: 'text', slots: 1 }],
  EmptyLatentImage: [{ name: 'width', slots: 1 }, { name: 'height', slots: 1 }, { name: 'batch_size', slots: 1 }],
  KSampler: [
    { name: 'seed', slots: 2 },
    { name: 'steps', slots: 1 },
    { name: 'cfg', slots: 1 },
    { name: 'sampler_name', slots: 1 },
    { name: 'scheduler', slots: 1 },
    { name: 'denoise', slots: 1 },
  ],
  SaveImage: [{ name: 'filename_prefix', slots: 1 }],
  LoadImage: [{ name: 'image', slots: 1 }],
  UpscaleModelLoader: [{ name: 'model_name', slots: 1 }],
  VAEDecode: [],
  VAEEncode: [],
  ImageUpscaleWithModel: [],
}

// ── seeding ──

await library.ensure()
const seededFiles = await readdir(library.root)
assert(seededFiles.filter((f) => f.endsWith('.json')).length === WORKFLOW_TEMPLATES.length,
  `ensure() seeds exactly the ${WORKFLOW_TEMPLATES.length} built-in templates`)
assert(library.root.startsWith(cfg.dataRoot), 'the library lives under the plugin data root, never inside the ComfyUI install')

await library.ensure()
assert((await readdir(library.root)).filter((f) => f.endsWith('.json')).length === WORKFLOW_TEMPLATES.length,
  'ensure() is idempotent — a second call does not duplicate or resurrect anything')

// ── listing ──

const listed = await library.list()
assert(listed.length === WORKFLOW_TEMPLATES.length, `list() reflects the real directory (${listed.length})`)
assert(listed.every((w) => w.meta.name !== '' && typeof w.nodeCount === 'number'), 'every listing carries meta and a node count')
const basic = listed.find((w) => w.id === 'sd15-basic')
assert(basic !== undefined && basic.nodeCount === 7, 'the SD1.5 template lists its 7 nodes')
assert(basic.meta.source === 'template', 'seeded workflows are marked as templates')
assert(basic.classCounts.KSampler === 1 && basic.classCounts.CLIPTextEncode === 2, 'the listing includes a class histogram')

// ── every template must be a VALID ComfyUI document ──

for (const template of WORKFLOW_TEMPLATES) {
  const { graph } = await library.read(template.id)
  assert(graph.nodes.length === template.nodes.length, `${template.id}: node count round-trips (${graph.nodes.length})`)
  assert(linkTable(graph).size === template.links.length, `${template.id}: every link round-trips (${linkTable(graph).size})`)

  // The two-slot seed: 7 values, not 6.
  const sampler = graph.nodes.find((n) => n.type === 'KSampler')
  if (sampler !== undefined) {
    assert(sampler.widgets_values.length === 7,
      `${template.id}: KSampler serialises 7 widget values (two-slot seed) — got ${sampler.widgets_values.length}`)
    assert(['fixed', 'increment', 'decrement', 'randomize'].includes(sampler.widgets_values[1]),
      `${template.id}: the control_after_generate slot holds a real mode (${sampler.widgets_values[1]})`)
    assert(typeof sampler.widgets_values[2] === 'number' && typeof sampler.widgets_values[3] === 'number',
      `${template.id}: steps and cfg sit at slots 2 and 3, not shifted`)
    assert(sampler.widgets_values[6] === 1 || typeof sampler.widgets_values[6] === 'number',
      `${template.id}: denoise is still in the last slot`)
  }

  // Every non-widget input must be linked, or the graph is incomplete.
  for (const node of graph.nodes) {
    for (const input of node.inputs ?? []) {
      assert(input.link !== null && input.link !== undefined,
        `${template.id}: ${node.type}.${input.name} is wired`)
    }
  }

  // The graph must convert to an API graph the server would accept. This also
  // exercises the "link into an undeclared input slot" guard.
  const api = uiToApi(graph, TEMPLATE_LAYOUTS)
  assert(Object.keys(api).length === graph.nodes.length, `${template.id}: converts to one API node per canvas node`)
  assert(Object.values(api).every((n) => typeof n.class_type === 'string' && n.inputs !== undefined),
    `${template.id}: every API node has a class_type and inputs`)
  for (const [id, node] of Object.entries(api)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      const isLink = Array.isArray(value)
      assert(!isLink || (typeof value[0] === 'string' && typeof value[1] === 'number'),
        `${template.id}: node ${id}.${name} is a well-formed link or a value`)
    }
  }
}

// ── templates carry a usable prompt and model ──

const iconTemplate = await library.read('item-icon')
const iconTexts = iconTemplate.graph.nodes.filter((n) => n.type === 'CLIPTextEncode')
assert(iconTexts.length === 2 && String(iconTexts[0].widgets_values[0]).includes('game item icon'),
  'the icon template ships a usable positive prompt')
assert(String(iconTexts[1].widgets_values[0]).includes('lowres'), 'the icon template ships the standard negative prompt')
const iconCkpt = iconTemplate.graph.nodes.find((n) => n.type === 'CheckpointLoaderSimple')
// A LITERAL in the document, not a claim about this machine. Whether the install
// actually has it is the environment question, and it is answered separately:
// by the NOTE further down when it is absent, and at run time by the checkpoint
// advisory. The old message said "really exists on this machine", which this
// assertion never checked.
assert(iconCkpt.widgets_values[0] === 'anything-v5.safetensors',
  'the icon template pins anything-v5.safetensors')

const upscaleTemplate = await library.read('upscale-4x')
const upscaleModel = upscaleTemplate.graph.nodes.find((n) => n.type === 'UpscaleModelLoader')
assert(upscaleModel.widgets_values[0] === 'RealESRGAN_x4plus_anime_6B.pth',
  'the upscale template pins RealESRGAN_x4plus_anime_6B.pth')

// ── meta lives inside the document ──

const rawBasic = JSON.parse(await readFile(join(library.root, 'sd15-basic.json'), 'utf8'))
assert(rawBasic.extra !== undefined && typeof rawBasic.extra[WORKFLOW_META_KEY] === 'object',
  'metadata is stored inside the workflow document (extra), so ComfyUI preserves it')
assert(Array.isArray(rawBasic.nodes) && Array.isArray(rawBasic.links),
  'a stored workflow is a plain ComfyUI UI-format document')

// ── create / save / remove ──

const created = await library.create({ name: 'my hero workflow', description: 'test', category: 'character', from: 'sd15-basic' })
assert(created.id === 'my-hero-workflow', `create() slugs the id from the name (${created.id})`)
assert(created.meta.source === 'agent' || created.meta.source === 'template', 'create() records where the graph came from')
const createdRead = await library.read(created.id)
assert(createdRead.graph.nodes.length === 7, 'create(from: template) copies the template graph')

const duplicate = await library.create({ name: 'my hero workflow' })
assert(duplicate.id === 'my-hero-workflow-2', `a colliding name gets a suffixed id (${duplicate.id})`)
assert((await library.read(duplicate.id)).graph.nodes.length === 0, 'create() with no source starts from an empty graph')

const blank = await library.create({ name: 'blank one', graph: { nodes: [{ id: 1, type: 'KSampler', widgets_values: [] }], links: [] } })
assert((await library.read(blank.id)).graph.nodes.length === 1, 'create(graph) stores a supplied document')

const savedMeta = await library.save(created.id, createdRead.graph, { name: '改名了' })
assert(savedMeta.name === '改名了', 'save() applies the name patch')
assert(savedMeta.createdAt === created.meta.createdAt, 'save() preserves createdAt')
assert(savedMeta.updatedAt >= created.meta.updatedAt, 'save() advances updatedAt')
assert((await library.read(created.id)).meta.name === '改名了', 'save() persists the metadata')

assert(await library.remove(blank.id) === true, 'remove() reports success')
assert(await library.remove(blank.id) === false, 'removing a missing workflow is a false, not a throw')
assert(!existsSync(join(library.root, `${blank.id}.json`)), 'remove() deletes the file')

await rejects(() => library.read('no-such-workflow'), /工作流库中没有/, 'reading a missing workflow names the expected path')

// ── seeding must not resurrect what the user deleted ──
// Done only now, so every template-validation loop above saw the full set.
const removedTemplateId = WORKFLOW_TEMPLATES[WORKFLOW_TEMPLATES.length - 1].id
await rm(join(library.root, `${removedTemplateId}.json`))
await createWorkflowLibrary(cfg).ensure()
assert(!existsSync(join(library.root, `${removedTemplateId}.json`)),
  'a deleted template is NOT resurrected by the next ensure()')
const presentTemplates = WORKFLOW_TEMPLATES.filter((t) => t.id !== removedTemplateId)

// ── a malformed file must not take down the listing ──

await writeFile(join(library.root, 'broken.json'), '{ not json', 'utf8')
const afterBroken = await library.list()
assert(afterBroken.some((w) => w.id === 'broken' && w.meta.description.includes('无法解析')),
  'a malformed workflow appears as a stub instead of breaking the whole listing')
assert(afterBroken.length > 2, 'the rest of the library still lists')
await rm(join(library.root, 'broken.json'))

// ── layout cache ──

const cache = createLayoutCache(cfg)
assert(await cache.load() === undefined, 'an empty cache loads as undefined')
const layouts = compactLayouts({
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', { default: 20 }],
      },
    },
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
})
assert(layouts.KSampler.length === 2 && layouts.KSampler[0].slots === 2, 'compactLayouts keeps the two-slot seed')
assert(Array.isArray(layouts.VAEDecode) && layouts.VAEDecode.length === 0,
  'a widget-less class is cached as an EMPTY ARRAY — its presence is what says "schema known"')
await cache.store(layouts, 'comfyui')
const reloaded = await cache.load()
assert(reloaded !== undefined && Array.isArray(reloaded.KSampler), 'the layout cache round-trips through disk')

// The cached form must be usable exactly like a live schema.
assert(JSON.stringify(widgetLayout(reloaded, 'KSampler').map((s) => s.name)) === JSON.stringify(['seed', 'steps']),
  'widgetLayout reads the compact cache, not just a live /object_info')

// A cache read back from disk must drive a FULL conversion — names and all.
// (The two-class sample above is deliberately too small for this.)
await cache.store(TEMPLATE_LAYOUTS, 'comfyui')
const fullCache = await cache.load()
const withCache = uiToApi(iconTemplate.graph, fullCache)
assert(withCache['1'].inputs.ckpt_name === 'anything-v5.safetensors',
  'a cache loaded from disk restores the checkpoint name')
assert(withCache['7'].inputs.filename_prefix === 'gig/icon', 'and the filename prefix')
assert(withCache['5'].inputs.steps === 22 && withCache['5'].inputs.seed === 0,
  'and the two-slot seed maps back to seed/steps with no drift')
assert(withCache['4'].inputs.width === 512 && withCache['4'].inputs.height === 512,
  'and the latent dimensions')

// Converting without ANY schema must fail loudly, never silently drop the
// scalar parameters (the server would answer "Required input is missing").
let silentDrop = false
try {
  uiToApi(iconTemplate.graph)
  silentDrop = true
} catch (error) {
  assert(/缺少该节点类的参数表/.test(error.message),
    'converting without a schema names the real cause and the fix')
}
assert(!silentDrop, 'converting without a schema does NOT silently produce a valueless graph')

// ── the real schema, when the backend is up ──

let liveInfo
try {
  const res = await fetch('http://127.0.0.1:8188/object_info')
  if (res.ok) liveInfo = await res.json()
} catch { /* backend down is fine */ }

if (liveInfo !== undefined) {
  const classes = Object.keys(liveInfo).length
  assert(classes > 100, `read the real /object_info (${classes} classes)`)
  const liveLayouts = compactLayouts(liveInfo)
  assert(Object.keys(liveLayouts).length === classes, 'every real class is represented in the compact cache')
  const sampler = liveLayouts.KSampler
  assert(sampler !== undefined && JSON.stringify(sampler.map((s) => `${s.name}${s.slots > 1 ? ':2' : ''}`))
    === JSON.stringify(['seed:2', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']),
    'the REAL KSampler layout matches what the templates assume')
  const full = JSON.stringify(liveInfo).length
  const compact = JSON.stringify(liveLayouts).length
  assert(compact < full / 2, `the compact cache is far smaller than the raw document (${Math.round(compact / 1024)} KB vs ${Math.round(full / 1024)} KB)`)

  // Every template must survive a round-trip against the REAL schema.
  //
  // The same pass collects the checkpoints the templates actually pin, so the
  // check further down is DERIVED from the documents instead of hard-coded: a
  // re-pinned template would otherwise leave that check asserting a name
  // nothing references any more.
  const pinnedCheckpoints = new Map()
  for (const template of presentTemplates) {
    const { graph } = await library.read(template.id)
    const api = uiToApi(graph, liveLayouts)
    assert(Object.keys(api).length === graph.nodes.length, `${template.id}: converts against the real schema`)
    for (const node of Object.values(api)) {
      if (node?.class_type !== 'CheckpointLoaderSimple') continue
      const name = node.inputs?.ckpt_name
      if (typeof name === 'string' && name !== '') {
        if (!pinnedCheckpoints.has(name)) pinnedCheckpoints.set(name, [])
        pinnedCheckpoints.get(name).push(template.id)
      }
    }
  }
  // And every pinned model/weight must exist in the real option lists.
  //
  // ComfyUI spells a COMBO option list in more than one shape: newer builds send
  // `["COMBO", { options: [...] }]` (this install's UpscaleModelLoader) while others
  // send `[[...names], { tooltip }]` (its CheckpointLoaderSimple). Reading `[0]`
  // blindly turned this assertion into a substring test on the literal string
  // "COMBO", which is how a perfectly installed weight came up as missing.
  const comboOptions = (spec) => {
    if (Array.isArray(spec[0])) return spec[0].filter((entry) => typeof entry === 'string')
    for (const entry of spec) {
      if (entry !== null && typeof entry === 'object') {
        if (Array.isArray(entry.options)) return entry.options
        if (Array.isArray(entry.value)) return entry.value
      }
    }
    return spec.filter((entry) => typeof entry === 'string')
  }
  const upscalers = comboOptions(liveInfo.UpscaleModelLoader.input.required.model_name)
  if (Array.isArray(upscalers) && upscalers.length === 0) {
    // Not a plugin regression, and not something to hide either: this ComfyUI can
    // see ZERO upscale models (the .pth files sit in SD WebUI's ESRGAN directory
    // and only SD WebUI exposes them here — `image_backend_status` reports the same
    // "放大 0 个"). The plugin's upscale route is SD WebUI's, so the pinned
    // UpscaleModelLoader template simply cannot run on this install.
    console.log('NOTE  这台 ComfyUI 看不到任何放大权重（0 个）：模板 upscale-4x 在本机跑不起来，放大走 SD WebUI。')
  } else {
    assert(upscalers.includes('RealESRGAN_x4plus_anime_6B.pth'),
      `the pinned upscale weight is really installed (this install offers: ${upscalers.join(', ') || 'nothing'})`)
  }
  const ckpts = comboOptions(liveInfo.CheckpointLoaderSimple.input.required.ckpt_name)
  // What a machine has installed is the operator's choice, and this plugin ships
  // no models — so a pinned checkpoint being absent is the same class of thing
  // as the zero-upscale-weights case above, and gets the same treatment: a NOTE
  // that names it, not a red suite. As a hard assertion this went red for anyone
  // who had ComfyUI up with a different model set, which is a normal
  // configuration and says nothing about this code.
  //
  // The teeth move to where the template is actually run: `image_workflow
  // action=run` now raises a checkpoint advisory BEFORE submitting, on whatever
  // machine runs it. That is a better home for it than a test which can only
  // ever describe the machine it happens to be running on.
  // Deliberately non-vacuous, and deliberately UNCONDITIONAL: the derivation
  // above is all this check now rests on, so finding nothing there has to fail
  // rather than pass quietly. Sitting before the branches rather than inside one
  // also keeps this suite's assertion count independent of what the machine
  // happens to have installed — the README quotes that count.
  assert(pinnedCheckpoints.size > 0 && Array.isArray(ckpts),
    'the templates pin at least one checkpoint (derived from the documents themselves)')

  const missingCheckpoints = [...pinnedCheckpoints.keys()].filter((name) => !ckpts.includes(name))
  if (ckpts.length === 0) {
    console.log('NOTE  这台 ComfyUI 看不到任何 checkpoint：模板在本机能否运行无法验证。')
  } else if (missingCheckpoints.length > 0) {
    for (const name of missingCheckpoints) {
      console.log(`NOTE  这台 ComfyUI 没有 ${name}——模板 ${pinnedCheckpoints.get(name).join('、')} 钉住了它，在本机跑不起来。`)
    }
  }
  const samplerNames = liveLayouts.KSampler.find((s) => s.name === 'sampler_name').options
  const schedulers = liveLayouts.KSampler.find((s) => s.name === 'scheduler').options
  for (const template of presentTemplates) {
    const { graph } = await library.read(template.id)
    const s = graph.nodes.find((n) => n.type === 'KSampler')
    if (s === undefined) continue
    const widgets = readWidgets(s, liveLayouts.KSampler)
    assert(samplerNames.includes(String(widgets.sampler_name)),
      `${template.id}: sampler "${widgets.sampler_name}" exists on the real server`)
    assert(schedulers.includes(String(widgets.scheduler)),
      `${template.id}: scheduler "${widgets.scheduler}" exists on the real server`)
  }
} else {
  console.log('NOTE  ComfyUI is not answering on :8188 — skipped the live-schema assertions')
}

await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
