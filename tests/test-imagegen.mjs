/**
 * Functional test for ../godot-imagegen.ts (this repo's plugin root).
 *
 * Loads the plugin exactly the way the dsh loader does (a file:// import of the
 * .ts — Node's type stripping), applies it against a mocked Cordis context, and
 * exercises every tool plus the /gig REST surface end to end.
 *
 * Three real dependencies are deliberately used instead of mocks:
 *   1. a REAL node:http server impersonating the A1111 /sdapi/v1 API,
 *   2. a REAL node:http server impersonating the ComfyUI graph API,
 *   3. the REAL 秋叶 bundled Python for the cutout / upscale post-processing.
 * Storage and the webServer are mocked because the harness' own host plugins
 * live inside app.asar and are not resolvable from a standalone script.
 *
 * Run with:  node tests/test-imagegen.mjs   (from the repo root)
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import * as plugin from '../godot-imagegen.ts'

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
    console.error(`FAIL  ${label} (expected rejection)`)
  } catch (error) {
    if (pattern.test(error.message)) {
      passes++
      console.log(`PASS  ${label}`)
    } else {
      failures++
      console.error(`FAIL  ${label} — unexpected error: ${error.message}`)
    }
  }
}

// ─────────────────────────── PNG encoder (no dependencies) ───────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
/** Encode an RGBA image; `pixel(x, y)` returns [r, g, b, a]. */
function encodePng(width, height, pixel) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * stride + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
/** A white sheet with a red square — chroma-keyable against #FFFFFF. */
const SAMPLE_PNG = encodePng(64, 64, (x, y) =>
  x >= 16 && x < 48 && y >= 16 && y < 48 ? [220, 40, 40, 255] : [255, 255, 255, 255])
const SAMPLE_PNG_B64 = SAMPLE_PNG.toString('base64')

function readPngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
function readPngColorType(bytes) {
  return bytes[25]
}

// ─────────────────────────── fake A1111 backend ───────────────────────────

/**
 * What the fake A1111 reports on /sdapi/v1/progress.
 *
 * Mutable so a test can reproduce the case that matters: A1111's own
 * `eta_relative` is extrapolated from the whole request including the model swap,
 * and it really does report absurd values early on (measured against the live
 * server: 2066s for a job that finished in 128s).
 */
let fakeProgress = { progress: 0.5, eta_relative: 1.5, current_image: null, state: { sampling_step: 14, sampling_steps: 28 } }

/**
 * Artificial delay on /sdapi/v1/txt2img, so the progress poller (900ms) gets a
 * chance to report while a job is still running. Zero by default: most tests want
 * the fake backend to answer instantly.
 */
let fakeA1111Txt2ImgDelayMs = 0

function startFakeA1111(port, requests) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ method: req.method, url: req.url, body })
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/sdapi/v1/options') {
      return json({ sd_model_checkpoint: 'waiIllustriousSDXL_v150.safetensors' })
    }
    if (req.method === 'GET' && url === '/sdapi/v1/sd-models') {
      return json([
        { title: 'waiIllustriousSDXL_v150.safetensors', model_name: 'wai' },
        { title: 'anything-v5.safetensors', model_name: 'anything' },
      ])
    }
    if (req.method === 'GET' && url === '/sdapi/v1/samplers') {
      return json([{ name: 'DPM++ 2M SDE' }, { name: 'Euler a' }])
    }
    if (req.method === 'GET' && url === '/sdapi/v1/upscalers') {
      return json([
        { name: 'None' },
        { name: 'RealESRGAN_x4plus_anime_6B' },
        { name: '4x-AnimeSharp' },
      ])
    }
    if (req.method === 'GET' && url === '/sdapi/v1/interrogators') {
      return json([{ name: 'deepdanbooru' }, { name: 'wd14' }])
    }
    if (req.method === 'GET' && url === '/controlnet/model_list') {
      return json({
        model_list: [
          'control_v11p_sd15_openpose_fp16 [b18e0966]',
          'control_v11p_sd15_lineart_anime_fp16 [x]',
          'control_v11p_sd15_canny_fp16 [y]',
        ],
      })
    }
    if (req.method === 'GET' && url === '/sdapi/v1/progress') {
      return json(fakeProgress)
    }
    if (req.method === 'POST' && url === '/sdapi/v1/txt2img') {
      if (fakeA1111Txt2ImgDelayMs > 0) await new Promise((r) => setTimeout(r, fakeA1111Txt2ImgDelayMs))
      const n = body.batch_size || 1
      return json({
        images: Array.from({ length: n }, () => SAMPLE_PNG_B64),
        info: JSON.stringify({ seed: 12345, width: body.width, height: body.height }),
      })
    }
    if (req.method === 'POST' && url === '/sdapi/v1/img2img') {
      return json({ images: [SAMPLE_PNG_B64], info: JSON.stringify({ seed: 999 }) })
    }
    if (req.method === 'POST' && url === '/sdapi/v1/extra-single-image') {
      const scale = body.upscaling_resize || 2
      const enlarged = encodePng(64 * scale, 64 * scale, (x, y) =>
        x >= 16 * scale && x < 48 * scale && y >= 16 * scale && y < 48 * scale ? [220, 40, 40, 255] : [255, 255, 255, 255])
      return json({ image: enlarged.toString('base64' ) })
    }
    if (req.method === 'POST' && url === '/sdapi/v1/interrogate') {
      return json({ caption: '1girl, solo, red dress, white background, masterpiece' })
    }
    if (req.method === 'POST' && url === '/sdapi/v1/interrupt') return json({})
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown ' + req.method + ' ' + req.url }))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ─────────────────────────── fake ComfyUI backend ───────────────────────────

/**
 * How many /history polls a fake ComfyUI run stays unfinished for. Zero (default)
 * completes immediately; a positive value lets a test observe what the JOB reports
 * while a render is still running — the only thing the user ever sees.
 */
let fakeComfyHoldPolls = 0

/**
 * When true, the fake names the SAME saved file under two output nodes. ComfyUI
 * does that when more than one node reports the same image, and the plugin used to
 * fetch and save it twice — one Qwen run really did land two identical PNGs a
 * second apart, which reads as "it ran twice" and doubles the apparent cost.
 */
let fakeComfyDuplicateOutputs = false

/**
 * When true, `/object_info` answers 500. A busy ComfyUI really does time out on a
 * 1700-node object_info while it renders, and the plugin must fall back to its cache
 * instead of declaring that it has no node definitions at all.
 */
let fakeComfyObjectInfoFails = false

/** Every WebSocket the plugin opened, with a handle to feed it frames. */
const fakeSockets = []
class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.handlers = {}
    this.closed = false
    fakeSockets.push(this)
  }
  addEventListener(type, listener) {
    if (this.handlers[type] === undefined) this.handlers[type] = []
    this.handlers[type].push(listener)
  }
  close() { this.closed = true }
  /** Deliver one ComfyUI frame, exactly as the real socket would. */
  emit(message) {
    for (const listener of this.handlers.message ?? []) listener({ data: JSON.stringify(message) })
  }
  /** Deliver a frame that is not even valid JSON. */
  emitRaw(text) {
    for (const listener of this.handlers.message ?? []) listener({ data: text })
  }
}

function startFakeComfy(port, requests) {
  const history = new Map()
  const pending = new Map()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: req.method, url: req.url, raw })
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/system_stats') {
      // A real card's shape: the plugin reads vram_total to warn before a run that
      // would page (8 GB here, like the machine this was written on).
      return json({
        system: { comfyui_version: 'test' },
        devices: [{ name: 'cuda:0', vram_total: 8_500_000_000, vram_free: 8_000_000_000 }],
      })
    }
    if (req.method === 'GET' && url === '/object_info/CheckpointLoaderSimple') {
      return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['anything-v5.safetensors']] } } } })
    }
    if (req.method === 'GET' && url === '/object_info') {
      if (fakeComfyObjectInfoFails) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      // The classes the built-in workflow templates use, in the real slot shapes.
      // KSampler's seed carries control_after_generate, i.e. TWO serialised slots.
      return json({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['anything-v5.safetensors', 'waiIllustriousSDXL_v150.safetensors']] } } },
        CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
        EmptyLatentImage: { input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } } },
        KSampler: {
          input: {
            required: {
              model: ['MODEL'],
              seed: ['INT', { default: 0, control_after_generate: true }],
              steps: ['INT', { default: 20 }],
              cfg: ['FLOAT', { default: 8 }],
              sampler_name: [['euler', 'dpmpp_2m']],
              scheduler: [['normal', 'karras']],
              positive: ['CONDITIONING'],
              negative: ['CONDITIONING'],
              latent_image: ['LATENT'],
              denoise: ['FLOAT', { default: 1 }],
            },
          },
        },
        VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
        VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
        SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
        PreviewImage: { input: { required: { images: ['IMAGE'] } } },
        LoadImage: { input: { required: { image: [['example.png']] } } },
        UpscaleModelLoader: { input: { required: { model_name: [['RealESRGAN_x4plus_anime_6B.pth']] } } },
        ImageUpscaleWithModel: { input: { required: { upscale_model: ['UPSCALE_MODEL'], image: ['IMAGE'] } } },
        LayeredDiffusionApply: { input: { required: { model: ['MODEL'], config: [['SD15', 'SDXL']], weight: ['FLOAT', { default: 1 }] } } },
        LayeredDiffusionDecodeRGBA: { input: { required: { samples: ['LATENT'], images: ['IMAGE'], config: [['SD15', 'SDXL']], _version: ['INT', { default: 16 }] } } },
      })
    }
    // Mirrors the real install, where extra_model_paths.yaml points ComfyUI at
    // the SD WebUI model directories.
    if (req.method === 'GET' && url === '/object_info/ControlNetLoader') {
      return json({ ControlNetLoader: { input: { required: { control_net_name: [['control_v11p_sd15_openpose_fp16.safetensors', 'control_v11p_sd15_lineart_anime_fp16.safetensors']] } } } })
    }
    if (req.method === 'GET' && url === '/object_info/UpscaleModelLoader') {
      return json({ UpscaleModelLoader: { input: { required: { model_name: [['RealESRGAN_x4plus_anime_6B.pth', '4x-AnimeSharp.pth']] } } } })
    }
    if (req.method === 'POST' && url === '/prompt') {
      const id = 'prompt-' + (history.size + pending.size + 1)
      const images = [{ filename: 'ComfyUI_test.png', subfolder: '', type: 'output' }]
      const result = {
        outputs: fakeComfyDuplicateOutputs
          ? { '9': { images }, '10': { images } }
          : { '9': { images } },
        status: { status_str: 'success', completed: true },
      }
      // Held runs stay "not in /history yet" for N polls, which is what a real
      // render looks like from the REST side: nothing to report until it ends.
      if (fakeComfyHoldPolls > 0) pending.set(id, { result, pollsLeft: fakeComfyHoldPolls })
      else history.set(id, result)
      return json({ prompt_id: id })
    }
    if (req.method === 'GET' && url.startsWith('/history/')) {
      const id = url.slice('/history/'.length)
      const held = pending.get(id)
      if (held !== undefined) {
        held.pollsLeft -= 1
        if (held.pollsLeft > 0) return json({})
        pending.delete(id)
        history.set(id, held.result)
        return json({ [id]: held.result })
      }
      return json(history.has(id) ? { [id]: history.get(id) } : {})
    }
    if (req.method === 'GET' && url === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(SAMPLE_PNG)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown ' + req.method + ' ' + req.url }))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/**
 * An SD WebUI that accepts /sdapi/v1/txt2img and then NEVER answers — the
 * signature of a backend stuck mid-sampling (and of a real SDXL run that
 * outlives the client's patience).
 */
function startFakeA1111Hanging(port, requests) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, url: req.url })
    const url = req.url.split('?')[0]
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url === '/sdapi/v1/options') return json({ sd_model_checkpoint: 'hang.safetensors' })
    if (req.method === 'POST' && url === '/sdapi/v1/interrupt') return json({})
    // Deliberately never responds.
    if (req.method === 'POST' && url === '/sdapi/v1/txt2img') return undefined
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
    return undefined
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ─────────────────────────── fake WD14-tagger-only SD WebUI ───────────────────────────
/**
 * Mirrors the real 秋叶 install: `/sdapi/v1/interrogators` is 404, but the
 * wd14 tagger extension serves `/tagger/v1/*`.
 */
function startFakeTaggerOnly(port, requests) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: req.method, url: req.url, body: raw === '' ? {} : JSON.parse(raw) })
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/sdapi/v1/options') return json({ sd_model_checkpoint: 'wai.sel' })
    if (req.method === 'GET' && url === '/tagger/v1/interrogators') {
      return json({ models: ['wd-eva02-large-tagger-v3', 'wd14-convnextv2-v2', 'wd14-vit'] })
    }
    if (req.method === 'POST' && url === '/tagger/v1/interrogate') {
      return json({ caption: { rating: 'general', general: '1girl, solo, red dress, masterpiece' } })
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown ' + req.method + ' ' + req.url }))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ─────────────────────────── mocked DSH services ───────────────────────────

/** In-memory stand-in for the harness json storage backend (one live unit per name). */
function makeStorageBackend() {
  const units = new Map()
  return {
    get(name) {
      if (name !== 'json') throw new Error(`backend "${name}" not found`)
      return {
        kv: {
          async open(descriptor) {
            if (process.env.GIG_DEBUG) {
              console.log(`DEBUG  kv.open(${descriptor.name}) live=${units.has(descriptor.name) ? units.get(descriptor.name).live : 'new'}`)
              console.log(new Error('open-trace').stack.split('\n').slice(2, 7).join('\n'))
            }
            if (units.has(descriptor.name) && units.get(descriptor.name).live) {
              throw new Error('unit is already open: ' + descriptor.name)
            }
            const state = units.get(descriptor.name) || { tables: {}, global: null }
            state.live = true
            units.set(descriptor.name, state)
            const clone = (v) => JSON.parse(JSON.stringify(v))
            return {
              async loadAll() {
                return { tables: clone(state.tables), global: clone(state.global) }
              },
              async putRecord(table, key, value) {
                if (!state.tables[table]) state.tables[table] = {}
                state.tables[table][key] = clone(value)
              },
              async deleteRecord(table, key) {
                if (state.tables[table]) delete state.tables[table][key]
              },
              async setGlobal(value) {
                state.global = clone(value)
              },
              async close() {
                state.live = false
                if (process.env.GIG_DEBUG) console.log(`DEBUG  kv.close(${descriptor.name})`)
              },
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
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    storage: { backend },
    get(name) {
      if (name === 'subprocess') return undefined
      if (name === 'webServer') return extra.webServer
      return undefined
    },
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

function makeWebServer() {
  const routes = []
  return {
    routes,
    register(opts) {
      routes.push(opts)
      return () => {}
    },
  }
}

function jsonRequest(method, pathname, body) {
  return {
    method,
    url: pathname,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    },
  }
}
function jsonResponse() {
  const captured = {}
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(body) { captured.body = body },
  }
}
async function callRoute(webServer, method, pathname, body) {
  const route = webServer.routes.find((r) => r.path === '/gig')
  const res = jsonResponse()
  await route.handler(jsonRequest(method, pathname, body), res)
  let parsed = null
  if (typeof res.captured.body === 'string') {
    try { parsed = JSON.parse(res.captured.body) } catch { parsed = res.captured.body }
  }
  return { status: res.captured.status, body: parsed, raw: res.captured.body }
}

const byName = (list, name) => list.find((tool) => tool.name === name)
const exec = (tool, args) => tool.execute(args, { signal: { aborted: false } })
const unwrap = (result) => result

// ─────────────────────────── the run ───────────────────────────

const SD_PORT = 17860
const COMFY_PORT = 18188
const AKI_PYTHON = 'D:/AKI open/ComfyUI-aki-v2/python/python.exe'

async function main() {
  const workRoot = await mkdtemp(join(tmpdir(), 'gig-test-'))
  const godotProject = join(workRoot, 'godot-project')
  await mkdir(join(godotProject, 'assets'), { recursive: true })
  await writeFile(join(godotProject, 'project.godot'), 'config_version=5\n', 'utf8')

  const sdRequests = []
  const comfyRequests = []
  const sdServer = await startFakeA1111(SD_PORT, sdRequests)
  const comfyServer = await startFakeComfy(COMFY_PORT, comfyRequests)

  const postAvailable = existsSync(AKI_PYTHON)
  if (!postAvailable) console.log(`NOTE  秋叶 Python not found at ${AKI_PYTHON} — post-processing assertions will be skipped`)

  const config = {
    unitName: 'godot_imagegen_test',
    sdwebuiPort: SD_PORT,
    comfyPort: COMFY_PORT,
    sdwebuiRoot: 'D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10',
    sdwebuiPython: 'D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10/python/python.exe',
    comfyRoot: 'D:/AKI open/ComfyUI-aki-v2',
    comfyPython: AKI_PYTHON,
    postPython: AKI_PYTHON,
    godotProject,
    defaultBackend: 'sdwebui',
    requestTimeoutMs: 60000,
    startTimeoutMs: 5000,
    // Never let a test seed the workflow library into the user's real data root.
    dataRoot: join(workRoot, 'data'),
  }

  const storage = makeStorageBackend()
  const webServer = makeWebServer()
  const { ctx, registered, disposers } = makeCtx(storage, { webServer })
  plugin.apply(ctx, config)

  // ── module + registration shape ──
  assert(plugin.name === 'godot-imagegen', 'plugin exports the expected name')
  assert(Array.isArray(plugin.inject) && plugin.inject.includes('tools') && plugin.inject.includes('storage'), 'plugin injects tools + storage')
  const expectedTools = [
    'image_backend_status', 'image_generate', 'image_edit', 'image_variants',
    'image_upscale', 'image_cutout', 'image_interrogate', 'image_gallery',
    'image_workflow', 'image_workshop',
  ]
  assert(registered.length === 10, `registers exactly 10 tools (got ${registered.length})`)
  for (const toolName of expectedTools) {
    assert(byName(registered, toolName) !== undefined, `registers ${toolName}`)
  }
  assert(webServer.routes.length === 1 && webServer.routes[0].path === '/gig', 'registers the /gig REST prefix')

  // ── ARG-000: no unit name collision with godot-asset-planner ──
  assert(config.unitName !== 'godot_asset_planner' && config.unitName !== 'godot_asset_planner_ui',
    'uses its own KV unit (never the asset planner unit)')

  // ── T1: backend status ──
  const statusTool = byName(registered, 'image_backend_status')
  const status = unwrap(await exec(statusTool, {}))
  assert(status.backends.length === 2, 'status reports both backends')
  const sd = status.backends.find((b) => b.id === 'sdwebui')
  const comfy = status.backends.find((b) => b.id === 'comfyui')
  assert(sd.running === true, 'detects the running SD WebUI')
  assert(sd.models.length === 2 && sd.models[0].includes('waiIllustriousSDXL'), 'lists SD WebUI checkpoints')
  assert(sd.detail.includes('ControlNet 3'), 'reports the ControlNet model count')
  // The loaded checkpoint is what an unspecified model means — the panel names it
  // rather than leaving the choice invisible.
  assert(sd.currentModel === 'waiIllustriousSDXL_v150.safetensors',
    `reports the checkpoint that is actually LOADED (${sd.currentModel})`)
  assert(comfy.currentModel === undefined, 'and ComfyUI, which has no notion of a loaded checkpoint, reports none')
  assert(Array.isArray(sd.strengths) && sd.strengths.some((s) => s.includes('ControlNet 3')),
    'exposes human-readable capability strengths to the model')
  assert(sd.strengths.some((s) => s.startsWith('反推提示词')), 'reports which prompt-interrogation route is available')
  assert(comfy.running === true, 'detects the running ComfyUI')
  assert(comfy.strengths.some((s) => s.includes('ControlNet 权重 2 个')),
    'ComfyUI reports the ControlNet weights it shares from the SD WebUI install (extra_model_paths)')
  assert(comfy.strengths.some((s) => s.includes('放大权重 2 个')), 'ComfyUI reports the shared upscale weights')
  assert(comfy.strengths.some((s) => s.includes('只实现文生图')),
    'ComfyUI discloses the adapter limitation so the model routes ControlNet/upscale to SD WebUI')
  assert(status.outputRoot === join(godotProject, 'assets', 'generated'), 'output root defaults to <project>/assets/generated')
  assert(status.godotProject.replace(/\\/g, '/') === godotProject.replace(/\\/g, '/'), 'reports the configured Godot project')

  // ── T2: start adopts an already-running instance, never spawns a duplicate ──
  const started = unwrap(await exec(statusTool, { action: 'start', backend: 'sdwebui' }))
  assert(started.note.includes('已在运行') && started.note.includes('不重启'), 'start adopts a live backend instead of duplicating it')
  const stopRefused = unwrap(await exec(statusTool, { action: 'stop', backend: 'sdwebui' }))
  assert(stopRefused.note.includes('拒绝终止'), 'stop refuses to kill an instance the plugin did not start')

  // ── T3: generate (SD WebUI) ──
  const generateTool = byName(registered, 'image_generate')
  const gen = unwrap(await exec(generateTool, {
    prompt: 'game item icon, potion bottle, single object',
    negative_prompt: 'blurry',
    category: 'item',
    name: 'potion',
    width: 512,
    height: 512,
    steps: 20,
    cfg_scale: 7,
    seed: 42,
    transparent_method: 'chroma',
    project_id: 'testproj',
  }))
  assert(gen.count === 1, 'generate produces one image')
  const first = gen.images[0]
  assert(first.backend === 'sdwebui', 'generate ran on SD WebUI')
  assert(first.filePath.includes(join('assets', 'generated', 'item')), 'generated file lands in assets/generated/item')
  assert(typeof first.resPath === 'string' && first.resPath.startsWith('res://assets/generated/item/'), 'returns a res:// path inside the Godot project')
  assert(first.category === 'item' && first.seed === 12345, 'records category and seed')
  assert(existsSync(first.filePath), 'generated PNG exists on disk')
  const txt2imgCall = sdRequests.find((r) => r.url === '/sdapi/v1/txt2img')
  assert(txt2imgCall !== undefined && txt2imgCall.body.prompt.includes('potion'), 'forwards the prompt to /sdapi/v1/txt2img')
  assert(txt2imgCall.body.override_settings.sd_model_checkpoint === 'waiIllustriousSDXL_v150.safetensors', 'selects the first available checkpoint by default')

  // ── T3b: blank optional text means "not provided", never an error ──
  // REGRESSION: the 美术工坊 panel posts `negativePrompt: ""` whenever the
  // negative-prompt box is left empty (its initial state), and an agent may pass
  // `negative_prompt: ""` / `sampler: ""` / `out_dir: ""` for the same reason.
  // Treating those as validation failures made every panel generation fail with
  // "negativePrompt, when provided, must be a non-empty string".
  const blankGen = unwrap(await exec(generateTool, {
    prompt: 'blank optional text',
    negative_prompt: '',
    sampler: '',
    model: '',
    name: '',
    out_dir: '',
    category: 'item',
    width: 256,
    height: 256,
    steps: 6,
    seed: 1,
    transparent: false,
    project_id: 'testproj',
  }))
  assert(blankGen.count === 1, 'blank optional text (negative_prompt/sampler/model/name/out_dir) is accepted')
  assert(!blankGen.images[0].filePath.includes('-0x0'), 'an empty name still produces a sane auto-generated filename')
  assert(/[\\/]item-\d{8}-\d{6}-/.test(blankGen.images[0].filePath), 'a blank name falls back to the <category>-<timestamp> pattern')
  const blankCall = sdRequests.filter((r) => r.url === '/sdapi/v1/txt2img').pop()
  assert(blankCall.body.negative_prompt === '', 'an absent negative prompt reaches the backend as an empty string, not an error')
  assert(blankCall.body.sampler_name === 'DPM++ 2M SDE', 'a blank sampler falls back to the default instead of overriding it')
  await rejects(
    () => exec(generateTool, { prompt: 'x', negative_prompt: 42 }),
    /negative_prompt, when provided, must be a string/,
    'a non-string optional value is still rejected',
  )

  // ── T4: transparent (chroma) actually produced an alpha channel ──
  if (postAvailable) {
    const generatedBytes = await readFile(first.filePath)
    assert(readPngSize(generatedBytes).width === 64, 'post-processed PNG keeps its pixel size')
    assert(first.method === 'chroma', 'records the cutout method used')
    assert(readPngColorType(generatedBytes) === 6, 'cutout rewrote the PNG as RGBA (colour type 6)')
  }

  // ── T5: variants ──
  const variantsTool = byName(registered, 'image_variants')
  const variants = unwrap(await exec(variantsTool, {
    prompt: 'seamless tileable grass texture, top down',
    category: 'tile',
    count: 3,
    name: 'grass',
    seed: -1,
    project_id: 'testproj',
  }))
  assert(variants.count === 3, 'variants honours count=3')
  assert(variants.images.every((i) => i.category === 'tile'), 'variants keep the requested category')
  const batchCall = sdRequests.filter((r) => r.url === '/sdapi/v1/txt2img').pop()
  assert(batchCall.body.batch_size === 3, 'variants uses one batched request on SD WebUI')
  assert(batchCall.body.tiling === true, 'tile category enables seamless tiling on the backend')

  // ── T6: generate on ComfyUI ──
  const comfyGen = unwrap(await exec(generateTool, {
    prompt: 'chibi slime monster, game sprite',
    category: 'character',
    name: 'slime',
    width: 512,
    height: 512,
    steps: 18,
    backend: 'comfyui',
    transparent: false,
    project_id: 'testproj',
  }))
  assert(comfyGen.images[0].backend === 'comfyui', 'generate can target ComfyUI explicitly')
  assert(comfyGen.images[0].model === 'anything-v5.safetensors', 'picks the ComfyUI checkpoint')
  const promptCall = comfyRequests.find((r) => r.url === '/prompt')
  assert(promptCall !== undefined, 'ComfyUI received a /prompt graph')
  const graph = JSON.parse(promptCall.raw).prompt
  assert(graph['4'].class_type === 'CheckpointLoaderSimple', 'graph has a CheckpointLoaderSimple node')
  assert(graph['3'].class_type === 'KSampler' && graph['3'].inputs.positive[0] === '6', 'graph wires KSampler to the positive conditioning')
  assert(graph['9'].class_type === 'SaveImage', 'graph ends in SaveImage')
  assert(comfyGen.images[0].filePath.includes(join('assets', 'generated', 'character')), 'ComfyUI output lands in the character category folder')

  // ── T7: edit (img2img) ──
  const editTool = byName(registered, 'image_edit')
  const edited = unwrap(await exec(editTool, {
    image: first.resPath,
    prompt: 'same potion, glowing blue liquid',
    category: 'item',
    name: 'potion-blue',
    denoise: 0.5,
    project_id: 'testproj',
  }))
  assert(edited.count === 1 && edited.images[0].op === 'edit', 'edit records op=edit')
  const img2imgCall = sdRequests.find((r) => r.url === '/sdapi/v1/img2img')
  assert(img2imgCall !== undefined && img2imgCall.body.init_images.length === 1, 'edit sends the source image as init_images')
  assert(Math.abs(img2imgCall.body.denoising_strength - 0.5) < 1e-9, 'edit forwards denoise as denoising_strength')
  assert(edited.images[0].filePath.includes('assets'), 'edited file is written under the project')

  // ── T8: upscale via the real 秋叶 Python (lanczos path) ──
  const upscaleTool = byName(registered, 'image_upscale')
  if (postAvailable) {
    const up = unwrap(await exec(upscaleTool, {
      image: first.resPath,
      scale: 2,
      method: 'lanczos',
      category: 'item',
      name: 'potion-x2',
      project_id: 'testproj',
    }))
    const upBytes = await readFile(up.image.filePath)
    assert(readPngSize(upBytes).width === 128 && readPngSize(upBytes).height === 128, 'lanczos upscale produced a 128x128 PNG')
    assert(up.image.method === 'lanczos', 'records the lanczos method')
  }

  // ── T9: upscale via SD WebUI ──
  const upEsrgan = unwrap(await exec(upscaleTool, {
    image: first.resPath,
    scale: 2,
    method: 'esrgan',
    category: 'item',
    name: 'potion-esrgan',
    project_id: 'testproj',
  }))
  const extraCall = sdRequests.find((r) => r.url === '/sdapi/v1/extra-single-image')
  assert(extraCall !== undefined, 'upscale called /sdapi/v1/extra-single-image')
  assert(extraCall.body.upscaler_1 === 'RealESRGAN_x4plus_anime_6B', 'prefers the anime-tuned RealESRGAN model')
  assert(upEsrgan.image.method === 'RealESRGAN_x4plus_anime_6B', 'records the upscaler that actually ran')

  // ── T10: cutout via the real Python ──
  if (postAvailable) {
    const cutoutTool = byName(registered, 'image_cutout')
    // The bridge script must be materialised in a stable place under the plugin
    // data root. It used to be a fresh mkdtemp() per DSH start, which leaked one
    // %TEMP%/gig-py-* directory (script + JSON result) on every start.
    const tempBefore = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith('gig-py-')))
    const cut = unwrap(await exec(cutoutTool, {
      image: first.resPath,
      method: 'chroma',
      key_color: '#FFFFFF',
      category: 'item',
      name: 'potion-cut',
      project_id: 'testproj',
    }))
    const cutBytes = await readFile(cut.image.filePath)
    assert(readPngColorType(cutBytes) === 6, 'cutout wrote an RGBA PNG')
    assert(cut.image.method === 'chroma', 'cutout reports the chroma method')
    assert(existsSync(join(config.dataRoot, 'python', 'gig_tools.py')), 'the Python bridge script lives under the plugin data root')
    const leaked = readdirSync(tmpdir()).filter((entry) => entry.startsWith('gig-py-') && !tempBefore.has(entry))
    assert(leaked.length === 0, `a Python call leaves no %TEMP% directory behind (leaked: ${leaked.join(', ') || 'none'})`)

    // Self-heal: cleaning the data root mid-session must not brick the bridge.
    await rm(join(config.dataRoot, 'python'), { recursive: true, force: true })
    const healed = unwrap(await exec(cutoutTool, {
      image: first.resPath,
      method: 'chroma',
      key_color: '#FFFFFF',
      category: 'item',
      name: 'potion-heal',
      project_id: 'testproj',
    }))
    assert(readPngColorType(await readFile(healed.image.filePath)) === 6, 'the bridge rewrites its script after the data root is cleaned')
  }

  // ── T11: interrogate ──
  const interrogateTool = byName(registered, 'image_interrogate')
  const caption = unwrap(await exec(interrogateTool, { image: first.resPath }))
  assert(caption.caption.includes('1girl'), 'interrogate returns the tag caption')
  assert(caption.model === 'deepdanbooru', 'interrogate picks deepdanbooru by default')

  // ── T11b: interrogate falls back to the WD14 tagger extension ──
  // The real 秋叶 install has NO /sdapi/v1/interrogators (404) but DOES ship the
  // wd14 tagger extension, so the second route is the one that actually runs
  // there. A dedicated server with only /tagger/v1/* exercises it.
  const TAGGER_PORT = 17861
  const taggerRequests = []
  const taggerServer = await startFakeTaggerOnly(TAGGER_PORT, taggerRequests)
  try {
    const taggerCtx = makeCtx(storage, { webServer: makeWebServer() })
    plugin.apply(taggerCtx.ctx, Object.assign({}, config, { sdwebuiPort: TAGGER_PORT }))
    const taggerTool = byName(taggerCtx.registered, 'image_interrogate')
    const taggerCaption = unwrap(await exec(taggerTool, { image: first.filePath }))
    assert(taggerCaption.caption.includes('1girl'), 'interrogate reads the WD14 tagger caption')
    assert(taggerCaption.model.includes('wd14') && taggerCaption.model.includes('tagger'),
      'interrogate reports which WD14 model answered')
    const taggerCall = taggerRequests.find((r) => r.url === '/tagger/v1/interrogate')
    assert(taggerCall !== undefined && taggerCall.body.model === 'wd14-convnextv2-v2',
      'WD14 fallback posts to /tagger/v1/interrogate with the preferred model')
    for (const dispose of taggerCtx.disposers) dispose()
  } finally {
    await new Promise((resolve) => taggerServer.close(resolve))
  }

  // ── T12: gallery ──
  const galleryTool = byName(registered, 'image_gallery')
  const listed = unwrap(await exec(galleryTool, { action: 'list', project_id: 'testproj' }))
  assert(listed.images.length >= 6, `gallery lists every produced image (got ${listed.images.length})`)
  const itemOnly = unwrap(await exec(galleryTool, { action: 'list', category: 'item', project_id: 'testproj' }))
  assert(itemOnly.images.every((i) => i.category === 'item'), 'gallery filters by category')
  const otherProject = unwrap(await exec(galleryTool, { action: 'list', project_id: 'other' }))
  assert(otherProject.images.length === 0, 'gallery isolates projects')
  const victim = listed.images[0]
  const deleted = unwrap(await exec(galleryTool, { action: 'delete', id: victim.id }))
  assert(deleted.removed === 1, 'gallery deletes one record')
  assert(!existsSync(victim.filePath), 'gallery delete also removes the PNG unless keep_file is set')
  const afterDelete = unwrap(await exec(galleryTool, { action: 'list', project_id: 'testproj' }))
  assert(afterDelete.images.length === listed.images.length - 1, 'deleted record is gone from the list')

  // ── T13: ControlNet wiring ──
  const cnGen = unwrap(await exec(generateTool, {
    prompt: 'character standing pose',
    category: 'character',
    name: 'pose-test',
    control_image: first.filePath,
    control_type: 'openpose',
    project_id: 'testproj',
  }))
  assert(cnGen.count === 1, 'generation with a ControlNet reference succeeds')
  const cnCall = sdRequests.filter((r) => r.url === '/sdapi/v1/txt2img').pop()
  const args = cnCall.body.alwayson_scripts.controlnet.args[0]
  assert(args.module === 'openpose' && args.model.includes('openpose'), 'ControlNet sends the openpose module and model')
  assert(args.save_detected_map === false, 'ControlNet suppresses its detected-map preview so it is not saved as a fake asset')

  // ── T14: error paths ──
  await rejects(() => exec(generateTool, { prompt: 'x', backend: 'comfyui', model: 'nope.safetensors' }),
    /was not found/, 'unknown checkpoint produces a clear error')
  await rejects(() => exec(generateTool, { prompt: '' }), /prompt must be a non-empty string/, 'empty prompt is rejected')
  await rejects(() => exec(editTool, { image: first.resPath, prompt: 'x', denoise: 5 }), /denoise must be between/, 'out-of-range denoise is rejected')
  await rejects(() => exec(galleryTool, { action: 'delete', id: 'img_missing' }), /找不到记录/, 'deleting an unknown image id fails clearly')
  await rejects(() => exec(upscaleTool, { image: 'relative/path.png' }), /绝对路径/, 'a relative image path is rejected')
  await rejects(() => exec(statusTool, { action: 'status', backend: 'nope' }), /must be one of/, 'an unknown backend id is rejected')

  // ── R1..: REST surface ──
  const restState = await callRoute(webServer, 'GET', '/gig/state')
  assert(restState.status === 200 && restState.body.backends.length === 2, 'GET /gig/state returns backends')
  assert(Array.isArray(restState.body.presets) && restState.body.presets.length >= 11, 'GET /gig/state ships the built-in prompt presets')
  assert(restState.body.categories.length === 7, 'GET /gig/state lists all 7 art categories')
  assert(restState.body.controlTypes.includes('openpose'), 'GET /gig/state lists the ControlNet types')

  const restGallery = await callRoute(webServer, 'GET', '/gig/gallery?project=testproj')
  assert(restGallery.status === 200 && restGallery.body.images.length >= 5, 'GET /gig/gallery returns the project gallery')

  const fileRoute = webServer.routes[0].handler
  const fileRes = jsonResponse()
  await fileRoute(jsonRequest('GET', '/gig/file?id=' + encodeURIComponent(restGallery.body.images[0].id)), fileRes)
  assert(fileRes.captured.status === 200 && fileRes.captured.headers['content-type'] === 'image/png', 'GET /gig/file serves PNG bytes')
  assert(Buffer.isBuffer(fileRes.captured.body), 'GET /gig/file returns a buffer body')

  const missingFile = await callRoute(webServer, 'GET', '/gig/file?id=img_nope')
  assert(missingFile.status === 404, 'GET /gig/file 404s for an unknown id')

  const genRoute = await callRoute(webServer, 'POST', '/gig/generate', {
    prompt: 'ui button, empty center',
    category: 'ui',
    name: 'btn',
    transparent: false,
    projectId: 'testproj',
  })
  assert(genRoute.status === 200 && typeof genRoute.body.jobId === 'string', 'POST /gig/generate returns a jobId immediately')
  await new Promise((r) => setTimeout(r, 700))
  const jobsRoute = await callRoute(webServer, 'GET', '/gig/jobs')
  const restJob = jobsRoute.body.jobs.find((j) => j.id === genRoute.body.jobId)
  assert(restJob !== undefined && restJob.status === 'done', `the REST generate job reaches status done (job=${JSON.stringify(restJob && { status: restJob.status, message: restJob.message, error: restJob.error })})`)
  assert(restJob.images.length === 1, 'the REST generate job carries its produced image')

  const settingsRoute = await callRoute(webServer, 'POST', '/gig/settings', { lastCategory: 'tile' })
  assert(settingsRoute.status === 200 && settingsRoute.body.settings.lastCategory === 'tile', 'POST /gig/settings persists a setting')
  const stateAfterSettings = await callRoute(webServer, 'GET', '/gig/state')
  assert(stateAfterSettings.body.settings.lastCategory === 'tile', 'the setting survives a re-read')

  const presetRoute = await callRoute(webServer, 'POST', '/gig/presets', {
    name: '测试预设', category: 'tile', prompt: 'seamless stone floor', width: 768, height: 768, steps: 30, cfgScale: 7,
  })
  assert(presetRoute.status === 200 && presetRoute.body.presets.some((p) => p.name === '测试预设'), 'POST /gig/presets adds a user preset')
  assert(presetRoute.body.presets.some((p) => p.builtin === true), 'user presets do not displace built-ins')

  const badRoute = await callRoute(webServer, 'GET', '/gig/nope')
  assert(badRoute.status === 404, 'unknown /gig route 404s')

  const badBody = await callRoute(webServer, 'POST', '/gig/generate', { category: 'item' })
  assert(badBody.status === 400, 'a missing prompt in a REST body is a 400')

  // ── R-blank: the exact payload the 美术工坊 panel sends on a fresh form ──
  // REGRESSION: this is the bug the user hit — an untouched negative-prompt box
  // posts "" and the whole generation was rejected.
  const panelShaped = await callRoute(webServer, 'POST', '/gig/generate', {
    prompt: 'ui button, empty center',
    negativePrompt: '',
    category: 'ui',
    width: 1024,
    height: 1024,
    steps: 26,
    cfgScale: 6,
    seed: -1,
    count: 1,
    backend: 'auto',
    model: undefined,
    transparent: true,
    transparentMethod: 'auto',
    seamless: false,
    projectId: 'testproj',
    controlType: undefined,
    controlImage: undefined,
  })
  assert(panelShaped.status === 200 && typeof panelShaped.body.jobId === 'string',
    'POST /gig/generate accepts the panel-shaped body with an empty negativePrompt')
  // The panel's default is transparent + auto, so this job also runs rembg
  // against the real 秋叶 Python — allow a few seconds for that.
  await new Promise((r) => setTimeout(r, 6000))
  const panelJob = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === panelShaped.body.jobId)
  assert(panelJob !== undefined && panelJob.status === 'done',
    `the panel-shaped generation completes (status=${panelJob && panelJob.status} msg=${panelJob && panelJob.message})`)

  // ── R-progress: what the panel SHOWS while a job runs ──
  //
  // The progress line is the only feedback during a long render, and the backend's
  // own eta_relative is unusable early on: measured live, A1111 claimed 2066s (34
  // minutes) for a job that finished in 128s. So the plugin computes its own
  // remaining time from COMPLETED steps and says "preparing" before the first one.
  // This reproduces both branches with a slowed-down fake backend.
  {
    const progressJob = async (progressShape, delayMs) => {
      fakeProgress = progressShape
      fakeA1111Txt2ImgDelayMs = delayMs
      const posted = await callRoute(webServer, 'POST', '/gig/generate', {
        prompt: 'progress probe', category: 'item', width: 512, height: 512, steps: 12, backend: 'sdwebui', projectId: 'progress',
      })
      const seen = []
      const deadline = Date.now() + 20_000
      let job
      while (Date.now() < deadline) {
        job = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === posted.body.jobId)
        if (job !== undefined && (seen.length === 0 || seen[seen.length - 1] !== job.message)) seen.push(job.message)
        if (job !== undefined && job.status !== 'running') break
        await new Promise((r) => setTimeout(r, 150))
      }
      fakeA1111Txt2ImgDelayMs = 0
      return { job, seen }
    }

    const early = await progressJob({ progress: 0, eta_relative: 2066, current_image: null, state: { sampling_step: 0, sampling_steps: 12 } }, 2200)
    assert(early.job !== undefined && early.job.status === 'done', 'a slowed-down generation still finishes')
    assert(early.seen.some((m) => /正在准备/.test(m)), `before the first step the panel is told it is preparing (${early.seen.join(' | ')})`)
    assert(!early.seen.some((m) => /2066/.test(m)), 'and the backend\'s absurd 34-minute estimate is never shown to the user')
    assert(!early.seen.some((m) => /剩余约/.test(m)), 'no number is invented before any step has completed')

    const measured = await progressJob({ progress: 0.25, eta_relative: 9999, current_image: null, state: { sampling_step: 3, sampling_steps: 12 } }, 2200)
    const withEta = measured.seen.find((m) => /剩余约/.test(m))
    assert(withEta !== undefined, `once a step has completed the panel gets a real estimate (${measured.seen.join(' | ')})`)
    const seconds = Number((withEta || '').match(/剩余约 (\d+)s/)[1])
    assert(Number.isFinite(seconds) && seconds > 0 && seconds < 300,
      `and it is derived from the observed step time, not the backend's eta_relative=9999 (got ${seconds}s)`)
    assert(measured.seen.some((m) => /采样 3\/12/.test(m)), 'the step counter is still reported verbatim')
    fakeProgress = { progress: 0.5, eta_relative: 1.5, current_image: null, state: { sampling_step: 14, sampling_steps: 28 } }
  }

  const blankEdit = await callRoute(webServer, 'POST', '/gig/edit', {
    image: first.filePath,
    prompt: 'recolour it',
    negativePrompt: '',
    mask: '',
    sampler: '',
    category: 'item',
    projectId: 'testproj',
  })
  assert(blankEdit.status === 200 && typeof blankEdit.body.jobId === 'string',
    'POST /gig/edit accepts blank negativePrompt and mask')

  const badRest = await callRoute(webServer, 'POST', '/gig/generate', { prompt: 'x', negativePrompt: 42 })
  assert(badRest.status === 400, 'a non-string negativePrompt in a REST body is still a 400')

  // ── R-contract: the panel's routes and payloads must match the host ──
  // The blank-negativePrompt bug slipped through because the REST routes were
  // tested, but never with the exact body the panel builds. These static
  // cross-checks catch route typos and renames cheaply; the "panel-shaped body"
  // test above covers the payload contract behaviourally.
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const hostSource = readFileSync(new URL('../godot-imagegen.ts', import.meta.url), 'utf8')

  const gigRoutes = [...new Set([...clientSource.matchAll(/['"](\/gig\/[a-z/]+)['"]/g)].map((m) => m[1]))].sort()
  assert(gigRoutes.length >= 12, `the panel calls ${gigRoutes.length} distinct /gig routes`)
  const unhandled = gigRoutes.filter((route) => !hostSource.includes(`'${route}'`))
  assert(unhandled.length === 0, `every /gig route the panel calls is handled by the host (unhandled: ${unhandled.join(', ') || 'none'})`)
  assert(hostSource.includes("path: '/gig'"), 'the host registers the /gig prefix the panel targets')

  // The panel talks to exactly two routes of the NEIGHBOURING plugin; both were
  // verified against godot-asset-planner's own route table.
  const gapRoutes = [...new Set([...clientSource.matchAll(/['"](\/gap\/[a-z/]+)['"]/g)].map((m) => m[1]))].sort()
  const knownGapRoutes = ['/gap/assets', '/gap/state']
  assert(gapRoutes.length > 0 && gapRoutes.every((route) => knownGapRoutes.includes(route)),
    `the panel only calls verified godot-asset-planner routes (${gapRoutes.join(', ')})`)

  // ── T17: image_workflow — author, patch and run a ComfyUI workflow ──
  const workflowTool = byName(registered, 'image_workflow')
  const listResult = unwrap(await exec(workflowTool, { action: 'list' }))
  assert(listResult.workflows.length === 6, `the library seeds the 6 built-in templates (${listResult.workflows.length})`)
  assert(listResult.workflows.some((w) => w.id === 'sd15-basic'), 'the SD1.5 template is listed')
  assert(listResult.workflows.every((w) => w.nodeCount > 0), 'every listed template has nodes')
  assert(listResult.workflows.every((w) => w.classes.length > 0), 'every listing carries its class inventory')

  const readResult = unwrap(await exec(workflowTool, { action: 'read', id: 'sd15-basic' }))
  assert(readResult.workflow.nodeCount === 7, 'action=read reports the node count')
  assert(readResult.workflow.linkCount === 9, 'action=read reports the link count')
  const samplerRead = readResult.workflow.nodes.find((n) => n.type === 'KSampler')
  assert(samplerRead.widgets.steps === 20 && samplerRead.widgets.sampler_name === 'dpmpp_2m',
    'action=read decodes the KSampler widgets by name (the two-slot seed did not shift them)')

  // Patch by name; the layouts come from the fake server's /object_info, cached.
  const patchResult = unwrap(await exec(workflowTool, {
    action: 'patch',
    id: 'sd15-basic',
    edits: [
      { classType: 'CLIPTextEncode', title: '正向提示词', set: { text: 'a red potion, game icon' } },
      { classType: 'KSampler', set: { steps: 9, seed: 1234 } },
    ],
  }))
  assert(patchResult.applied.length === 2, `action=patch reports what it changed (${patchResult.applied.join('、')})`)
  const afterPatch = unwrap(await exec(workflowTool, { action: 'read', id: 'sd15-basic' }))
  assert(afterPatch.workflow.nodes.find((n) => n.title === '正向提示词').widgets.text === 'a red potion, game icon',
    'the patched prompt reads back by name')
  const patchedSamplerRead = afterPatch.workflow.nodes.find((n) => n.type === 'KSampler')
  assert(patchedSamplerRead.widgets.steps === 9 && patchedSamplerRead.widgets.seed === 1234,
    'the patched sampler reads back with no slot drift')
  assert(patchedSamplerRead.widgets.sampler_name === 'dpmpp_2m' && patchedSamplerRead.widgets.denoise === 1,
    'the widgets AFTER the seed kept their values')
  assert(patchedSamplerRead.mode === 0, 'each node reports its mode')

  await rejects(() => exec(workflowTool, { action: 'patch', id: 'sd15-basic', edits: [{ classType: 'KSampler', set: { nope: 1 } }] }),
    /没有这些参数：nope/, 'patching an unknown widget name lists the available names')
  await rejects(() => exec(workflowTool, { action: 'read', id: 'no-such-workflow' }), /工作流库中没有/, 'reading a missing workflow is actionable')
  await rejects(() => exec(workflowTool, { action: 'patch', id: 'sd15-basic' }), /非空的 edits/, 'patch without edits is rejected')
  await rejects(() => exec(workflowTool, { action: 'nope' }), /不支持 action/, 'an unknown action is rejected')

  // Run it: the fake ComfyUI answers with a PNG that must land as a real asset.
  const runResult = unwrap(await exec(workflowTool, { action: 'run', id: 'sd15-basic', category: 'item', project_id: 'testproj' }))
  assert(runResult.images.length === 1, 'action=run produced one image')
  const wfImage = runResult.images[0]
  assert(wfImage.backend === 'comfyui', 'the workflow ran on ComfyUI')
  assert(wfImage.filePath.includes(join('assets', 'generated', 'item')), 'the workflow output lands in assets/generated/item')
  assert(typeof wfImage.resPath === 'string' && wfImage.resPath.startsWith('res://'), 'the workflow output has a res:// path')
  assert(existsSync(wfImage.filePath), 'the workflow output exists on disk')

  const createdWf = unwrap(await exec(workflowTool, { action: 'create', name: 'my workflow', from: 'item-icon', category: 'item' }))
  assert(createdWf.workflow.id === 'my-workflow', `action=create slugs the id (${createdWf.workflow.id})`)
  assert(createdWf.workflow.nodeCount === 7 && createdWf.workflow.linkCount === 9, 'action=create copies the source template')
  const toApi = unwrap(await exec(workflowTool, { action: 'to-api', id: 'my-workflow' }))
  assert(Object.values(toApi.graph).some((n) => n.class_type === 'KSampler'),
    'action=to-api converts the canvas graph into an executable API graph')
  const toUi = unwrap(await exec(workflowTool, { action: 'to-ui', id: 'sd15-basic' }))
  assert(Array.isArray(toUi.graph.nodes) && toUi.graph.nodes.length === 7, 'action=to-ui returns a canvas graph')
  assert(/已删除/.test(unwrap(await exec(workflowTool, { action: 'delete', id: 'my-workflow' })).note), 'action=delete removes it')
  await rejects(() => exec(workflowTool, { action: 'read', id: 'my-workflow' }), /工作流库中没有/, 'the deleted workflow is gone')

  // ── T18: image_workshop — driving the panel from the conversation ──
  const workshopTool = byName(registered, 'image_workshop')
  const status0 = unwrap(await exec(workshopTool, { action: 'status' }))
  assert(status0.delivered === false && status0.queued === 0, 'with no panel connected, status is offline and the queue is empty')
  assert(/从未上报过/.test(status0.note), 'status says the panel has never polled')
  const noState = unwrap(await exec(workshopTool, { action: 'read-state' }))
  assert(noState.delivered === false && /尚未打开/.test(noState.note), 'read-state says the panel never reported')

  const filled = unwrap(await exec(workshopTool, { action: 'fill-form', prompt: 'a blue slime', width: 512, steps: 12, transparent: true }))
  assert(filled.queued === 1 && filled.delivered === false, 'fill-form queues the instruction and reports the panel offline')
  assert(/面板未连接/.test(filled.note), 'and says it is queued rather than applied')
  assert(unwrap(await exec(workshopTool, { action: 'status' })).queued === 1, 'the queue depth reflects the pending instruction')
  const openedOffline = unwrap(await exec(workflowTool, { action: 'open', id: 'sd15-basic' }))
  assert(openedOffline.delivered === false && /指令已排队/.test(openedOffline.note), 'action=open queues the load instruction while offline')
  await rejects(() => exec(workshopTool, { action: 'fill-form' }), /至少要给出一个要填的字段/, 'fill-form with no fields is rejected')
  await rejects(() => exec(workshopTool, { action: 'toast' }), /text must be a non-empty string/, 'toast without text is rejected')

  // ── R-ui: the panel's single poll round-trip (state up, instructions down) ──
  const poll1 = await callRoute(webServer, 'POST', '/gig/ui/poll', { state: { section: 'form', form: { prompt: 'draft in progress', steps: 12 } } })
  assert(poll1.status === 200 && Array.isArray(poll1.body.commands), 'POST /gig/ui/poll returns a command array')
  assert(poll1.body.commands.length === 2, `both queued instructions are delivered (${poll1.body.commands.length})`)
  const kinds = poll1.body.commands.map((c) => c.kind).sort()
  assert(kinds[0] === 'form.fill' && kinds[1] === 'workflow.load', `the instruction kinds are preserved (${kinds.join(', ')})`)
  const fillCommand = poll1.body.commands.find((c) => c.kind === 'form.fill')
  assert(fillCommand.payload.form.prompt === 'a blue slime' && fillCommand.payload.form.width === 512,
    'the instruction carries the payload verbatim')
  assert(typeof fillCommand.label === 'string' && fillCommand.label !== '', 'each instruction carries a human-readable label')
  assert(poll1.body.status.online === true, 'the poll marks the panel as online')

  const stateNow = unwrap(await exec(workshopTool, { action: 'read-state' }))
  assert(stateNow.delivered === true && stateNow.state.formDescription.includes('draft in progress'),
    'read-state returns what the user is editing, including the unsaved draft')
  assert(stateNow.state.section === 'form', 'and which section they are looking at')

  const acked = await callRoute(webServer, 'POST', '/gig/ui/poll', {
    ack: poll1.body.commands.map((c) => c.id),
    state: { section: 'form', form: { prompt: 'draft in progress' } },
  })
  assert(acked.body.commands.length === 0, 'acknowledging instructions clears them from the queue')
  const status2 = unwrap(await exec(workshopTool, { action: 'status' }))
  assert(status2.queued === 0 && status2.delivered === true, 'the queue is empty and the panel is online')

  const openedOnline = unwrap(await exec(workflowTool, { action: 'open', id: 'item-icon' }))
  assert(openedOnline.delivered === true && /已让面板载入/.test(openedOnline.note), 'once a panel polls, action=open delivers immediately')
  // The embedded ComfyUI canvas is a SEPARATE channel: without the bridge
  // extension the graph must not be queued for it silently, or it would pop up
  // on the user's canvas minutes later out of context.
  assert(openedOnline.canvas === false && /桥接扩展未安装/.test(openedOnline.canvasDetail), 'and open says the canvas was not reached, because the bridge is not installed')
  const poll2 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  assert(poll2.body.commands.length === 1 && poll2.body.commands[0].kind === 'workflow.load', 'the workflow.load instruction reaches the panel')
  assert(poll2.body.commands[0].payload.graph.nodes.length === 7, 'the instruction carries the whole graph for the canvas')
  await callRoute(webServer, 'POST', '/gig/ui/poll', { ack: [poll2.body.commands[0].id] })

  // A patch while the panel is open must push the edit so the user SEES it.
  const livePatch = unwrap(await exec(workflowTool, { action: 'patch', id: 'item-icon', edits: [{ classType: 'KSampler', set: { steps: 5 } }] }))
  assert(livePatch.applied.length === 1 && livePatch.note === undefined, 'patching while the panel is open needs no offline warning')
  const poll3 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  assert(poll3.body.commands.some((c) => c.kind === 'workflow.patch'), 'a live patch is pushed to the canvas')
  await callRoute(webServer, 'POST', '/gig/ui/poll', { ack: poll3.body.commands.map((c) => c.id) })

  const queueRoute = await callRoute(webServer, 'GET', '/gig/ui/queue')
  assert(queueRoute.status === 200 && Array.isArray(queueRoute.body.commands), 'GET /gig/ui/queue exposes the queue for diagnostics')

  // ── R-workflows: the panel reading and saving the library ──
  const wfRoute = await callRoute(webServer, 'GET', '/gig/workflows')
  assert(wfRoute.status === 200 && wfRoute.body.workflows.length >= 5, 'GET /gig/workflows lists the library')
  assert(typeof wfRoute.body.root === 'string' && wfRoute.body.root.includes('workflows'), 'and reports where the library lives')
  const oneWf = await callRoute(webServer, 'GET', '/gig/workflow?id=sd15-basic')
  assert(oneWf.status === 200 && Array.isArray(oneWf.body.graph.nodes), 'GET /gig/workflow returns the full canvas document')
  assert(oneWf.body.meta.name.includes('SD1.5'), 'and its metadata')
  const savedWf = await callRoute(webServer, 'POST', '/gig/workflow/save', {
    id: 'sd15-basic',
    graph: oneWf.body.graph,
    name: '用户改过的 SD1.5',
  })
  assert(savedWf.status === 200 && savedWf.body.nodeCount === 7, 'POST /gig/workflow/save stores canvas edits')
  const reread = await callRoute(webServer, 'GET', '/gig/workflow?id=sd15-basic')
  assert(reread.body.meta.name === '用户改过的 SD1.5' && reread.body.meta.source === 'canvas',
    'the saved name persists and the source is recorded as the canvas')
  const missingWf = await callRoute(webServer, 'GET', '/gig/workflow?id=does-not-exist')
  assert(missingWf.status === 400, 'reading a missing workflow over REST is a 400')

  // The canvas runs a library workflow through its own route.
  const runRoute = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'sd15-basic', category: 'item', projectId: 'testproj' })
  assert(runRoute.status === 200 && typeof runRoute.body.jobId === 'string', 'POST /gig/workflow/run starts a job')
  assert(runRoute.body.nodeCount === 7, 'and reports how many nodes it is about to execute')
  await new Promise((r) => setTimeout(r, 1200))
  const canvasRunJob = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === runRoute.body.jobId)
  assert(canvasRunJob !== undefined && canvasRunJob.status === 'done',
    `the canvas workflow run completes (status=${canvasRunJob && canvasRunJob.status} msg=${canvasRunJob && canvasRunJob.message})`)
  assert(canvasRunJob.images.length === 1 && typeof canvasRunJob.images[0].resPath === 'string',
    'and its output is filed as a normal asset with a res:// path')
  const badRun = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'does-not-exist' })
  assert(badRun.status === 400, 'running a missing workflow over REST is a 400')

  // ── ComfyUI step progress over the WebSocket ──
  //
  // The REST API has no step counter, so before this the job said nothing but
  // "ComfyUI 执行中（Ns）" for the whole render — which is how a 13-minute SDXL run
  // looked frozen to the user. ComfyUI's own UI reads these frames from /ws.
  {
    const realWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket
    fakeComfyHoldPolls = 3
    const socketsBefore = fakeSockets.length
    const started = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'sd15-basic', category: 'concept', projectId: 'progress' })
    await new Promise((r) => setTimeout(r, 400))
    const socket = fakeSockets[socketsBefore]
    assert(socket !== undefined, 'a ComfyUI run opens a progress socket')
    assert(/\/ws\?clientId=/.test(socket.url), `keyed by the client id it sent with /prompt (${socket.url})`)

    const jobMessage = async () => {
      const jobs = await callRoute(webServer, 'GET', '/gig/jobs')
      const job = jobs.body.jobs.find((j) => j.id === started.body.jobId)
      return job === undefined ? undefined : { message: job.message, progress: job.progress }
    }

    socket.emit({ type: 'execution_start', data: { prompt_id: 'p' } })
    socket.emit({ type: 'executing', data: { node: '4' } })
    const executing = await jobMessage()
    assert(executing !== undefined && /执行节点 1\/7/.test(executing.message),
      `an executing frame becomes a node counter the user can watch (${executing && executing.message})`)

    socket.emit({ type: 'progress', data: { value: 3, max: 12 } })
    const sampling = await jobMessage()
    assert(sampling !== undefined && /采样 3\/12/.test(sampling.message), `a progress frame becomes a step counter (${sampling && sampling.message})`)
    assert(sampling !== undefined && sampling.progress === 0.25, `and a real 0..1 ratio for the progress bar (${sampling && sampling.progress})`)
    assert(sampling !== undefined && /剩余约 \d+s/.test(sampling.message), 'with our own remaining-time estimate')

    socket.emit({ type: 'progress', data: { value: 6, max: 12 } })
    const later = await jobMessage()
    assert(later !== undefined && /采样 6\/12/.test(later.message), 'and it keeps up as the render advances')

    // Frames the plugin does not understand (or cannot parse) must be ignored, not
    // thrown: a progress socket must never be able to break a render.
    socket.emit({ type: 'progress', data: { value: 'nan', max: 12 } })
    socket.emit({ type: 'progress', data: {} })
    socket.emitRaw('this is not json')
    socket.emit({ type: 'unknown-frame', data: {} })
    const stillFine = await jobMessage()
    assert(stillFine !== undefined && /采样 6\/12/.test(stillFine.message), 'junk frames change nothing and break nothing')

    // Let the held run finish, then check the socket is closed with it.
    const deadline = Date.now() + 15_000
    let finished = null
    while (Date.now() < deadline) {
      const jobs = await callRoute(webServer, 'GET', '/gig/jobs')
      finished = jobs.body.jobs.find((j) => j.id === started.body.jobId)
      if (finished !== undefined && finished.status !== 'running') break
      await new Promise((r) => setTimeout(r, 300))
    }
    assert(finished !== null && finished.status === 'done', `the run still completes normally (${finished && finished.status})`)
    assert(socket.closed === true, 'and the progress socket is closed when the run ends, so nothing leaks')
    globalThis.WebSocket = realWebSocket
    fakeComfyHoldPolls = 0
  }

  // ── the canvas follows the run that is actually happening ──
  //
  // The user's report: "画布里面仍然是一开始的工作流…我能看到你在进行画画，但是我看不到
  // 具体运行的工作流". Only `image_workflow open/patch` ever pushed a graph, so every
  // generation — including the library `run` they watched — left the canvas on the
  // template they had opened. And what runs is NOT the library graph: prompt, seed
  // and size are resolved at call time, so the canvas has to be given the compiled
  // API graph. This block drives the real submit path against a held run and reads
  // the envelope the panel would relay.
  {
    const realWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket
    // A ComfyUI install of its own, so the bridge can be installed for real
    // without ever touching the user's own install.
    const bridgeComfy = join(workRoot, 'bridge-comfy')
    await mkdir(join(bridgeComfy, 'ComfyUI', 'custom_nodes'), { recursive: true })
    const canvasCfg = Object.assign({}, config, {
      unitName: 'godot_imagegen_test_canvas',
      dataRoot: join(workRoot, 'data-canvas'),
      comfyRoot: bridgeComfy,
    })
    const canvasServer = makeWebServer()
    const canvasCtx = makeCtx(storage, { webServer: canvasServer })
    plugin.apply(canvasCtx.ctx, canvasCfg)
    const canvasWorkshop = byName(canvasCtx.registered, 'image_workshop')
    const canvasGenerate = byName(canvasCtx.registered, 'image_generate')
    const installResult = unwrap(await exec(canvasWorkshop, { action: 'install-bridge', origin: 'http://127.0.0.1:43120' }))
    assert(installResult.bridge.installed === true, 'the bridge installs into a ComfyUI of the test\'s own')

    const canvasPoll = () => callRoute(canvasServer, 'POST', '/gig/ui/poll', {})
    const promptBodies = () => comfyRequests.filter((r) => r.method === 'POST' && r.url === '/prompt')

    fakeComfyHoldPolls = 6
    const socketsBefore = fakeSockets.length
    const running = exec(canvasGenerate, { prompt: 'canvas follow probe', category: 'concept', backend: 'comfyui', project_id: 'canvasrun' })
    await new Promise((r) => setTimeout(r, 600))

    const midPoll = await canvasPoll()
    const load = (midPoll.body.canvasMessages || []).find((m) => m.type === 'canvas.load')
    assert(load !== undefined && load.running === true, 'a ComfyUI run puts its graph on the canvas queue while it runs')
    const submitted = JSON.parse(promptBodies().pop().raw)
    const submittedIds = Object.keys(submitted.prompt).map(Number).sort((a, b) => a - b)
    const pushedIds = (load.graph.nodes || []).map((node) => node.id).sort((a, b) => a - b)
    assert(pushedIds.length === submittedIds.length && pushedIds.join(',') === submittedIds.join(','),
      `and it is the graph that was REALLY submitted, node for node (${pushedIds.join(',')})`)
    assert(Array.isArray(load.graph.links) && load.graph.links.length > 0, 'with its links, so the canvas can draw it')
    assert(typeof load.name === 'string' && load.name.length > 0 && load.label === `运行 · ${load.name}`,
      `named after the run so the user can tell it apart (${load.label})`)
    assert(midPoll.body.canvasPing.run !== undefined && midPoll.body.canvasPing.run.label === load.name,
      'and the heartbeat carries the run while it is in flight')
    assert(midPoll.body.canvasPing.run.nodes === submittedIds.length,
      'with the node count of that same graph')

    const socket = fakeSockets[socketsBefore]
    assert(socket !== undefined, 'the run still opens its progress socket')
    const nodeId = Object.keys(submitted.prompt)[2]
    socket.emit({ type: 'executing', data: { node: nodeId } })
    socket.emit({ type: 'progress', data: { value: 2, max: 8 } })
    await new Promise((r) => setTimeout(r, 200))
    const stepPoll = await canvasPoll()
    assert(stepPoll.body.canvasPing.run.nodeId === nodeId,
      'the running node id reaches the canvas (the same id the pushed graph uses, so it can be highlighted)')
    assert(stepPoll.body.canvasPing.run.value === 2 && stepPoll.body.canvasPing.run.max === 8,
      'and so does the step counter')

    await running
    fakeComfyHoldPolls = 0
    const donePoll = await canvasPoll()
    assert(donePoll.body.canvasPing.run === undefined, 'once the run ends the heartbeat stops claiming one')
    assert((donePoll.body.canvasMessages || []).some((m) => m.type === 'canvas.load'),
      'while the graph itself stays on the canvas, ready to be looked at after the fact')

    // SD WebUI has no graph to show: an SD run must not overwrite the canvas with
    // a ComfyUI graph it never ran.
    const queuedBefore = (await canvasPoll()).body.canvasMessages.length
    await exec(canvasGenerate, { prompt: 'sd should not touch the canvas', category: 'concept', project_id: 'sdrun' })
    const afterSd = await canvasPoll()
    assert(afterSd.body.canvasMessages.length === queuedBefore, 'an SD WebUI run queues nothing for the ComfyUI canvas')
    assert(afterSd.body.canvasPing.run === undefined, 'and reports no canvas run either')

    // A library run carries its own UI document, so the canvas gets the user's own
    // layout and widget values rather than a same-shaped reconstruction.
    await callRoute(canvasServer, 'GET', '/gig/workflows')
    const stored = await callRoute(canvasServer, 'GET', '/gig/workflow?id=item-icon')
    assert(stored.status === 200 && Array.isArray(stored.body.graph.nodes), 'the item-icon workflow is in the library')
    await callRoute(canvasServer, 'POST', '/gig/workflow/run', { id: 'item-icon', category: 'item', projectId: 'canvaslib' })
    await new Promise((r) => setTimeout(r, 500))
    const libLoads = ((await canvasPoll()).body.canvasMessages || []).filter((m) => m.type === 'canvas.load')
    const libLoad = libLoads[libLoads.length - 1]
    const placed = (graph) => JSON.stringify((graph.nodes || []).map((node) => [node.id, node.pos]))
    assert(placed(libLoad.graph) === placed(stored.body.graph),
      'a library run puts that very document on the canvas — same ids AND same hand-placed layout')

    globalThis.WebSocket = realWebSocket
  }

  // ── the VRAM advisory ──
  //
  // The measured cliff on an 8 GB card: SDXL at 0.88 MP took 80s for 10 steps, and
  // at 1.01 MP did not finish in 13 minutes. Waiting 13 minutes to discover that is
  // the failure mode, so the warning has to arrive BEFORE the run and be visible
  // while it runs.
  {
    const big = await exec(workflowTool, { action: 'run', id: 'sdxl-basic', category: 'character', project_id: 'vram' })
    assert(big.images.length === 1 && big.images[0].resPath !== undefined, 'an SDXL workflow still runs')
    assert(/8GB 显存/.test(big.note), `and the result carries the VRAM warning (${String(big.note).split('\n').pop()})`)
    assert(/1\.01MP/.test(big.note) && /换页/.test(big.note), 'naming the exact canvas size and what happens to it')
    assert(/降到 ≤0\.9MP/.test(big.note), 'and what to do about it')

    // The panel-side path: the warning must be in the job while it runs. The run is
    // held open for a few polls because the point is what the panel shows DURING a
    // render (an instant fake would finish before the warning could be read).
    fakeComfyHoldPolls = 4
    const started = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'sdxl-basic', category: 'character', projectId: 'vram' })
    let liveJob
    const warnedBy = Date.now() + 900
    while (Date.now() < warnedBy) {
      liveJob = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === started.body.jobId)
      if (liveJob !== undefined && /8GB 显存/.test(liveJob.message)) break
      await new Promise((r) => setTimeout(r, 40))
    }
    assert(liveJob !== undefined && /8GB 显存/.test(String(liveJob.advisory)),
      'the panel gets the advisory as its OWN field, so it survives the progress updates that overwrite the message')
    assert(liveJob !== undefined && !/8GB 显存/.test(liveJob.message),
      `while the message carries the live progress (${liveJob && liveJob.message.slice(0, 30)}…)`)
    const deadline2 = Date.now() + 15_000
    while (Date.now() < deadline2) {
      const j = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((x) => x.id === started.body.jobId)
      if (j !== undefined && j.status !== 'running') break
      await new Promise((r) => setTimeout(r, 300))
    }

    // The control: an SD1.5 workflow at 512² must stay quiet, or the warning is noise.
    const small = await exec(workflowTool, { action: 'run', id: 'sd15-basic', category: 'concept', project_id: 'vram' })
    assert(small.images.length === 1, 'an SD1.5 workflow runs')
    assert(!/显存/.test(small.note), `and gets no VRAM warning at all (${String(small.note).split('\n').pop()})`)
    const smallStarted = await callRoute(webServer, 'POST', '/gig/workflow/run', { id: 'sd15-basic', category: 'concept', projectId: 'vram' })
    const smallJob = (await callRoute(webServer, 'GET', '/gig/jobs')).body.jobs.find((j) => j.id === smallStarted.body.jobId)
    assert(smallJob !== undefined && !/显存/.test(smallJob.message), 'nor in its job message')
    assert(smallJob !== undefined && !/显存/.test(String(smallJob.advisory)), 'and its advisory (if any) is not about VRAM')
    fakeComfyHoldPolls = 0
    await new Promise((r) => setTimeout(r, 600))
  }

  // ── the checkpoint advisory ──
  //
  // A stored workflow carries a literal `ckpt_name` inside its
  // CheckpointLoaderSimple, and nothing used to compare that literal against
  // what this ComfyUI has. So a template pinned to an absent model was submitted
  // anyway and came back as ComfyUI's own validation error AFTER the run had
  // started. `image_generate` has always resolved its checkpoint from the
  // installed list (explicit-but-absent is refused, a stale default falls back to
  // the first installed model); this brings the workflow path to the same place.
  //
  // The fake's `/object_info/CheckpointLoaderSimple` deliberately advertises ONE
  // checkpoint (`anything-v5.safetensors`) so that default-checkpoint resolution
  // stays deterministic — which happens to let two real templates exercise both
  // branches: sd15-basic pins the one that is there, sdxl-basic the one that is
  // not. On the author's own machine it is the other way round, and the paired
  // NOTE in test-workflow-library covers that direction.
  {
    const installed = await exec(workflowTool, { action: 'run', id: 'sd15-basic', category: 'concept', project_id: 'ckpt' })
    assert(!/不在本机 ComfyUI 里/.test(String(installed.note)),
      `a template whose checkpoint IS installed gets no checkpoint warning (${String(installed.note).split('\n').pop()})`)

    const absent = await exec(workflowTool, { action: 'run', id: 'sdxl-basic', category: 'character', project_id: 'ckpt' })
    assert(absent.images.length === 1, 'the run still happens — this warns, it does not refuse')
    assert(/不在本机 ComfyUI 里/.test(String(absent.note)) && /waiIllustriousSDXL_v150\.safetensors/.test(String(absent.note)),
      'a template pinned to a checkpoint this install lacks says WHICH one, before the run')
    assert(/anything-v5\.safetensors/.test(String(absent.note)),
      'and names what is installed instead, so the fix is in the message')
  }

  // ── the empty-prompt advisory ──
  //
  // sd15-basic / sdxl-basic / img2img-refine ship a deliberate prompt SKELETON
  // ("masterpiece, best quality, ") that callers are expected to patch. Running one
  // unmodified renders whatever the model feels like, which reads as "the plugin
  // made nonsense" — measured: an unfilled item-icon prompt produced an unlabelled
  // purple ring instead of the potion its description promised. item-icon now names
  // a default subject, so the two make a clean pair.
  {
    // A self-contained probe: the suite itself patches sd15-basic's prompt early
    // on, so the skeleton has to be reproduced rather than borrowed.
    const probe = await exec(workflowTool, { action: 'create', name: '空提示词探针', from: 'sd15-basic', category: 'concept' })
    await exec(workflowTool, {
      action: 'patch',
      id: probe.workflow.id,
      edits: [{ classType: 'CLIPTextEncode', title: '正向提示词', set: { text: 'masterpiece, best quality, ' } }],
    })
    const empty = await exec(workflowTool, { action: 'run', id: probe.workflow.id, category: 'concept', project_id: 'prompt' })
    assert(empty.images.length === 1, 'a skeleton-prompt workflow still runs')
    assert(/没有主体/.test(empty.note), `and says the prompt has no subject (${String(empty.note).split('\n').pop()})`)
    assert(/action="patch"/.test(empty.note), 'pointing at the tool action that fills it in')
    await exec(workflowTool, { action: 'delete', id: probe.workflow.id })

    const filled = await exec(workflowTool, { action: 'run', id: 'item-icon', category: 'item', project_id: 'prompt' })
    assert(filled.images.length === 1, 'the icon template runs')
    assert(!/没有主体/.test(filled.note), `and is NOT flagged, because it now names a default subject (${String(filled.note).split('\n').pop()})`)

    const icon = (await exec(workflowTool, { action: 'read', id: 'item-icon' })).workflow
    const positive = icon.nodes.find((n) => n.title === '正向提示词')
    assert(/potion bottle/.test(JSON.stringify(positive.widgets)),
      `the item-icon template names a subject in its prompt (${JSON.stringify(positive.widgets).slice(0, 70)}…)`)
    const iconMeta = await callRoute(webServer, 'GET', '/gig/workflows')
    const iconEntry = iconMeta.body.workflows.find((w) => w.id === 'item-icon')
    assert(iconEntry !== undefined && /potion bottle/.test(iconEntry.description),
      'and its description says which part to replace')
  }

  // ── P1: persistence across a plugin restart ──
  assert(disposers.length >= 2, 'the plugin registers disposers for its jobs and storage unit')
  for (const dispose of disposers) dispose()
  await rejects(
    () => exec(byName(registered, 'image_gallery'), { action: 'list' }),
    /was disposed/,
    'a stale operation after dispose cannot re-open the storage unit',
  )
  // The KV unit closes asynchronously; give the fiber cleanup a tick before
  // re-applying, exactly like a hot patch reload would.
  await new Promise((r) => setTimeout(r, 100))
  const second = makeCtx(storage, { webServer: makeWebServer() })
  plugin.apply(second.ctx, config)
  const reloadedGallery = unwrap(await exec(byName(second.registered, 'image_gallery'), { action: 'list', project_id: 'testproj' }))
  assert(reloadedGallery.images.length >= 5, 'gallery survives a plugin restart (storage persisted)')
  const reloadedStatus = unwrap(await exec(byName(second.registered, 'image_backend_status'), {}))
  assert(reloadedStatus.backends.find((b) => b.id === 'sdwebui').running === true, 're-applied plugin re-detects the backend')

  // ── T15: a timed-out request interrupts the backend ──
  // Diffusion servers keep sampling after the client disconnects, so a timeout
  // MUST proactively stop the job: otherwise it holds the GPU for its full run
  // and every later request queues behind it (observed in the live SDXL run,
  // where an abandoned job blocked the queue for ~25 minutes).
  for (const dispose of second.disposers) dispose()
  await new Promise((r) => setTimeout(r, 100))
  const HANG_PORT = 17862
  const hangRequests = []
  const hangServer = await startFakeA1111Hanging(HANG_PORT, hangRequests)
  try {
    const hangCtx = makeCtx(storage, { webServer: makeWebServer() })
    plugin.apply(hangCtx.ctx, Object.assign({}, config, { sdwebuiPort: HANG_PORT, requestTimeoutMs: 1500 }))
    const hangGenerate = byName(hangCtx.registered, 'image_generate')
    let failed = false
    try {
      await exec(hangGenerate, { prompt: 'hang test', category: 'item', name: 'hang', transparent: false })
    } catch {
      failed = true
    }
    assert(failed, 'a backend that never answers fails the call instead of hanging forever')
    assert(hangRequests.some((r) => r.url === '/sdapi/v1/interrupt'),
      'a timed-out request tells the backend to interrupt (no orphaned GPU job)')

    // ── T16: explicit vs auto upscale semantics ──
    // This backend answers but reports no upscalers, so the SD WebUI path fails.
    const upscaleTool = byName(hangCtx.registered, 'image_upscale')
    await rejects(
      () => exec(upscaleTool, { image: first.filePath, method: 'esrgan', category: 'item', name: 'up-explicit' }),
      /放大失败|没有可用的放大模型/,
      'an explicit esrgan request fails loudly instead of silently degrading',
    )
    const autoUp = await exec(upscaleTool, { image: first.filePath, method: 'auto', scale: 2, category: 'item', name: 'up-auto' })
    assert(autoUp.image.method === 'lanczos', 'auto upscale falls back to Lanczos when the backend cannot upscale')
    assert(typeof autoUp.note === 'string' && autoUp.note.includes('Lanczos'),
      'auto upscale surfaces the fallback reason in its note (never hides the quality loss)')

    for (const dispose of hangCtx.disposers) dispose()
  } finally {
    hangServer.closeAllConnections()
    await new Promise((resolve) => hangServer.close(resolve))
  }

  // ── 记录里的三件事：去重、尺寸、耗时 ──
  //
  // 用户看到的是"一次运行落两张图""尺寸显示 ?×?""跑完不知道花了多久"。
  // 三件都在这里钉住。
  {
    // 尺寸：纯函数先单独验，不依赖后端。
    const pngHeader = (w, h) => {
      const header = Buffer.alloc(24)
      header.writeUInt32BE(0x89504e47, 0)
      header.writeUInt32BE(0x0d0a1a0a, 4)
      header.writeUInt32BE(13, 8)
      header.write('IHDR', 12, 'latin1')
      header.writeUInt32BE(w, 16)
      header.writeUInt32BE(h, 20)
      return header
    }
    assert(plugin.pngDimensions(pngHeader(1024, 1024))?.width === 1024, 'PNG 尺寸能从 IHDR 读出来（工作流出图不再显示 ?×?）')
    assert(plugin.pngDimensions(pngHeader(832, 1216))?.height === 1216, '竖构图也对')
    assert(plugin.pngDimensions(Buffer.from('definitely not a png file')) === undefined, '不是 PNG 就返回 undefined 而不是抛错')
    assert(plugin.pngDimensions(Buffer.alloc(8)) === undefined, '文件太短也返回 undefined')
    assert(plugin.graphSteps({ '5': { class_type: 'KSampler', inputs: { steps: 25 } } }) === 25, '能从 API 图里读出采样步数')
    assert(plugin.graphSteps({ '5': { class_type: 'KSampler', inputs: { seed: 3 } } }) === undefined, '图里没有步数就返回 undefined')

    // Qwen/GGUF 的预检：老那条预警只认 CheckpointLoaderSimple + 大 latent，Qwen 图
    //（UnetLoaderGGUF + 5.88GB 文本编码器 / 7.96GB 显存）从它眼皮下溜过去。
    const qwenParts = [
      { label: '主模型', bytes: 3.90 * 1024 ** 3 },
      { label: '文本编码器', bytes: 5.88 * 1024 ** 3 },
      { label: 'VAE', bytes: 0.63 * 1024 ** 3 },
    ]
    const total = qwenParts.reduce((sum, part) => sum + part.bytes, 0)
    const verdict = plugin.weightAdvisory(total, qwenParts, 7.96 * 1024 ** 3, 2.1 * 1024 ** 3)
    assert(/权重合计 10\.41GB/.test(verdict) && /超过 7\.96GB 显存/.test(verdict),
      `Qwen 那种权重超显存的图会被点名（${String(verdict).slice(0, 40)}…）`)
    assert(/文本编码器 5\.88GB/.test(verdict), '并列出每一项占多少，用户才知道该砍哪个')
    assert(/可用内存只剩 2\.10GB/.test(verdict), '内存装不下时另说一句，因为那是换页、是越跑越慢')
    assert(plugin.weightAdvisory(1 * 1024 ** 3, [{ label: '主模型', bytes: 1024 ** 3 }], 7.96 * 1024 ** 3, 8 * 1024 ** 3) === undefined,
      '装得下就不吵人')
    assert(plugin.weightAdvisory(total, qwenParts, undefined, 32 * 1024 ** 3) === undefined,
      '读不到显卡信息时不瞎猜，只在真的超了内存时才说')

    // ⑥ 启动参数：默认的 ComfyUI 会把上一个模型留在显存里，正是"先跑别的再跑 Qwen 特别慢"
    // 的来源；这三面旗子是插件拉起实例时的固定行为，别再被顺手删掉。
    const launch = plugin.comfyLaunchArgs('D:/aki/python.exe', 8188)
    assert(launch.includes('--cache-none'), '启动 ComfyUI 时不缓存上一个模型（--cache-none）')
    assert(launch.includes('--disable-smart-memory'), '并让它该放就放（--disable-smart-memory）')
    assert(launch.includes('--use-split-cross-attention'), '采样峰值更低（--use-split-cross-attention）')
    assert(launch.join(' ').includes('--port 8188') && launch.includes('127.0.0.1'), '端口与只听本机不变')

    // 去重 + 耗时：让假的 ComfyUI 把同一张图挂在两个输出节点上。用一个自己的实例，
    // 免得跟在别的用例后面被 dispose 掉。
    const dupServer = makeWebServer()
    const dupCtx = makeCtx(storage, { webServer: dupServer })
    plugin.apply(dupCtx.ctx, Object.assign({}, config, {
      unitName: 'godot_imagegen_test_dup',
      dataRoot: join(workRoot, 'data-dup'),
    }))
    const dupWorkflow = byName(dupCtx.registered, 'image_workflow')
    fakeComfyDuplicateOutputs = true
    const dup = unwrap(await exec(dupWorkflow, { action: 'run', id: 'sd15-basic', category: 'concept', project_id: 'dup' }))
    assert(dup.images.length === 1, `同一张图被两个输出节点引用时只产出一张（实际 ${dup.images.length}）`)
    assert(new Set(dup.images.map((i) => i.filePath)).size === dup.images.length, '也不会为同一张图落两个文件')
    fakeComfyDuplicateOutputs = false

    const dupGallery = await callRoute(dupServer, 'GET', '/gig/gallery?project=dup')
    const record = (dupGallery.body.images || [])[0]
    assert(record !== undefined, '这次运行进了图库')
    assert(typeof record.meta?.seconds === 'number' && record.meta.seconds >= 1,
      `记录里带上了整轮耗时（${record && record.meta && record.meta.seconds}s）`)
    assert(record.meta?.steps === 20 || typeof record.meta?.steps === 'number',
      `以及采样步数（${record && record.meta && record.meta.steps}），耗时才有比较意义`)
    assert(record.width > 0 && record.height > 0,
      `并从 PNG 本身补上了尺寸（${record && record.width}×${record && record.height}）`)

    // ② force_layout_refresh 曾经把缓存也一起否掉：那次刷新失败（ComfyUI 正忙着出图，
    // 1700 个节点的 /object_info 超时）之后，patch 直接报"还没有节点定义"，而同样读缓存
    // 的 run 却好好的。force 的意思应该是"再问一次"，不是"不要缓存"。
    const patchServer = makeWebServer()
    const patchCtx = makeCtx(storage, { webServer: patchServer })
    plugin.apply(patchCtx.ctx, Object.assign({}, config, {
      unitName: 'godot_imagegen_test_patch',
      dataRoot: join(workRoot, 'data-patch'),
    }))
    const patchWorkflow = byName(patchCtx.registered, 'image_workflow')
    await exec(patchWorkflow, { action: 'list' })
    const warmed = unwrap(await exec(patchWorkflow, {
      action: 'patch', id: 'item-icon', edits: [{ classType: 'KSampler', set: { steps: 12 } }],
    }))
    assert(warmed.applied.length === 1, '缓存热的时候能按名字改参数')
    fakeComfyObjectInfoFails = true
    const fromCache = unwrap(await exec(patchWorkflow, {
      action: 'patch', id: 'item-icon', force_layout_refresh: true, edits: [{ classType: 'KSampler', set: { steps: 14 } }],
    }))
    assert(fromCache.applied.length === 1,
      '刷新 /object_info 失败时仍用缓存改参数（force = 再问一次，不是不要缓存）')
    fakeComfyObjectInfoFails = false
  }

  // ── summary ──
  await new Promise((resolve) => sdServer.close(resolve))
  await new Promise((resolve) => comfyServer.close(resolve))
  await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)

  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
