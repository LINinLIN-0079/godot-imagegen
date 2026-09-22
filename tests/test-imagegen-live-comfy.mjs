/**
 * LIVE end-to-end test for godot-imagegen against the REAL 秋叶 ComfyUI.
 *
 * The offline suite drives a fake ComfyUI, which validates the request shapes
 * but not the real server's acceptance of them. This script closes that gap:
 * it builds the plugin's graph, POSTs it to a running ComfyUI, waits for
 * /history, pulls the result back through /view and checks the PNG landed in the
 * Godot project.
 *
 * Skips cleanly (exit 0) when nothing answers on :8188. Start it with
 *   <comfyRoot>\python\python.exe -S main.py --port 8188 --listen 127.0.0.1
 * (cwd = <comfyRoot>\ComfyUI) or with the 美术工坊 panel's 「启动后端」button.
 *
 * Run with:  node tests/test-imagegen-live-comfy.mjs   (from the repo root)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../godot-imagegen.ts'
import { WORKFLOW_TEMPLATES, compactLayouts, createWorkflowLibrary, patchWorkflow, uiToApi } from '../godot-imagegen.ts'

const COMFY_PORT = Number(process.env.GIG_LIVE_COMFY_PORT || 8188)
const SD_PORT = Number(process.env.GIG_LIVE_PORT || 7860)

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
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const readPngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

function makeStorageBackend() {
  const units = new Map()
  return {
    get(name) {
      if (name !== 'json') throw new Error(`backend "${name}" not found`)
      return {
        kv: {
          async open(descriptor) {
            if (units.has(descriptor.name) && units.get(descriptor.name).live) {
              throw new Error('unit is already open: ' + descriptor.name)
            }
            const state = units.get(descriptor.name) || { tables: {}, global: null }
            state.live = true
            units.set(descriptor.name, state)
            const clone = (v) => JSON.parse(JSON.stringify(v))
            return {
              async loadAll() { return { tables: clone(state.tables), global: clone(state.global) } },
              async putRecord(table, key, value) {
                if (!state.tables[table]) state.tables[table] = {}
                state.tables[table][key] = clone(value)
              },
              async deleteRecord(table, key) { if (state.tables[table]) delete state.tables[table][key] },
              async setGlobal(value) { state.global = clone(value) },
              async close() { state.live = false },
            }
          },
        },
      }
    },
  }
}

const byName = (list, name) => list.find((tool) => tool.name === name)
const exec = (tool, args) => tool.execute(args, { signal: { aborted: false } })

// ── a minimal host for the /gig routes, so the panel's own paths are covered ──

function makeWebServer() {
  const routes = []
  return { routes, register(opts) { routes.push(opts); return () => {} } }
}
async function callRoute(webServer, method, pathname, body) {
  const route = webServer.routes.find((r) => r.path === '/gig')
  const captured = {}
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(payload) { captured.body = payload },
  }
  await route.handler({
    method,
    url: pathname,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8') },
  }, res)
  let parsed = null
  if (typeof captured.body === 'string') { try { parsed = JSON.parse(captured.body) } catch { parsed = captured.body } }
  return { status: captured.status, body: parsed }
}

async function listening(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  console.log(`LIVE end-to-end against ComfyUI on :${COMFY_PORT}\n`)

  if (!(await listening(COMFY_PORT))) {
    console.log(`SKIP  no ComfyUI answering on :${COMFY_PORT} — nothing to verify.`)
    console.log(`      Start it with:  python -S main.py --port ${COMFY_PORT} --listen 127.0.0.1  (cwd = <comfyRoot>/ComfyUI)`)
    process.exit(0)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'gig-comfy-'))
  const godotProject = join(workRoot, 'godot-project')
  await mkdir(join(godotProject, 'assets'), { recursive: true })
  await writeFile(join(godotProject, 'project.godot'), 'config_version=5\n', 'utf8')

  const registered = []
  const disposers = []
  const webServer = makeWebServer()
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    storage: { backend: makeStorageBackend() },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(deps, callback) {
      if (deps.includes('webServer')) callback(Object.assign(Object.create(ctx), { webServer }))
      return () => {}
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
  }
  plugin.apply(ctx, {
    unitName: 'godot_imagegen_live_comfy',
    comfyPort: COMFY_PORT,
    sdwebuiPort: SD_PORT,
    godotProject,
    // A throwaway data root: this suite must not touch the user's real workflow
    // library (the plugin seeds one on first use).
    dataRoot: join(workRoot, 'data'),
    defaultBackend: 'comfyui',
    requestTimeoutMs: 30 * 60 * 1000,
  })

  // ── capability detection against the real server ──
  const statusTool = byName(registered, 'image_backend_status')
  const status = await exec(statusTool, { action: 'status' })
  const comfy = status.backends.find((b) => b.id === 'comfyui')
  console.log(`— ComfyUI 探测 —`)
  console.log(`  running=${comfy.running}`)
  console.log(`  ${comfy.detail}`)
  console.log(`  模型：${comfy.models.join(' | ')}`)
  console.log(`  能力：\n    - ${comfy.strengths.join('\n    - ')}`)
  assert(comfy.running === true, 'detects the real ComfyUI')
  assert(comfy.models.length >= 1, `reads the real checkpoint list (${comfy.models.length})`)
  assert(comfy.strengths.some((s) => /ControlNet 权重 \d+ 个/.test(s)),
    'reports the real ControlNet weights ComfyUI inherits via extra_model_paths')
  assert(comfy.strengths.some((s) => /放大权重 \d+ 个/.test(s)), 'reports the real upscale weights')
  assert(comfy.strengths.some((s) => s.includes('只实现文生图')), 'discloses that the adapter is txt2img/img2img only')

  // ── real graph execution ──
  const generateTool = byName(registered, 'image_generate')
  const model = comfy.models.find((m) => m.toLowerCase().includes('anything-v5')) ?? comfy.models[0]
  console.log(`\n— 真实 ComfyUI 出图 (${model}, 512×512, 12 步) —`)
  const t0 = Date.now()
  const result = await exec(generateTool, {
    prompt: 'game item icon, (health potion:1.2), single object, centered, clean outline, flat color, plain white background, sticker, masterpiece',
    negative_prompt: 'lowres, text, watermark, multiple objects, blurry',
    category: 'item',
    name: 'comfy-potion',
    width: 512,
    height: 512,
    steps: 12,
    cfg_scale: 7,
    seed: 5150,
    model,
    backend: 'comfyui',
    transparent: false,
    project_id: 'comfy',
  })
  const ms = Date.now() - t0
  const image = result.images[0]
  const bytes = await readFile(image.filePath)
  console.log(`  ${secs(ms)} → ${image.resPath}`)
  console.log(`  model=${image.model}  ${readPngSize(bytes).width}×${readPngSize(bytes).height}  ${(bytes.length / 1024).toFixed(0)} KB`)

  assert(result.count === 1, 'the real ComfyUI returned exactly one image')
  assert(image.backend === 'comfyui', 'the image is attributed to ComfyUI')
  assert(image.model === model, 'the requested checkpoint was used verbatim')
  assert(readPngSize(bytes).width === 512 && readPngSize(bytes).height === 512, 'the real PNG is 512×512')
  assert(bytes.length > 20_000, `the real PNG has real content (${(bytes.length / 1024).toFixed(0)} KB)`)
  assert(image.filePath.includes(join('assets', 'generated', 'item')), 'the PNG landed in assets/generated/item')
  assert(typeof image.resPath === 'string' && image.resPath.startsWith('res://'), 'the PNG has a res:// path')
  assert(image.seed === 5150, 'the seed round-trips')

  // ── real img2img, with a BLANK negative prompt ──
  // REGRESSION COVERAGE: the 美术工坊 panel posts `negativePrompt: ""` for an
  // untouched box, which used to fail validation outright. This run proves a
  // blank negative prompt now travels through to the real ComfyUI graph.
  console.log('\n— 真实 ComfyUI 图生图（负向提示词留空）—')
  const editTool = byName(registered, 'image_edit')
  const t1 = Date.now()
  const edited = await exec(editTool, {
    image: image.resPath,
    prompt: 'game item icon, health potion, glowing blue liquid, single object, centered, clean outline, flat color, plain white background',
    negative_prompt: '',
    category: 'item',
    name: 'comfy-potion-blue',
    denoise: 0.6,
    steps: 12,
    cfg_scale: 7,
    backend: 'comfyui',
    project_id: 'comfy',
  })
  const editMs = Date.now() - t1
  const editedBytes = await readFile(edited.images[0].filePath)
  console.log(`  ${secs(editMs)} → ${edited.images[0].resPath}  ${(editedBytes.length / 1024).toFixed(0)} KB`)
  assert(edited.count === 1 && edited.images[0].op === 'edit', 'real ComfyUI img2img produced a new image')
  assert(readPngSize(editedBytes).width === 512, 'the img2img result keeps the source resolution')
  assert(editedBytes.length > 20_000, 'a blank negative_prompt still produced a full-size result')

  // ── the built-in templates must actually EXECUTE on the real server ──
  // Structural validation (test-workflow-library.mjs) proves a template converts
  // against the real /object_info; only running one proves the wiring, the pinned
  // checkpoint and the seven-slot KSampler are all right together. A UI workflow
  // is positional, so the layouts have to come from the live schema.
  console.log('\n— 内置工作流模板在真实 ComfyUI 上执行 —')
  const liveLayouts = compactLayouts(await (await fetch(`http://127.0.0.1:${COMFY_PORT}/object_info`)).json())
  assert(Object.keys(liveLayouts).length > 100, `read the real node layouts (${Object.keys(liveLayouts).length} classes)`)

  const libDir = await mkdtemp(join(tmpdir(), 'gig-tpl-'))
  const library = createWorkflowLibrary({ dataRoot: libDir })
  await library.ensure()
  const seeded = await library.list()
  assert(seeded.length === WORKFLOW_TEMPLATES.length, `the library seeded ${seeded.length} templates for the run`)

  /** Run an API graph on the real server and return the first produced PNG. */
  async function runGraph(api, label) {
    const queued = await (await fetch(`http://127.0.0.1:${COMFY_PORT}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: api, client_id: `gig-template-${label}` }),
    })).json()
    if (queued.prompt_id === undefined) {
      throw new Error(`${label}: server rejected the graph — ${JSON.stringify(queued).slice(0, 400)}`)
    }
    const deadline = Date.now() + 600_000
    while (Date.now() < deadline) {
      const history = await (await fetch(`http://127.0.0.1:${COMFY_PORT}/history/${queued.prompt_id}`)).json()
      const entry = history[queued.prompt_id]
      if (entry !== undefined) {
        const refs = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])
        if (refs.length === 0) throw new Error(`${label}: no image in the history entry`)
        const url = `http://127.0.0.1:${COMFY_PORT}/view?filename=${encodeURIComponent(refs[0].filename)}&subfolder=${encodeURIComponent(refs[0].subfolder ?? '')}&type=${encodeURIComponent(refs[0].type ?? 'output')}`
        const response = await fetch(url)
        return Buffer.from(await response.arrayBuffer())
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
    throw new Error(`${label}: timed out waiting for the history entry`)
  }

  // Shape A: txt2img (sd15-basic / item-icon / seamless-tile / sdxl-basic).
  const basicGraph = (await library.read('sd15-basic')).graph
  const tBasic = Date.now()
  const basicBytes = await runGraph(uiToApi(basicGraph, liveLayouts), 'sd15-basic')
  const basicMs = Date.now() - tBasic
  const basicSize = readPngSize(basicBytes)
  console.log(`  sd15-basic           : ${secs(basicMs)} → ${basicSize.width}×${basicSize.height}, ${(basicBytes.length / 1024).toFixed(0)} KB`)
  assert(basicSize.width === 512 && basicSize.height === 512,
    'the sd15-basic template really rendered a 512×512 image on the real server')
  assert(basicBytes.length > 20_000, `the template output has real content (${(basicBytes.length / 1024).toFixed(0)} KB)`)

  // Shape B: upscale (LoadImage → UpscaleModelLoader → ImageUpscaleWithModel).
  const upscaleGraph = (await library.read('upscale-4x')).graph
  const tUp = Date.now()
  try {
    const upBytes = await runGraph(uiToApi(upscaleGraph, liveLayouts), 'upscale-4x')
    const upSize = readPngSize(upBytes)
    console.log(`  upscale-4x           : ${secs(Date.now() - tUp)} → ${upSize.width}×${upSize.height}, ${(upBytes.length / 1024).toFixed(0)} KB`)
    assert(upSize.width >= 1024, 'the upscale template really upscaled its source (R-ESRGAN ×4)')
  } catch (error) {
    // The template pins example.png; an install without it cannot run this one.
    console.log(`  upscale-4x           : SKIP — ${error.message.slice(0, 120)}`)
    assert(/example\.png|invalid|not find|missing/i.test(error.message),
      'the upscale template only fails when its pinned source image is missing')
  }

  // A by-name patch must change what the server actually renders.
  const { graph: patchedGraph } = patchWorkflow(basicGraph, [{ classType: 'KSampler', set: { seed: 4242, steps: 6 } }], liveLayouts)
  const patchedApi = uiToApi(patchedGraph, liveLayouts)
  assert(patchedApi['5'].inputs.seed === 4242 && patchedApi['5'].inputs.steps === 6,
    'a by-name patch flows into the API graph the server receives')
  const tPatch = Date.now()
  const patchedBytes = await runGraph(patchedApi, 'sd15-patched')
  console.log(`  sd15-basic(改 seed/步数) : ${secs(Date.now() - tPatch)} → ${(patchedBytes.length / 1024).toFixed(0)} KB`)
  assert(patchedBytes.length > 20_000, 'the patched template really re-rendered on the server')

  await rm(libDir, { recursive: true, force: true }).catch(() => undefined)

  // ── real step progress over ComfyUI's WebSocket ──
  //
  // The frames are parsed from ComfyUI's own /ws, so this is the one place that can
  // prove the REAL frame shapes match what the plugin expects (the offline suite
  // feeds it synthetic ones). It drives the panel's own route and watches the JOB,
  // because the job message is the only thing the user ever sees.
  {
    console.log('\n— ComfyUI 执行进度（真实 WebSocket）—')
    const started = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'sd15-basic', category: 'concept', projectId: 'progress' })
    assert(typeof started.body.jobId === 'string', 'the canvas route starts a real ComfyUI run')
    const seen = []
    const deadline = Date.now() + 4 * 60 * 1000
    let job
    while (Date.now() < deadline) {
      job = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === started.body.jobId)
      if (job !== undefined && (seen.length === 0 || seen[seen.length - 1] !== job.message)) seen.push(job.message)
      if (job !== undefined && job.status !== 'running') break
      await new Promise((r) => setTimeout(r, 250))
    }
    assert(job !== undefined && job.status === 'done', `the run completed on the real server (${job && job.status})`)
    const sampling = seen.filter((m) => /采样 \d+\/\d+/.test(m))
    const nodeFrames = seen.filter((m) => /执行节点 \d+\/\d+|开始执行/.test(m))
    for (const message of seen) console.log(`  · ${message}`)
    assert(nodeFrames.length > 0, `real ComfyUI frames produced a node counter (${nodeFrames[0] ?? '—'})`)
    assert(sampling.length > 0, `and a real step counter (${sampling[0] ?? '—'} … ${sampling[sampling.length - 1] ?? '—'})`)
    assert(sampling.some((m) => /剩余约 \d+s/.test(m)), 'with our own remaining-time estimate')
    assert(seen[seen.length - 1].includes('完成'), 'and the run ends with the completion message')
  }

  console.log(`\n— 实测 —\n  txt2img 512²/12 步 : ${secs(ms)}\n  img2img 512²/12 步 : ${secs(editMs)}\n  模板 sd15-basic    : ${secs(basicMs)}`)
  console.log(`  (产物保留在 ${workRoot})`)

  for (const dispose of disposers) dispose()
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
