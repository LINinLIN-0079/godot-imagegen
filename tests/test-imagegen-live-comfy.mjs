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
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../godot-imagegen.ts'

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
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    storage: { backend: makeStorageBackend() },
    get() { return undefined },
    inject() { return () => {} },
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

  console.log(`\n— 实测 —\n  txt2img 512²/12 步 : ${secs(ms)}\n  img2img 512²/12 步 : ${secs(editMs)}`)
  console.log(`  (产物保留在 ${workRoot})`)

  for (const dispose of disposers) dispose()
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
