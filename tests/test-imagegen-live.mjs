/**
 * LIVE end-to-end test for godot-imagegen against the REAL 秋叶 SD WebUI.
 *
 * Unlike test-imagegen.mjs (which impersonates the backends so it can run
 * anywhere), this drives the actually-installed stack:
 *
 *   real HTTP → SD WebUI on :7860 → waiIllustriousSDXL / anything-v5 checkpoints
 *   real 秋叶 Python → rembg (u2net) cutout, R-ESRGAN Anime6B upscale
 *   real filesystem → <temp Godot project>/assets/generated/<category>/*.png
 *
 * It SKIPS cleanly (exit 0) when no backend is listening, so it is safe to run
 * in CI or before the UI has been started. Start the backend first with
 *   python launch.py --api --port 7860 --server-name 127.0.0.1
 * or with the 美术工坊 panel's 「启动后端」button.
 *
 * Run with:  node tests/test-imagegen-live.mjs   (from the repo root)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../godot-imagegen.ts'

const SD_PORT = Number(process.env.GIG_LIVE_PORT || 7860)
const COMFY_PORT = Number(process.env.GIG_LIVE_COMFY_PORT || 8188)
const AKI_PYTHON = 'D:/AKI open/ComfyUI-aki-v2/python/python.exe'
const SD_ROOT = 'D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10'

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

// ── the same in-memory storage mock the offline suite uses ──
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

function makeCtx(backend, extra = {}) {
  const registered = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    storage: { backend },
    get(name) { return name === 'webServer' ? extra.webServer : undefined },
    inject(deps, callback) {
      if (deps.includes('webServer') && extra.webServer !== undefined) {
        callback(Object.assign(Object.create(ctx), { webServer: extra.webServer }))
      }
      return () => {}
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
  }
  return { ctx, registered, disposers }
}

const byName = (list, name) => list.find((tool) => tool.name === name)
const exec = (tool, args) => tool.execute(args, { signal: { aborted: false } })
const readPngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })
const readPngColorType = (bytes) => bytes[25]

async function backendListening() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(`http://127.0.0.1:${SD_PORT}/sdapi/v1/options`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  console.log(`LIVE end-to-end against SD WebUI on :${SD_PORT}\n`)

  if (!(await backendListening())) {
    console.log(`SKIP  no SD WebUI answering on :${SD_PORT} — nothing to verify.`)
    console.log(`      Start it with:  python launch.py --api --port ${SD_PORT} --server-name 127.0.0.1`)
    process.exit(0)
  }
  if (!existsSync(AKI_PYTHON)) {
    console.log(`SKIP  秋叶 Python missing at ${AKI_PYTHON} — cannot exercise cutout/upscale.`)
    process.exit(0)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'gig-live-'))
  const godotProject = join(workRoot, 'godot-project')
  await mkdir(join(godotProject, 'assets'), { recursive: true })
  await writeFile(join(godotProject, 'project.godot'), 'config_version=5\n', 'utf8')

  const storage = makeStorageBackend()
  const { ctx, registered, disposers } = makeCtx(storage)
  plugin.apply(ctx, {
    unitName: 'godot_imagegen_live',
    sdwebuiPort: SD_PORT,
    sdwebuiRoot: SD_ROOT,
    sdwebuiPython: `${SD_ROOT}/python/python.exe`,
    comfyPort: COMFY_PORT,
    postPython: AKI_PYTHON,
    godotProject,
    defaultBackend: 'sdwebui',
    // Matches the plugin default. A real SDXL run measures ~60-77 s/step here,
    // and a request can also sit behind an earlier job in the server queue.
    requestTimeoutMs: 30 * 60 * 1000,
  })

  // ── 1. real capability detection ──
  const statusTool = byName(registered, 'image_backend_status')
  const t0 = Date.now()
  const status = await exec(statusTool, { action: 'status' })
  const sd = status.backends.find((b) => b.id === 'sdwebui')
  console.log(`\n— 后端探测 (${secs(Date.now() - t0)}) —`)
  console.log(`  ${sd.label}  running=${sd.running}`)
  console.log(`  ${sd.detail}`)
  console.log(`  模型：${sd.models.join('  |  ')}`)
  console.log(`  能力：\n    - ${sd.strengths.join('\n    - ')}`)
  assert(sd.running === true, 'detects the real SD WebUI')
  assert(sd.models.length >= 2, `reads the real checkpoint list (${sd.models.length})`)
  assert(sd.models.some((m) => m.includes('waiIllustriousSDXL')), 'sees the SDXL Illustrious checkpoint')
  assert(sd.models.some((m) => m.includes('anything-v5')), 'sees the SD1.5 anything-v5 checkpoint')
  assert(sd.strengths.some((s) => /ControlNet \d+ 个/.test(s)), 'reports the real ControlNet inventory to the model')
  assert(sd.strengths.some((s) => /放大模型 \d+ 个/.test(s)), 'reports the real upscaler inventory to the model')
  assert(sd.strengths.some((s) => s.includes('反推提示词')), 'reports which prompt-interrogation route is available')
  assert(sd.strengths.some((s) => s.includes('rembg')), 'reports the post-processing cutout capability')
  assert(status.postProcessing.includes('python'), 'reports the post-processing interpreter')
  assert(status.godotProject.replace(/\\/g, '/') === godotProject.replace(/\\/g, '/'), 'maps the Godot project for res:// paths')

  // ── 2. real SD1.5 generation (fast) ──
  const generateTool = byName(registered, 'image_generate')
  console.log('\n— 真实 SD1.5 出图 (anything-v5, 512×512, 14 步) —')
  const t1 = Date.now()
  const s15 = await exec(generateTool, {
    prompt: 'game item icon, (potion bottle:1.2), single object, centered, clean thick outline, flat shading, white background, sticker, masterpiece, best quality',
    negative_prompt: 'lowres, bad anatomy, text, watermark, blurry, multiple objects',
    category: 'item',
    name: 'live-potion',
    width: 512,
    height: 512,
    steps: 14,
    cfg_scale: 7,
    seed: 20260922,
    model: 'anything-v5',
    project_id: 'live',
  })
  const genMs = Date.now() - t1
  const first = s15.images[0]
  console.log(`  ${secs(genMs)} → ${first.filePath}`)
  console.log(`  model=${first.model}  seed=${first.seed}  method=${first.method ?? '(none)'}  ${first.width}×${first.height}`)
  assert(s15.count === 1, 'the real backend returned one image')
  assert(first.backend === 'sdwebui', 'generation ran on the real SD WebUI')
  assert(String(first.model).toLowerCase().includes('anything-v5'), 'the loose model match resolved "anything-v5" to the real checkpoint title')
  assert(first.filePath.includes(join('assets', 'generated', 'item')), 'the real PNG landed in assets/generated/item')
  assert(typeof first.resPath === 'string' && first.resPath.startsWith('res://assets/generated/item/'), 'the real PNG has a res:// path')
  assert(existsSync(first.filePath), 'the real PNG exists on disk')
  const firstBytes = await readFile(first.filePath)
  assert(readPngSize(firstBytes).width === 512 && readPngSize(firstBytes).height === 512, 'the real PNG is 512×512')
  assert(firstBytes.length > 20_000, `the real PNG has real content (${(firstBytes.length / 1024).toFixed(0)} KB)`)

  // ── 3. real rembg cutout (u2net) ──
  console.log('\n— 真实 rembg(u2net) 抠图 —')
  const t2 = Date.now()
  const cut = await exec(generateTool, {
    prompt: 'game item icon, (red potion bottle:1.2), single object, centered, clean outline, flat shading, plain white background, sticker',
    negative_prompt: 'lowres, text, watermark, multiple objects, scenery',
    category: 'item',
    name: 'live-cutout',
    width: 512,
    height: 512,
    steps: 14,
    cfg_scale: 7,
    seed: 4242,
    model: 'anything-v5',
    transparent: true,
    transparent_method: 'rembg',
    project_id: 'live',
  })
  const cutMs = Date.now() - t2
  const cutImage = cut.images[0]
  const cutBytes = await readFile(cutImage.filePath)
  console.log(`  ${secs(cutMs)} → ${cutImage.resPath}  method=${cutImage.method}`)
  assert(cutImage.method === 'rembg', 'transparency really went through rembg')
  assert(readPngColorType(cutBytes) === 6, 'the real cutout PNG is RGBA (colour type 6)')
  assert(cutImage.size !== undefined && cutImage.size > 10_000, `the cutout PNG has content (${((cutImage.size ?? 0) / 1024).toFixed(0)} KB)`)

  // ── 4. real SDXL generation (opt-in: ~20 minutes of GPU) ──
  // Measured on this machine: SDXL at 768² costs ~60-77 s/step, so an 18-step
  // image takes ~18-20 minutes and would dominate any routine test run. It is
  // therefore gated behind GIG_LIVE_SDXL=1 rather than skipped silently.
  let produced = 3 // potion + rembg cutout + upscale (added below)
  if (process.env.GIG_LIVE_SDXL === '1') {
    console.log('\n— 真实 SDXL 出图 (waiIllustriousSDXL, 768×768, 18 步；约 20 分钟) —')
    const t3 = Date.now()
    const sdxl = await exec(generateTool, {
      prompt: 'masterpiece, best quality, game ui button, glossy, rounded corners, (empty center:1.3), dark fantasy frame, ui element, centered, isolated, plain background',
      negative_prompt: 'text, letters, watermark, character, lowres, blurry',
      category: 'ui',
      name: 'live-button',
      width: 768,
      height: 768,
      steps: 18,
      cfg_scale: 6,
      seed: 777,
      transparent: false,
      project_id: 'live',
    })
    const sdxlMs = Date.now() - t3
    const sdxlImage = sdxl.images[0]
    const sdxlBytes = await readFile(sdxlImage.filePath)
    console.log(`  ${secs(sdxlMs)} → ${sdxlImage.resPath}`)
    console.log(`  model=${sdxlImage.model}  ${readPngSize(sdxlBytes).width}×${readPngSize(sdxlBytes).height}`)
    assert(String(sdxlImage.model).toLowerCase().includes('wai') || String(sdxlImage.model).toLowerCase().includes('illustrious'),
      'the default checkpoint is the SDXL Illustrious model')
    assert(readPngSize(sdxlBytes).width === 768, 'the real SDXL PNG is 768×768')
    assert(sdxlImage.filePath.includes(join('assets', 'generated', 'ui')), 'the SDXL PNG landed in assets/generated/ui')
    produced++
    console.log(`  注意：本机 SDXL 约 ${(sdxlMs / 1000 / 18).toFixed(0)} 秒/步 —— 草稿请用 SD1.5 或 ≤640²。`)
  } else {
    console.log('\n— 真实 SDXL 出图：已跳过 —')
    console.log('  本机 SDXL 768²/18 步实测约 20 分钟（~60–77 秒/步）。设 GIG_LIVE_SDXL=1 可强制执行。')
  }

  // ── 5. real upscale through R-ESRGAN Anime6B ──
  console.log('\n— 真实放大 (R-ESRGAN 4x+ Anime6B ×2) —')
  const upscaleTool = byName(registered, 'image_upscale')
  const t4 = Date.now()
  const up = await exec(upscaleTool, {
    image: first.resPath,
    scale: 2,
    method: 'esrgan',
    category: 'item',
    name: 'live-potion-x2',
    project_id: 'live',
  })
  const upMs = Date.now() - t4
  const upBytes = await readFile(up.image.filePath)
  const upSize = readPngSize(upBytes)
  console.log(`  ${secs(upMs)} → ${up.image.resPath}  ${upSize.width}×${upSize.height}  method=${up.image.method}`)
  assert(upSize.width === 1024 && upSize.height === 1024, 'the real upscaler doubled 512×512 to 1024×1024')
  assert(typeof up.image.method === 'string' && up.image.method.toLowerCase().includes('anime'),
    `the anime-tuned upscaler really ran (${up.image.method})`)

  // ── 6. real ControlNet-guided generation ──
  console.log('\n— 真实 ControlNet(lineart_anime) 引导出图 —')
  const t5 = Date.now()
  const cn = await exec(generateTool, {
    prompt: 'game item icon, sword, single object, centered, clean outline, flat color, white background',
    negative_prompt: 'lowres, text, watermark, multiple objects',
    category: 'item',
    name: 'live-sword-cn',
    width: 512,
    height: 512,
    steps: 12,
    cfg_scale: 7,
    seed: 31337,
    model: 'anything-v5',
    transparent: false,
    control_image: first.filePath,
    control_type: 'lineart',
    control_weight: 0.8,
    project_id: 'live',
  })
  const cnMs = Date.now() - t5
  const cnBytes = await readFile(cn.images[0].filePath)
  console.log(`  ${secs(cnMs)} → ${cn.images[0].resPath}  ${cnBytes.length} B`)
  // A wrong ControlNet module name or model string makes A1111 reject the whole
  // request, so a produced file is real evidence the controlnet wiring is valid.
  assert(cn.count === 1, 'ControlNet-guided generation really succeeded')
  assert(cnBytes.length > 10_000, 'the ControlNet-guided PNG has real content')
  assert(cn.images[0].resPath !== undefined, 'the ControlNet result carries a res:// path')

  // ── 7. gallery round-trip over the real files ──
  const galleryTool = byName(registered, 'image_gallery')
  const listed = await exec(galleryTool, { action: 'list', project_id: 'live' })
  console.log(`\n— 图库 —\n  ${listed.images.length} 条记录`)
  assert(listed.images.length === produced + 1, `gallery holds every real generation (${listed.images.length})`)
  assert(listed.images.every((i) => existsSync(i.filePath)), 'every gallery record points at a real file on disk')
  assert(listed.images.filter((i) => i.resPath !== undefined).length === listed.images.length, 'every record carries a res:// path')

  console.log('\n— 实测耗时 —')
  console.log(`  SD1.5 512²/14 步 : ${secs(genMs)}（含可能的换模型）`)
  console.log(`  rembg 抠图那一步  : ${secs(cutMs)}（含一次完整出图）`)
  console.log(`  R-ESRGAN ×2       : ${secs(upMs)} → ${up.image.method}`)
  console.log(`  ControlNet 512²   : ${secs(cnMs)}`)
  console.log(`  产物目录          : ${join(godotProject, 'assets', 'generated')}`)

  for (const dispose of disposers) dispose()
  await new Promise((r) => setTimeout(r, 100))
  // Keep the produced art for inspection; only the empty scaffolding is removed.
  console.log(`\n(产物保留在 ${workRoot})`)

  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
