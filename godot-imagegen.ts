/**
 * godot-imagegen — local AI art generation for DSH game development.
 *
 * Drives the two local image backends installed on this machine through their
 * HTTP APIs and turns their output into Godot-ready art assets:
 *
 *   - SD WebUI / A1111 (秋叶整合包 v4.10) — the rich backend: 2 checkpoints
 *     (Illustrious SDXL + anything-v5 SD1.5), 16 ControlNet models, 6 upscalers
 *     (RealESRGAN / ESRGAN / SwinIR / AnimeSharp), GFPGAN + CodeFormer,
 *     deepbooru + WD14 taggers and 18 extensions. Default port 7860.
 *   - ComfyUI (秋叶整合包 v2) — graph API on port 8188; only `anything-v5`
 *     is installed, so it serves SD1.5 txt2img/img2img and custom workflows.
 *
 * Post-processing (cutout / classical upscale / format conversion) runs on the
 * embedded Python shipped with the 秋叶 packages, which already carries PIL,
 * numpy, OpenCV, scipy and rembg — so no extra dependency is installed.
 *
 * Registered model tools (all prefixed `image_`):
 *   image_backend_status, image_generate, image_edit, image_variants,
 *   image_upscale, image_cutout, image_interrogate, image_gallery
 *
 * The same operations are exposed to the browser half (`lib/client.js`, the
 * 「美术工坊」better-sidebar panel) over a same-origin `/gig` REST surface, so
 * the panel, the tools and the on-disk files always agree.
 *
 * Persistence uses its OWN KV unit (`godot_imagegen` by default): the
 * `godot_asset_planner` unit allows exactly one live handle per backend and is
 * owned by the godot-asset-planner plugin, so this plugin never touches it.
 *
 * Runtime imports are limited to Node builtins, so the file loads directly
 * under Node's type stripping (no bundling, no tsx hook).
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'godot-imagegen'

/** Services required by this plugin. */
export const inject = ['tools', 'storage']

// ─────────────────────────────── shared types ───────────────────────────────

/** Which backend an operation runs against. `auto` resolves per operation. */
export type BackendId = 'auto' | 'sdwebui' | 'comfyui'

/** A concrete, resolved backend. */
export type ResolvedBackend = 'sdwebui' | 'comfyui'

/** Art categories; each maps to a subdirectory and a size/prompt convention. */
export type ArtCategory =
  | 'character'
  | 'item'
  | 'ui'
  | 'tile'
  | 'background'
  | 'texture'
  | 'concept'

/** All art categories, in a stable order. */
export const ART_CATEGORIES: ArtCategory[] = [
  'character',
  'item',
  'ui',
  'tile',
  'background',
  'texture',
  'concept',
]

/** Recommended generation defaults per art category. */
export const CATEGORY_DEFAULTS: Record<ArtCategory, {
  width: number
  height: number
  steps: number
  cfgScale: number
  transparent: boolean
  hint: string
}> = {
  character: { width: 832, height: 1216, steps: 30, cfgScale: 7, transparent: true, hint: '角色立绘/精灵图，竖构图，透明背景' },
  item: { width: 1024, height: 1024, steps: 28, cfgScale: 7, transparent: true, hint: '道具/技能/状态图标，方形，透明背景' },
  ui: { width: 1024, height: 1024, steps: 26, cfgScale: 6, transparent: true, hint: 'UI 按钮/边框/九宫格，注意安全区' },
  tile: { width: 768, height: 768, steps: 30, cfgScale: 7, transparent: false, hint: '瓦片/地形，必须可无缝平铺' },
  background: { width: 1344, height: 768, steps: 30, cfgScale: 7, transparent: false, hint: '背景/视差层，横构图' },
  texture: { width: 1024, height: 1024, steps: 30, cfgScale: 7, transparent: false, hint: '3D 贴图/PBR 基础色，可平铺' },
  concept: { width: 1024, height: 1024, steps: 28, cfgScale: 7, transparent: false, hint: '概念图/参考图' },
}

/** One generated (or derived) image in the gallery. */
export interface GalleryImage {
  /** Stable id (`img_<uuid>`). */
  id: string
  /** Asset base name chosen by the caller. */
  name: string
  /** Category subfolder the file lives in. */
  category: ArtCategory
  /** How the image came to be. */
  op: 'generate' | 'variants' | 'edit' | 'upscale' | 'cutout'
  /** Absolute path on disk. */
  filePath: string
  /** `res://` path when the file lives inside a Godot project. */
  resPath?: string
  /** Byte size on disk. */
  size?: number
  /** The prompt that produced it (verbatim). */
  prompt?: string
  negativePrompt?: string
  seed?: number
  model?: string
  backend?: ResolvedBackend
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  sampler?: string
  /** Source image ids for derived operations (edit/upscale/cutout). */
  sourceIds?: string[]
  /** Cutout/upscale method actually used, when relevant. */
  method?: string
  /** Planner project this image belongs to. */
  projectId?: string
  /** Free-form extra facts (controlnet module, upscaler name, rembg matte…). */
  meta?: Record<string, string | number | boolean>
  /** ISO-8601 creation timestamp. */
  createdAt: string
}

/** A long-running backend operation tracked for the UI. */
interface Job {
  id: string
  kind: 'generate' | 'edit' | 'upscale' | 'cutout' | 'interrogate' | 'start'
  label: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** 0..1 when the backend reports it, otherwise undefined. */
  progress?: number
  /** Human-readable progress text or the error message. */
  message: string
  /** Live preview as a base64 PNG, when the backend provides one. */
  preview?: string
  images: GalleryImage[]
  error?: string
  startedAt: string
  finishedAt?: string
  controller: AbortController
}

// ─────────────────────────────── config ───────────────────────────────

/** Everything the plugin can be configured with; every field has a default. */
export interface ImagegenConfig {
  /** Gallery KV unit name. */
  unitName: string
  /** Root of the 秋叶 SD WebUI install (parent of `launch.py`). */
  sdwebuiRoot: string
  /** Python interpreter used to launch SD WebUI. */
  sdwebuiPython: string
  /** SD WebUI API port. */
  sdwebuiPort: number
  /** Root of the 秋叶 ComfyUI install. */
  comfyRoot: string
  /** Python interpreter used to launch ComfyUI. */
  comfyPython: string
  /** ComfyUI API port. */
  comfyPort: number
  /** Python used for post-processing; defaults to the ComfyUI interpreter. */
  postPython: string
  /** Backend chosen when a call says `auto`. */
  defaultBackend: ResolvedBackend
  /** Godot project root; generated art lands under `<root>/assets/generated`. */
  godotProject?: string
  /** Explicit output root; wins over `godotProject` when set. */
  outDir?: string
  /** Default checkpoint per backend (filename). */
  sdwebuiModel?: string
  comfyModel?: string
  /** How long a tool waits for one backend operation. */
  requestTimeoutMs: number
  /** How long `start` waits for a backend to answer. */
  startTimeoutMs: number
}

const DEFAULT_SDWEBUI_ROOT = 'D:/AKI open/sd-webui-aki-v4.10/sd-webui-aki-v4.10'
const DEFAULT_COMFY_ROOT = 'D:/AKI open/ComfyUI-aki-v2'
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Resolve the effective configuration from the raw plugin config object. */
function resolveConfig(config: unknown): ImagegenConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const str = (key: string, fallback: string): string => {
    const value = raw[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\\/g, '/') : fallback
  }
  const num = (key: string, fallback: number): number => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  }
  const sdwebuiRoot = str('sdwebuiRoot', DEFAULT_SDWEBUI_ROOT)
  const comfyRoot = str('comfyRoot', DEFAULT_COMFY_ROOT)
  const comfyPython = str('comfyPython', `${comfyRoot}/python/python.exe`)
  const postPython = str('postPython', comfyPython)
  const backend = raw.defaultBackend
  const unitName = str('unitName', 'godot_imagegen')
  if (!UNIT_NAME_RE.test(unitName)) {
    throw new Error(`godot-imagegen: unitName "${unitName}" must match ${UNIT_NAME_RE}`)
  }
  const godotProject = str('godotProject', '')
  const outDir = str('outDir', '')
  return {
    unitName,
    sdwebuiRoot,
    sdwebuiPython: str('sdwebuiPython', `${sdwebuiRoot}/python/python.exe`),
    sdwebuiPort: num('sdwebuiPort', 7860),
    comfyRoot,
    comfyPython,
    comfyPort: num('comfyPort', 8188),
    postPython,
    defaultBackend: backend === 'comfyui' ? 'comfyui' : 'sdwebui',
    ...(godotProject === '' ? {} : { godotProject }),
    ...(outDir === '' ? {} : { outDir }),
    ...(str('sdwebuiModel', '') === '' ? {} : { sdwebuiModel: str('sdwebuiModel', '') }),
    ...(str('comfyModel', '') === '' ? {} : { comfyModel: str('comfyModel', '') }),
    // 30 minutes: a real SDXL run at 768² on an 8 GB laptop GPU measures
    // ~60-77 s/step, so an 18-step image alone needs ~20 minutes.
    requestTimeoutMs: num('requestTimeoutMs', 30 * 60 * 1000),
    startTimeoutMs: num('startTimeoutMs', 6 * 60 * 1000),
  }
}

// ─────────────────────────── structural service views ───────────────────────────

/** Structural view of the dsh-storage KV unit this plugin uses. */
interface KvUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  setGlobal(value: unknown): Promise<void>
  close(): Promise<void>
}

/** Structural view of the storage surface reached through `ctx.storage`. */
interface StorageSurface {
  backend: {
    get(name: string): {
      kv?: {
        open(descriptor: {
          name: string
          version: number
          tables: readonly string[]
          hasGlobal: boolean
        }): Promise<KvUnit>
      }
    }
  }
}

/** Minimal tool definition shape accepted by `ctx.tools.register`. */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec: { signal: { aborted: boolean } }): Promise<unknown>
}

/** Structural view of the tool registry reached through `ctx.tools`. */
interface ToolsSurface {
  register(definition: ToolDefinition): () => void
}

/** Structural view of `ctx.effect`. */
type EffectFn = (callback: () => unknown, label?: string) => unknown

/**
 * Minimal structural view of the Cordis context this plugin consumes. It is
 * declared locally rather than imported from `@deepseek-ai/cordis` so this file
 * type-checks with zero package resolution (the import would be erased anyway).
 */
interface Context {
  tools: ToolsSurface
  storage: StorageSurface
  effect: EffectFn
  /** Optional service lookup, used to reach the unconfined `subprocess` service. */
  get?(name: string): unknown
  /** Composition-conditional registration (e.g. routes that need `webServer`). */
  inject(deps: string[], callback: (scoped: unknown) => void): unknown
}

/** Structural view of the `webServer` service (dsh-host-webserver). */
interface WebServerSurface {
  register(opts: { kind: 'prefix'; path: string; handler: HttpHandler }, label?: string): () => void
}

type HttpHandler = (req: HttpReq, res: HttpRes) => Promise<void>

interface HttpReq {
  method?: string
  url?: string
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

interface HttpRes {
  writeHead(statusCode: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** Handle returned by the harness `subprocess` service. */
interface SubprocessHandle {
  pid?: number
  done: Promise<unknown>
  collected?: {
    stdout?: { readFrom(offset: number): { text?: string } }
    stderr?: { readFrom(offset: number): { text?: string } }
  }
  kill?(signal?: string): void
  stop?(): void
}

interface SubprocessSurface {
  spawn(opts: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    stdio?: unknown
    graceMs?: number
    signal?: AbortSignal
  }): SubprocessHandle
}

// ─────────────────────────────── small utilities ───────────────────────────────

/** A request error that is the caller's fault (HTTP 400, not 500). */
class ClientRouteError extends Error {}

function requireString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read an optional free-text argument.
 *
 * An empty or whitespace-only value means "not provided" and yields `undefined`
 * — it is NOT an error. A UI text box the user left blank (the negative prompt,
 * a mask, a sampler or model override, the output dir) legitimately posts `""`,
 * and an agent may pass `""` for exactly the same reason. Treating that as a
 * validation failure made the very first generation from the 美术工坊 panel fail
 * with "negativePrompt, when provided, must be a non-empty string".
 *
 * Required text still goes through `requireString`, which keeps rejecting "".
 */
function optionalString(args: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${label}, when provided, must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}, when provided, must be a finite number`)
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
  return value
}

function optionalBoolean(args: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label}, when provided, must be a boolean`)
  return value
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  label: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label}, when provided, must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function requireCategory(args: Record<string, unknown>): ArtCategory {
  const value = optionalEnum(args, 'category', 'category', ART_CATEGORIES)
  return value ?? 'concept'
}

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Round to a multiple the diffusion models are happy with (8 or 64). */
function alignSize(value: number, multiple = 64): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

/** A filesystem-safe slug for asset names. */
function slugify(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? 'image' : cleaned.slice(0, 60)
}

/** `YYYYMMDD-HHmmss` in local time, for filenames. */
function timestampLabel(date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** Decode a base64 payload, tolerating a `data:` URL prefix. */
function decodeBase64Image(value: string): Buffer {
  const comma = value.indexOf(',')
  const payload = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value
  return Buffer.from(payload, 'base64')
}

/** Read a file as a bare base64 string (no `data:` prefix), as A1111 expects. */
async function readBase64(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return bytes.toString('base64')
}

/** True when `child` is inside `parent` (path-aware, case-insensitive on Windows). */
function isInside(parent: string, child: string): boolean {
  const a = resolve(parent).replace(/[\\/]+$/, '').toLowerCase()
  const b = resolve(child).replace(/[\\/]+$/, '').toLowerCase()
  return b === a || b.startsWith(a + sep) || b.startsWith(a + '/')
}

/** A compact, human-readable size. */
function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** `stat` that never throws. */
async function statSafe(path: string): Promise<{ size: number; isFile(): boolean } | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** `existsSync` on a normalized path. */
function fileExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Raw HTTP request built on `node:http`.
 *
 * Global `fetch` is deliberately NOT used for backend calls: undici imposes a
 * 300 s `headersTimeout` / `bodyTimeout` that cannot be raised without the
 * undici package, and a real SDXL generation (7 GB checkpoint swap + sampling)
 * routinely exceeds it — the request then dies with UND_ERR_HEADERS_TIMEOUT
 * even though the backend is still working. Here the only deadline is ours.
 */
function httpRaw(url: string, opts: {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url)
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort)
      fn()
    }
    const req = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: opts.method ?? 'GET',
      ...(opts.headers === undefined ? {} : { headers: opts.headers }),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => finish(() => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })))
      res.on('error', (error: Error) => finish(() => rejectPromise(error)))
    })
    const timer = setTimeout(() => {
      req.destroy()
      finish(() => rejectPromise(new Error(
        `HTTP timeout after ${Math.round(opts.timeoutMs / 1000)}s: ${opts.method ?? 'GET'} ${url}`
        + '（后端仍在出图，是插件的 requestTimeoutMs 到了；可在 profile 的 godot-imagegen config 里调大，或降低 steps/分辨率）',
      )))
    }, opts.timeoutMs)
    function onAbort(): void {
      req.destroy()
      finish(() => rejectPromise(new Error('cancelled')))
    }
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        clearTimeout(timer)
        req.destroy()
        rejectPromise(new Error('cancelled'))
        return
      }
      opts.signal.addEventListener('abort', onAbort)
    }
    req.on('error', (error: Error) => finish(() => rejectPromise(error)))
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/** Fetch JSON with a timeout; throws a readable error on non-2xx. */
async function fetchJson(
  url: string,
  init: { method?: string; body?: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  const response = await httpRaw(url, {
    method: init.method ?? 'GET',
    ...(init.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
    timeoutMs: init.timeoutMs,
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  })
  if (response.status < 200 || response.status >= 300) {
    const detail = response.body.toString('utf8').slice(0, 400)
    throw new Error(`${init.method ?? 'GET'} ${url} → HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
  }
  return JSON.parse(response.body.toString('utf8'))
}

/** `POST` that only needs to know it succeeded (A1111 interrupt etc.). */
async function postJsonVoid(url: string, body: unknown, timeoutMs: number): Promise<void> {
  await fetchJson(url, { method: 'POST', body, timeoutMs })
}

/** Probe a TCP-ish HTTP endpoint with a short timeout. */
async function probeJson(url: string, timeoutMs = 2500): Promise<unknown | undefined> {
  try {
    return await fetchJson(url, { timeoutMs })
  } catch {
    return undefined
  }
}

/** Sleep that honours an abort signal. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal !== undefined && signal.aborted) {
      rejectPromise(new Error('cancelled'))
      return
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      rejectPromise(new Error('cancelled'))
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort)
  })
}

// ─────────────────────────────── process spawning ───────────────────────────────

/** The subset of a spawned child this module needs. */
interface RunningProcess {
  pid?: number
  /** Resolves with the exit code once the process ends. */
  done: Promise<number | undefined>
  /** Read everything written to stdout+stderr so far. */
  output(): string
  kill(): void
}

/**
 * Spawn a child process. The harness `subprocess` service is preferred when it
 * is mounted (its children are unconfined, which matters because the backends
 * write caches under the user profile); `node:child_process` is the fallback.
 */
function makeSpawner(subprocess: SubprocessSurface | undefined) {
  return function spawnProcess(opts: {
    argv: string[]
    cwd: string
    env?: Record<string, string>
    signal?: AbortSignal
  }): RunningProcess {
    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
      const handle = subprocess.spawn({
        argv: opts.argv,
        cwd: opts.cwd,
        ...(opts.env === undefined ? {} : { env: opts.env }),
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 2 * 1024 * 1024 } },
          stderr: { collect: { maxBytes: 2 * 1024 * 1024 } },
        },
        graceMs: 2000,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })
      return {
        ...(handle.pid === undefined ? {} : { pid: handle.pid }),
        done: handle.done.then(
          (value) => (typeof value === 'number' ? value : undefined),
          () => undefined,
        ),
        output(): string {
          let text = ''
          try {
            if (handle.collected?.stdout) text += handle.collected.stdout.readFrom(0).text ?? ''
            if (handle.collected?.stderr) text += handle.collected.stderr.readFrom(0).text ?? ''
          } catch {
            /* offset bookkeeping is best-effort */
          }
          return text
        },
        kill(): void {
          try {
            if (typeof handle.stop === 'function') handle.stop()
            else if (typeof handle.kill === 'function') handle.kill()
          } catch {
            /* already gone */
          }
        },
      }
    }

    const child = nodeSpawn(opts.argv[0], opts.argv.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let text = ''
    const absorb = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      if (text.length > 400_000) text = text.slice(-200_000)
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    const done = new Promise<number | undefined>((resolveDone) => {
      child.on('error', () => resolveDone(undefined))
      child.on('close', (code) => resolveDone(code ?? undefined))
    })
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      done,
      output: () => text,
      kill: () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      },
    }
  }
}

// ─────────────────────────── Python post-processing bridge ───────────────────────────

/**
 * The helper script run by the bundled Python for everything the diffusion
 * backends cannot do themselves: true background removal (rembg/u2net),
 * chroma-key cutout (Pillow), classical resampling, seamless-tile conversion
 * and format conversion. Written to a temp file at first use and removed with
 * the plugin fiber.
 */
const PY_TOOL_SOURCE = String.raw`
import argparse, io, json, os, sys

RESULT_PATH = None

def emit(obj):
    text = json.dumps(obj, ensure_ascii=False)
    if RESULT_PATH:
        try:
            with open(RESULT_PATH, 'w', encoding='utf-8') as handle:
                handle.write(text)
        except Exception:
            pass
    try:
        sys.stdout.write(text + '\n')
        sys.stdout.flush()
    except Exception:
        pass

def main():
    global RESULT_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd')
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', default='')
    ap.add_argument('--result', default='')
    ap.add_argument('--method', default='rembg')
    ap.add_argument('--key', default='#00FF00')
    ap.add_argument('--tolerance', type=float, default=42.0)
    ap.add_argument('--feather', type=float, default=1.2)
    ap.add_argument('--scale', type=float, default=2.0)
    ap.add_argument('--width', type=int, default=0)
    ap.add_argument('--height', type=int, default=0)
    ap.add_argument('--blend', type=int, default=48)
    ap.add_argument('--fmt', default='')
    args = ap.parse_args()
    RESULT_PATH = args.result or None

    try:
        from PIL import Image
    except Exception as exc:
        emit({'ok': False, 'error': 'Pillow unavailable: %s' % exc}); return 1

    try:
        src = Image.open(args.input)
    except Exception as exc:
        emit({'ok': False, 'error': 'cannot open input: %s' % exc}); return 1

    if args.cmd == 'info':
        alpha = None
        if src.mode in ('RGBA', 'LA') or 'transparency' in src.info:
            alpha = 'present'
        emit({'ok': True, 'width': src.width, 'height': src.height,
              'mode': src.mode, 'format': src.format, 'alpha': alpha})
        return 0

    if args.cmd == 'cutout':
        method = args.method
        used = method
        out = None
        if method in ('rembg', 'auto'):
            # rembg / onnxruntime are extremely chatty (and print model-download
            # progress) — silence them so only our JSON marker reaches the caller.
            saved_out, saved_err = sys.stdout, sys.stderr
            sys.stdout = io.StringIO()
            sys.stderr = io.StringIO()
            try:
                from rembg import remove
                data = open(args.input, 'rb').read()
                cut = remove(data)
                out = Image.open(io.BytesIO(cut)).convert('RGBA')
                used = 'rembg'
            except Exception as exc:
                if method == 'rembg':
                    sys.stdout, sys.stderr = saved_out, saved_err
                    emit({'ok': False, 'error': 'rembg failed: %s' % exc, 'fallback': 'chroma'})
                    return 2
                out = None
            finally:
                sys.stdout, sys.stderr = saved_out, saved_err
        if out is None:
            import numpy as np
            key = args.key.strip()
            if key.startswith('#'):
                key = key[1:]
            if len(key) == 3:
                key = ''.join(c * 2 for c in key)
            try:
                kr, kg, kb = int(key[0:2], 16), int(key[2:4], 16), int(key[4:6], 16)
            except Exception:
                kr, kg, kb = 0, 255, 0
            rgba = src.convert('RGBA')
            arr = np.asarray(rgba).astype(np.int32)
            dist = np.sqrt((arr[:, :, 0] - kr) ** 2 + (arr[:, :, 1] - kg) ** 2 + (arr[:, :, 2] - kb) ** 2)
            alpha = np.clip((dist - args.tolerance) / max(1.0, args.tolerance) * 255.0, 0, 255)
            alpha = alpha * (dist > 0)
            rgba.putalpha(Image.fromarray(alpha.astype('uint8'), 'L'))
            if args.feather > 0:
                from PIL import ImageFilter
                softened = rgba.getchannel('A').filter(ImageFilter.GaussianBlur(args.feather))
                rgba.putalpha(softened)
            out = rgba
            used = 'chroma'
        out.save(args.output, 'PNG')
        emit({'ok': True, 'output': args.output, 'method': used, 'width': out.width, 'height': out.height})
        return 0

    if args.cmd == 'upscale':
        w = args.width or int(round(src.width * args.scale))
        h = args.height or int(round(src.height * args.scale))
        out = src.convert('RGBA' if src.mode in ('RGBA', 'LA', 'P') else 'RGB').resize((w, h), Image.LANCZOS)
        out.save(args.output, 'PNG')
        emit({'ok': True, 'output': args.output, 'width': w, 'height': h, 'method': 'lanczos'})
        return 0

    if args.cmd == 'resize':
        w, h = args.width, args.height
        if not w or not h:
            emit({'ok': False, 'error': 'resize needs --width and --height'}); return 1
        out = src.resize((w, h), Image.LANCZOS)
        out.save(args.output, 'PNG')
        emit({'ok': True, 'output': args.output, 'width': w, 'height': h})
        return 0

    if args.cmd == 'tile':
        import numpy as np
        img = src.convert('RGBA')
        arr = np.asarray(img).astype(np.float32)
        oy, ox = img.height // 2, img.width // 2
        rolled = np.roll(np.roll(arr, oy, axis=0), ox, axis=1)
        b = max(2, min(args.blend, img.width // 4, img.height // 4))
        if b >= 2:
            ramp = np.linspace(0.0, 1.0, b, dtype=np.float32)
            ramp = ramp.reshape(-1, 1, 1)
            band = rolled[:b, :, :]
            mirror = rolled[:b, :, :][::-1, :, :]
            rolled[:b, :, :] = band * ramp + mirror * (1.0 - ramp)
            band2 = rolled[:, :b, :]
            mirror2 = rolled[:, :b, :][:, ::-1, :]
            rolled[:, :b, :] = band2 * ramp.reshape(1, -1, 1) + mirror2 * (1.0 - ramp.reshape(1, -1, 1))
        out = Image.fromarray(np.clip(rolled, 0, 255).astype('uint8'), 'RGBA')
        out.save(args.output, 'PNG')
        emit({'ok': True, 'output': args.output, 'width': out.width, 'height': out.height, 'method': 'offset-blend'})
        return 0

    if args.cmd == 'convert':
        fmt = (args.fmt or 'png').upper()
        out = src.convert('RGBA') if fmt == 'PNG' else src.convert('RGB')
        out.save(args.output, fmt)
        emit({'ok': True, 'output': args.output, 'format': fmt})
        return 0

    emit({'ok': False, 'error': 'unknown command %s' % args.cmd})
    return 1

if __name__ == '__main__':
    sys.exit(main())
`

// ─────────────────────────── backend adapters ───────────────────────────

/** What a backend reports about itself. */
interface BackendStatus {
  id: ResolvedBackend
  label: string
  root: string
  port: number
  running: boolean
  /** Detail string for the UI (version / model count / error). */
  detail: string
  models: string[]
  /** Capability flags discovered by probing (raw, for the REST/UI layer). */
  capabilities: Record<string, boolean | number>
  /** Human-readable capability lines, exposed to the model through the tool. */
  strengths: string[]
  /** True when this plugin spawned the process (never kills user instances). */
  managed: boolean
}

/** One image returned by a backend, before it is written to the gallery. */
interface BackendImage {
  bytes: Buffer
  seed?: number
  width?: number
  height?: number
  model?: string
  backend: ResolvedBackend
  info?: Record<string, unknown>
}

/** Progress callback used while a backend operation runs. */
type ProgressFn = (progress: number | undefined, message: string, preview?: string) => void

/** Resolve the checkpoint to use for a call. */
function pickModel(requested: string | undefined, configured: string | undefined, available: string[]): string | undefined {
  if (requested !== undefined) {
    const exact = available.find((m) => m === requested)
    if (exact !== undefined) return exact
    const loose = available.find((m) => m.toLowerCase().includes(requested.toLowerCase()))
    if (loose !== undefined) return loose
    throw new Error(`model "${requested}" was not found; available: ${available.join(', ')}`)
  }
  if (configured !== undefined && configured !== '') {
    const hit = available.find((m) => m.toLowerCase().includes(configured.toLowerCase()))
    if (hit !== undefined) return hit
  }
  return available[0]
}

/** Upscaler preference order — anime-tuned models first (this machine has all of these). */
const UPSCALER_PREFERENCE = [
  'R-ESRGAN 4x+ Anime6B',
  'RealESRGAN_x4plus_anime_6B',
  '4x-AnimeSharp',
  'R-ESRGAN 4x+',
  'RealESRGAN_x4plus',
  'ESRGAN_4x',
  'BSRGAN',
  'SwinIR_4x',
]

/** Pick the best available upscaler from what the backend reports. */
function pickUpscaler(names: string[]): string | undefined {
  const lower = names.map((n) => n.toLowerCase())
  for (const preferred of UPSCALER_PREFERENCE) {
    const index = lower.indexOf(preferred.toLowerCase())
    if (index !== -1) return names[index]
  }
  return names.find((n) => n.toLowerCase().includes('anime'))
    ?? names.find((n) => n.toLowerCase().includes('esrgan'))
    ?? names[0]
}

/**
 * Flatten the WD14 tagger extension's response into a prompt string. Depending
 * on the build it returns `{caption: "..."}`, `{caption: {general: "...", ...}}`
 * or `{tags: [...]}`.
 */
function extractTaggerCaption(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const caption = (data as { caption?: unknown }).caption
  if (typeof caption === 'string') return caption
  if (caption !== null && typeof caption === 'object' && !Array.isArray(caption)) {
    const parts: string[] = []
    for (const [key, value] of Object.entries(caption as Record<string, unknown>)) {
      if (key === 'rating' || key === 'rating_index') continue
      if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
      else if (Array.isArray(value)) {
        const joined = value.filter((v) => typeof v === 'string').join(', ')
        if (joined !== '') parts.push(joined)
      }
    }
    if (parts.length > 0) return parts.join(', ')
  }
  const tags = (data as { tags?: unknown }).tags
  if (Array.isArray(tags)) {
    return tags
      .map((t) => (typeof t === 'string' ? t : String((t as { name?: unknown })?.name ?? '')))
      .filter((t) => t !== '')
      .join(', ')
  }
  return ''
}

/** ControlNet module + model keyword per art-friendly control type. */
const CONTROL_PRESETS: Record<string, { module: string; keyword: string }> = {
  openpose: { module: 'openpose', keyword: 'openpose' },
  lineart: { module: 'lineart_anime', keyword: 'lineart_anime' },
  lineart_realistic: { module: 'lineart', keyword: 'lineart' },
  canny: { module: 'canny', keyword: 'canny' },
  depth: { module: 'depth', keyword: 'depth' },
  normal: { module: 'normalbae', keyword: 'normalbae' },
  seg: { module: 'seg_ofade20k', keyword: 'seg' },
  scribble: { module: 'scribble_pidinet', keyword: 'scribble' },
  tile: { module: 'tile_resample', keyword: 'tile' },
  reference: { module: 'reference_only', keyword: '' },
}

export { CONTROL_PRESETS }

/**
 * Create the backend manager: probing, launching, and every HTTP call to the
 * two local diffusion servers.
 */
function createBackends(cfg: ImagegenConfig, subprocess: SubprocessSurface | undefined, post: {
  cutout(input: string, output: string, method: string, keyColor: string, tolerance: number): Promise<Record<string, unknown>>
  upscale(input: string, output: string, scale: number, width: number, height: number): Promise<Record<string, unknown>>
  tile(input: string, output: string, blend: number): Promise<Record<string, unknown>>
  info(input: string): Promise<Record<string, unknown>>
  ready(): boolean
  reason(): string
  call(cmd: string, args: string[]): Promise<Record<string, unknown>>
}) {
  const spawnProcess = makeSpawner(subprocess)
  const processes: Partial<Record<ResolvedBackend, RunningProcess>> = {}
  const modelCache = new Map<ResolvedBackend, { at: number; models: string[] }>()

  const sdBase = `http://127.0.0.1:${cfg.sdwebuiPort}`
  const comfyBase = `http://127.0.0.1:${cfg.comfyPort}`

  const rootOf = (id: ResolvedBackend): string => (id === 'sdwebui' ? cfg.sdwebuiRoot : cfg.comfyRoot)
  const pythonOf = (id: ResolvedBackend): string => (id === 'sdwebui' ? cfg.sdwebuiPython : cfg.comfyPython)
  const baseOf = (id: ResolvedBackend): string => (id === 'sdwebui' ? sdBase : comfyBase)
  const labelOf = (id: ResolvedBackend): string => (id === 'sdwebui' ? 'SD WebUI (秋叶 v4.10)' : 'ComfyUI (秋叶 v2)')

  /** Fetch the checkpoint list of a backend (cached for 30s). */
  async function models(id: ResolvedBackend): Promise<string[]> {
    const cached = modelCache.get(id)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.models
    let list: string[] = []
    try {
      if (id === 'sdwebui') {
        const data = (await fetchJson(`${sdBase}/sdapi/v1/sd-models`, { timeoutMs: 8000 })) as Array<Record<string, unknown>>
        list = data.map((m) => String(m.title ?? m.model_name ?? '')).filter((s) => s !== '')
      } else {
        const info = (await fetchJson(`${comfyBase}/object_info/CheckpointLoaderSimple`, { timeoutMs: 8000 })) as Record<string, { input?: { required?: { ckpt_name?: unknown[] } } }>
        const options = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
        if (Array.isArray(options)) list = options.map((v) => String(v))
      }
    } catch {
      list = []
    }
    modelCache.set(id, { at: Date.now(), models: list })
    return list
  }

  /** Probe one backend without launching anything. */
  async function probe(id: ResolvedBackend): Promise<BackendStatus> {
    const base: BackendStatus = {
      id,
      label: labelOf(id),
      root: rootOf(id),
      port: id === 'sdwebui' ? cfg.sdwebuiPort : cfg.comfyPort,
      running: false,
      detail: '',
      models: [],
      capabilities: {},
      strengths: [],
      managed: processes[id] !== undefined,
    }
    if (id === 'sdwebui') {
      const options = (await probeJson(`${sdBase}/sdapi/v1/options`)) as Record<string, unknown> | undefined
      if (options === undefined) {
        base.detail = '未运行（端口 ' + cfg.sdwebuiPort + ' 无响应）'
        return base
      }
      base.running = true
      base.models = await models('sdwebui')
      const [upscalers, interrogators, cnModels, samplers, taggers] = await Promise.all([
        probeJson(`${sdBase}/sdapi/v1/upscalers`),
        probeJson(`${sdBase}/sdapi/v1/interrogators`),
        probeJson(`${sdBase}/controlnet/model_list`),
        probeJson(`${sdBase}/sdapi/v1/samplers`),
        probeJson(`${sdBase}/tagger/v1/interrogators`),
      ])
      const names = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.map((v) => String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).model_name ?? v)).filter((s) => s !== '')
          : []
      const cnList = (cnModels as { model_list?: string[] } | undefined)?.model_list ?? []
      const taggerModels = (taggers as { models?: string[] } | undefined)?.models ?? []
      const faceRestore = fileExists(`${cfg.sdwebuiRoot}/models/GFPGAN/detection_Resnet50_Final.pth`)
      base.capabilities = {
        txt2img: true,
        img2img: true,
        controlnet: cnList.length,
        upscalers: names(upscalers).length,
        interrogators: names(interrogators).length,
        taggerModels: taggerModels.length,
        samplers: names(samplers).length,
        faceRestore,
      }
      base.strengths = [
        `文生图 / 图生图 可用`,
        cnList.length === 0 ? 'ControlNet 未装' : `ControlNet ${cnList.length} 个（openpose/lineart/depth/canny/tile…）`,
        names(upscalers).length === 0 ? '无放大模型' : `放大模型 ${names(upscalers).length} 个（含动漫向 R-ESRGAN / AnimeSharp）`,
        names(interrogators).length > 0
          ? `反推提示词：${names(interrogators).join(', ')}`
          : taggerModels.length > 0
            ? `反推提示词：WD14 tagger 扩展（首选 ${taggerModels.find((m) => m === 'wd14-convnextv2-v2') ?? taggerModels[0]}，首次调用会下载模型）`
            : '反推提示词：不可用',
        faceRestore ? '人脸修复 可用（GFPGAN / CodeFormer）' : '人脸修复 未装',
        '后处理抠图：rembg(u2net) / 色键 可用',
      ]
      base.detail = `当前模型 ${String(options.sd_model_checkpoint ?? '?')}；ControlNet ${cnList.length} 个；放大 ${names(upscalers).length} 个`
      return base
    }
    const stats = await probeJson(`${comfyBase}/system_stats`)
    if (stats === undefined) {
      base.detail = '未运行（端口 ' + cfg.comfyPort + ' 无响应）'
      return base
    }
    base.running = true
    base.models = await models('comfyui')
    const [objectInfo, cnInfo, upInfo] = await Promise.all([
      probeJson(`${comfyBase}/object_info`),
      probeJson(`${comfyBase}/object_info/ControlNetLoader`),
      probeJson(`${comfyBase}/object_info/UpscaleModelLoader`),
    ]) as [Record<string, unknown> | undefined, unknown, unknown]
    const has = (key: string): boolean => objectInfo !== undefined && Object.prototype.hasOwnProperty.call(objectInfo, key)
    // ComfyUI's extra_model_paths.yaml is commonly pointed at the 秋叶 SD WebUI
    // install, so ControlNet / upscale weights ARE visible here even though
    // ComfyUI's own models/ subdirectories are empty. Probe the loaders rather
    // than assuming.
    const listOf = (value: unknown, node: string, field: string): string[] => {
      const options = (value as Record<string, { input?: { required?: Record<string, unknown[]> } }> | undefined)
        ?.[node]?.input?.required?.[field]?.[0]
      return Array.isArray(options) ? options.map((v) => String(v)) : []
    }
    const cnList = listOf(cnInfo, 'ControlNetLoader', 'control_net_name')
    const upList = listOf(upInfo, 'UpscaleModelLoader', 'model_name')
    const layerdiffuse = has('LayeredDiffusionApply') && has('LayeredDiffusionDecodeRGBA')
    base.capabilities = {
      txt2img: true,
      img2img: true,
      controlnet: cnList.length,
      upscalers: upList.length,
      layerdiffuse,
      wd14: has('WD14Tagger|pysssss'),
      nodes: objectInfo === undefined ? 0 : Object.keys(objectInfo).length,
    }
    base.strengths = [
      '文生图 / 图生图 可用（工作流 JSON 驱动）',
      cnList.length === 0
        ? 'ControlNet 权重不可见'
        : `ControlNet 权重 ${cnList.length} 个（经 extra_model_paths 共享 SD WebUI 的目录）`,
      upList.length === 0 ? '放大权重不可见' : `放大权重 ${upList.length} 个`,
      layerdiffuse
        ? 'layerdiffuse 节点已装，但 models/layerdiffuse 权重缺失 —— 透明直出暂不可用'
        : 'layerdiffuse 节点缺失',
      `自定义节点 ${String(base.capabilities.nodes)} 个`,
      '注意：本插件的 ComfyUI 通道目前只实现文生图/图生图；ControlNet、放大、反推请走 SD WebUI',
    ]
    base.detail = `checkpoint ${base.models.join(', ') || '（无）'}；ControlNet ${cnList.length} 个；放大 ${upList.length} 个；节点 ${String(base.capabilities.nodes)} 个`
    return base
  }

  /** Probe both backends. */
  async function statusAll(): Promise<BackendStatus[]> {
    return [await probe('sdwebui'), await probe('comfyui')]
  }

  /** Pick a backend: honour an explicit request, otherwise the first that answers. */
  async function resolve(requested: BackendId): Promise<ResolvedBackend> {
    if (requested === 'sdwebui' || requested === 'comfyui') {
      if (requested === 'sdwebui' && !(await isUp('sdwebui'))) {
        throw new Error('godot-imagegen: SD WebUI 未运行（端口 ' + cfg.sdwebuiPort + '）。请先用 image_backend_status 的 action=start 启动，或打开绘世启动器。')
      }
      if (requested === 'comfyui' && !(await isUp('comfyui'))) {
        throw new Error('godot-imagegen: ComfyUI 未运行（端口 ' + cfg.comfyPort + '）。请先用 image_backend_status 的 action=start 启动，或打开绘世启动器。')
      }
      return requested
    }
    if (cfg.defaultBackend === 'sdwebui' && (await isUp('sdwebui'))) return 'sdwebui'
    if (cfg.defaultBackend === 'comfyui' && (await isUp('comfyui'))) return 'comfyui'
    if (await isUp('sdwebui')) return 'sdwebui'
    if (await isUp('comfyui')) return 'comfyui'
    throw new Error('godot-imagegen: 没有可用的出图后端。请先用 image_backend_status（action=start）启动 SD WebUI 或 ComfyUI。')
  }

  /** Cheap liveness check. */
  async function isUp(id: ResolvedBackend): Promise<boolean> {
    const url = id === 'sdwebui' ? `${sdBase}/sdapi/v1/options` : `${comfyBase}/system_stats`
    return (await probeJson(url)) !== undefined
  }

  /** Launch a backend through its bundled Python; resolves once it answers. */
  async function launch(id: ResolvedBackend): Promise<{ ok: boolean; detail: string; pid?: number }> {
    if (await isUp(id)) {
      return { ok: true, detail: `${labelOf(id)} 已在运行（复用现有实例，不重启）` }
    }
    const root = rootOf(id)
    const python = pythonOf(id)
    if (!fileExists(root)) return { ok: false, detail: `安装目录不存在：${root}` }
    if (!fileExists(python)) return { ok: false, detail: `内嵌 Python 不存在：${python}` }
    // NB: A1111's `--listen` is a store_true flag, NOT an option that takes an
    // address — passing `--listen 127.0.0.1` makes launch.py fail with
    // "unrecognized arguments: 127.0.0.1". Keep it loopback-only by using
    // --server-name (which is also the default) and never passing --listen.
    const argv = id === 'sdwebui'
      ? [python, 'launch.py', '--api', '--port', String(cfg.sdwebuiPort), '--server-name', '127.0.0.1', '--skip-prepare-environment', '--no-download-sd-model']
      : [python, '-s', 'main.py', '--port', String(cfg.comfyPort), '--listen', '127.0.0.1']
    const cwd = id === 'sdwebui' ? root : `${root}/ComfyUI`
    if (!fileExists(cwd)) return { ok: false, detail: `启动目录不存在：${cwd}` }
    const proc = spawnProcess({ argv, cwd, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    processes[id] = proc
    const deadline = Date.now() + cfg.startTimeoutMs
    let lastDetail = ''
    while (Date.now() < deadline) {
      if (await isUp(id)) {
        return { ok: true, detail: `${labelOf(id)} 启动完成`, ...(proc.pid === undefined ? {} : { pid: proc.pid }) }
      }
      const tail = proc.output().trim().split(/\r?\n/).filter((l) => l.trim() !== '')
      if (tail.length > 0) lastDetail = tail.slice(-3).join(' | ').slice(0, 300)
      await delay(1500)
    }
    return { ok: false, detail: `启动超时（${Math.round(cfg.startTimeoutMs / 1000)}s）。最近输出：${lastDetail || '（无）'}` }
  }

  /** Stop a backend — only when THIS plugin spawned it. */
  async function shutdown(id: ResolvedBackend): Promise<{ ok: boolean; detail: string }> {
    const proc = processes[id]
    if (proc === undefined) {
      return { ok: false, detail: `${labelOf(id)} 不是本插件启动的实例，拒绝终止（请用绘世启动器或控制台自行关闭）。` }
    }
    try {
      if (await isUp(id)) {
        if (id === 'sdwebui') await postJsonVoid(`${sdBase}/sdapi/v1/interrupt`, {}, 5000).catch(() => undefined)
        else await postJsonVoid(`${comfyBase}/interrupt`, {}, 5000).catch(() => undefined)
      }
    } catch {
      /* best effort */
    }
    proc.kill()
    delete processes[id]
    return { ok: true, detail: `${labelOf(id)} 已停止` }
  }

  /** Poll progress while `worker` is in flight (SD Web UI only; ComfyUI has no cheap probe). */
  async function withSdProgress<T>(signal: AbortSignal | undefined, onProgress: ProgressFn | undefined, worker: () => Promise<T>): Promise<T> {
    const pollControl = new AbortController()
    const onOuterAbort = (): void => pollControl.abort()
    if (signal !== undefined) signal.addEventListener('abort', onOuterAbort)
    const poll = (async () => {
      if (onProgress === undefined) return
      while (!pollControl.signal.aborted) {
        try {
          await delay(900, pollControl.signal)
        } catch {
          return
        }
        if (pollControl.signal.aborted) return
        const p = (await probeJson(`${sdBase}/sdapi/v1/progress?skip_current_image=false`, 4000)) as
          | { progress?: number; eta_relative?: number; current_image?: string | null; state?: { sampling_step?: number; sampling_steps?: number; job?: string } }
          | undefined
        if (p === undefined) continue
        const ratio = typeof p.progress === 'number' ? clamp(p.progress, 0, 1) : undefined
        const step = p.state?.sampling_step
        const steps = p.state?.sampling_steps
        const label = step !== undefined && steps !== undefined ? `采样 ${step}/${steps}` : '生成中'
        const eta = typeof p.eta_relative === 'number' && p.eta_relative > 0 ? `，剩余约 ${Math.ceil(p.eta_relative)}s` : ''
        onProgress(ratio, `${label}${eta}`, p.current_image ?? undefined)
      }
    })()
    try {
      return await worker()
    } finally {
      pollControl.abort()
      if (signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
      await poll.catch(() => undefined)
    }
  }

  // ---- SD WebUI / A1111 calls ----

  /** A1111 txt2img. */
  async function sdTxt2Img(params: {
    prompt: string
    negativePrompt?: string
    width: number
    height: number
    steps: number
    cfgScale: number
    sampler?: string
    seed: number
    batch: number
    model?: string
    tiling?: boolean
    control?: { image: string; type: string; weight?: number }
    signal?: AbortSignal
    onProgress?: ProgressFn
  }): Promise<BackendImage[]> {
    const available = await models('sdwebui')
    const checkpoint = pickModel(params.model, cfg.sdwebuiModel, available)
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      negative_prompt: params.negativePrompt ?? '',
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg_scale: params.cfgScale,
      seed: params.seed,
      batch_size: params.batch,
      n_iter: 1,
      sampler_name: params.sampler ?? 'DPM++ 2M SDE',
      scheduler: 'Karras',
      save_images: false,
      do_not_save_samples: true,
      do_not_save_grid: true,
      send_images: true,
      tiling: params.tiling === true,
      override_settings: checkpoint === undefined ? {} : { sd_model_checkpoint: checkpoint },
      override_settings_restore_afterwards: true,
    }
    if (params.control !== undefined) {
      const preset = CONTROL_PRESETS[params.control.type] ?? CONTROL_PRESETS.openpose
      const cnAvailable = ((await probeJson(`${sdBase}/controlnet/model_list`)) as { model_list?: string[] } | undefined)?.model_list ?? []
      const keyword = preset.keyword
      const cnModel = keyword === ''
        ? cnAvailable[0]
        : cnAvailable.find((m) => m.toLowerCase().includes(keyword)) ?? cnAvailable[0]
      if (cnModel !== undefined) {
        body.alwayson_scripts = {
          controlnet: {
            args: [{
              enabled: true,
              image: params.control.image,
              module: preset.module,
              model: cnModel,
              weight: params.control.weight ?? 0.8,
              guidance_start: 0.0,
              guidance_end: 1.0,
              resize_mode: 'Crop and Resize',
              pixel_perfect: true,
              control_mode: 'Balanced',
              // Without this, ControlNet appends its detected-map preview to
              // the returned images[] and it would be saved as a real asset.
              save_detected_map: false,
            }],
          },
        }
      }
    }
    const data = (await withSdProgress(params.signal, params.onProgress, () =>
      fetchJson(`${sdBase}/sdapi/v1/txt2img`, { method: 'POST', body, timeoutMs: cfg.requestTimeoutMs, ...(params.signal === undefined ? {} : { signal: params.signal }) }),
    )) as { images?: string[]; info?: string }
    const info = parseA1111Info(data.info)
    const out: BackendImage[] = []
    for (const raw of data.images ?? []) {
      const bytes = decodeBase64Image(raw)
      out.push({
        bytes,
        backend: 'sdwebui',
        ...(typeof info.seed === 'number' ? { seed: info.seed } : {}),
        width: params.width,
        height: params.height,
        ...(checkpoint === undefined ? {} : { model: checkpoint }),
        info,
      })
    }
    if (out.length === 0) throw new Error('SD WebUI 返回了 0 张图片')
    return out
  }

  /** A1111 img2img (optionally with a mask or ControlNet guidance). */
  async function sdImg2Img(params: {
    initImage: string
    mask?: string
    prompt: string
    negativePrompt?: string
    width?: number
    height?: number
    steps: number
    cfgScale: number
    denoise: number
    sampler?: string
    seed: number
    batch: number
    model?: string
    control?: { image: string; type: string; weight?: number }
    signal?: AbortSignal
    onProgress?: ProgressFn
  }): Promise<BackendImage[]> {
    const available = await models('sdwebui')
    const checkpoint = pickModel(params.model, cfg.sdwebuiModel, available)
    const body: Record<string, unknown> = {
      init_images: [params.initImage],
      prompt: params.prompt,
      negative_prompt: params.negativePrompt ?? '',
      steps: params.steps,
      cfg_scale: params.cfgScale,
      denoising_strength: params.denoise,
      seed: params.seed,
      batch_size: params.batch,
      n_iter: 1,
      sampler_name: params.sampler ?? 'DPM++ 2M SDE',
      scheduler: 'Karras',
      resize_mode: 0,
      save_images: false,
      do_not_save_samples: true,
      include_init_images: false,
      override_settings: checkpoint === undefined ? {} : { sd_model_checkpoint: checkpoint },
      override_settings_restore_afterwards: true,
    }
    if (params.width !== undefined) body.width = params.width
    if (params.height !== undefined) body.height = params.height
    if (params.mask !== undefined) {
      body.mask = params.mask
      body.inpainting_fill = 1
      body.inpaint_full_res = true
      body.inpaint_full_res_padding = 32
      body.inpainting_mask_invert = 0
    }
    if (params.control !== undefined) {
      const preset = CONTROL_PRESETS[params.control.type] ?? CONTROL_PRESETS.openpose
      const cnAvailable = ((await probeJson(`${sdBase}/controlnet/model_list`)) as { model_list?: string[] } | undefined)?.model_list ?? []
      const cnModel = preset.keyword === ''
        ? cnAvailable[0]
        : cnAvailable.find((m) => m.toLowerCase().includes(preset.keyword)) ?? cnAvailable[0]
      if (cnModel !== undefined) {
        body.alwayson_scripts = {
          controlnet: {
            args: [{
              enabled: true,
              image: params.control.image,
              module: preset.module,
              model: cnModel,
              weight: params.control.weight ?? 0.8,
              guidance_start: 0.0,
              guidance_end: 1.0,
              resize_mode: 'Crop and Resize',
              pixel_perfect: true,
              control_mode: 'Balanced',
              save_detected_map: false,
            }],
          },
        }
      }
    }
    const data = (await withSdProgress(params.signal, params.onProgress, () =>
      fetchJson(`${sdBase}/sdapi/v1/img2img`, { method: 'POST', body, timeoutMs: cfg.requestTimeoutMs, ...(params.signal === undefined ? {} : { signal: params.signal }) }),
    )) as { images?: string[]; info?: string }
    const info = parseA1111Info(data.info)
    const out: BackendImage[] = []
    for (const raw of data.images ?? []) {
      out.push({
        bytes: decodeBase64Image(raw),
        backend: 'sdwebui',
        ...(typeof info.seed === 'number' ? { seed: info.seed } : {}),
        ...(checkpoint === undefined ? {} : { model: checkpoint }),
        info,
      })
    }
    if (out.length === 0) throw new Error('SD WebUI 返回了 0 张图片')
    return out
  }

  /** A1111 post-processing upscale (`/extra-single-image`). */
  async function sdUpscale(params: {
    image: string
    scale: number
    upscaler?: string
    signal?: AbortSignal
    onProgress?: ProgressFn
  }): Promise<BackendImage> {
    const upscalers = ((await probeJson(`${sdBase}/sdapi/v1/upscalers`)) as Array<{ name?: string }> | undefined) ?? []
    const names = upscalers.map((u) => String(u.name ?? '')).filter((s) => s !== '' && s !== 'None')
    const chosen = params.upscaler !== undefined
      ? names.find((n) => n.toLowerCase() === params.upscaler?.toLowerCase()) ?? names.find((n) => n.toLowerCase().includes(params.upscaler?.toLowerCase() ?? ''))
      : pickUpscaler(names)
    if (chosen === undefined) throw new Error('SD WebUI 没有可用的放大模型')
    params.onProgress?.(undefined, `放大中（${chosen} ×${params.scale}）`)
    const data = (await fetchJson(`${sdBase}/sdapi/v1/extra-single-image`, {
      method: 'POST',
      body: {
        image: params.image,
        upscaling_resize: params.scale,
        // NB: do NOT send upscaling_resize_w / upscaling_resize_h. Current A1111
        // validates them with `ge=1`, so the previously-sent 0 made the whole
        // call fail with HTTP 422 ("ensure this value is greater than or equal
        // to 1") — which is why every upscale silently degraded to Lanczos.
        upscaling_crop: true,
        upscaler_1: chosen,
        upscaler_2: 'None',
        upscaler_2_visibility: 0,
        resize_mode: 0,
        gfpgan_visibility: 0,
        codeformer_visibility: 0,
        codeformer_weight: 0,
        upscale_first: false,
        image_format: 'png',
      },
      timeoutMs: cfg.requestTimeoutMs,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    })) as { image?: string }
    if (typeof data.image !== 'string' || data.image === '') throw new Error('SD WebUI 放大返回空结果')
    return { bytes: decodeBase64Image(data.image), backend: 'sdwebui', info: { upscaler: chosen, scale: params.scale } }
  }

  /**
   * Reverse-engineer a prompt. Two routes are tried in order because the
   * built-in `/sdapi/v1/interrogate` endpoint only exists when deepdanbooru is
   * installed, while the WD14 tagger *extension* (installed here) exposes its
   * own `/tagger/v1/*` API.
   */
  async function sdInterrogate(params: {
    image: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ caption: string; model: string }> {
    const wanted = params.model ?? 'deepdanbooru'

    // 1) Built-in A1111 interrogators (deepdanbooru / clip).
    const builtin = (((await probeJson(`${sdBase}/sdapi/v1/interrogators`)) as Array<{ name?: string }> | undefined) ?? [])
      .map((i) => String(i.name ?? ''))
      .filter((s) => s !== '')
    if (builtin.length > 0) {
      const chosen = builtin.find((n) => n.toLowerCase() === wanted.toLowerCase())
        ?? builtin.find((n) => n.toLowerCase().includes(wanted.toLowerCase()))
        ?? builtin[0]
      const data = (await fetchJson(`${sdBase}/sdapi/v1/interrogate`, {
        method: 'POST',
        body: { image: params.image, model: chosen },
        timeoutMs: Math.max(cfg.requestTimeoutMs, 600_000),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
      })) as { caption?: string }
      return { caption: String(data.caption ?? ''), model: chosen }
    }

    // 2) WD14 tagger extension. Its FIRST call downloads the chosen ONNX model
    //    (hundreds of MB), so the timeout is generous.
    const tagger = ((await probeJson(`${sdBase}/tagger/v1/interrogators`)) as { models?: string[] } | undefined)?.models ?? []
    if (tagger.length === 0) {
      throw new Error('SD WebUI 没有可用的反推模型：需要内置 deepdanbooru，或安装 stable-diffusion-webui-wd14-tagger 扩展')
    }
    const chosen = tagger.find((m) => m.toLowerCase() === wanted.toLowerCase())
      ?? tagger.find((m) => m.toLowerCase() === 'wd14-convnextv2-v2')
      ?? tagger.find((m) => m.toLowerCase().includes('wd14'))
      ?? tagger[0]
    const data = await fetchJson(`${sdBase}/tagger/v1/interrogate`, {
      method: 'POST',
      body: { image: params.image, model: chosen, threshold: 0.35 },
      timeoutMs: 900_000,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    })
    return { caption: extractTaggerCaption(data), model: `${chosen} (wd14 tagger)` }
  }

  // ---- ComfyUI calls ----

  /** Build an API-format ComfyUI graph for txt2img (optionally layer-diffuse RGBA). */
  function comfyGraph(params: {
    prompt: string
    negativePrompt: string
    width: number
    height: number
    steps: number
    cfgScale: number
    sampler: string
    scheduler: string
    seed: number
    batch: number
    checkpoint: string
    rgba: boolean
    initImageName?: string
    denoise?: number
  }): Record<string, unknown> {
    const graph: Record<string, unknown> = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.checkpoint } },
      '5': {
        class_type: params.initImageName === undefined ? 'EmptyLatentImage' : 'VAEEncode',
        inputs: params.initImageName === undefined
          ? { width: params.width, height: params.height, batch_size: params.batch }
          : { pixels: ['10', 0], vae: ['4', 2] },
      },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt, clip: ['4', 1] } },
    }
    if (params.initImageName !== undefined) {
      graph['10'] = { class_type: 'LoadImage', inputs: { image: params.initImageName } }
    }
    const modelRef: [string, number] = params.rgba ? ['13', 0] : ['4', 0]
    if (params.rgba) {
      graph['13'] = {
        class_type: 'LayeredDiffusionApply',
        inputs: { model: ['4', 0], config: 'SD15', weight: 1.0 },
      }
    }
    graph['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler,
        scheduler: params.scheduler,
        denoise: params.denoise ?? 1.0,
        model: modelRef,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    }
    graph['8'] = { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } }
    if (params.rgba) {
      graph['14'] = {
        class_type: 'LayeredDiffusionDecodeRGBA',
        inputs: { samples: ['3', 0], images: ['8', 0], config: 'SD15', _version: 16 },
      }
      graph['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'gig', images: ['14', 0] } }
    } else {
      graph['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'gig', images: ['8', 0] } }
    }
    return graph
  }

  /** Run a ComfyUI graph and fetch every image it produced. */
  async function comfyRun(params: {
    graph: Record<string, unknown>
    signal?: AbortSignal
    onProgress?: ProgressFn
  }): Promise<BackendImage[]> {
    const clientId = randomUUID()
    const queued = (await fetchJson(`${comfyBase}/prompt`, {
      method: 'POST',
      body: { prompt: params.graph, client_id: clientId },
      timeoutMs: 60_000,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    })) as { prompt_id?: string; node_errors?: unknown }
    const promptId = queued.prompt_id
    if (typeof promptId !== 'string' || promptId === '') {
      throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(queued.node_errors ?? queued).slice(0, 400)}`)
    }
    const deadline = Date.now() + cfg.requestTimeoutMs
    const started = Date.now()
    while (Date.now() < deadline) {
      if (params.signal?.aborted === true) {
        await postJsonVoid(`${comfyBase}/interrupt`, {}, 5000).catch(() => undefined)
        throw new Error('cancelled')
      }
      const history = (await probeJson(`${comfyBase}/history/${promptId}`, 8000)) as
        | Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }>; status?: string }>; status?: { status_str?: string; completed?: boolean } }>
        | undefined
      const entry = history?.[promptId]
      if (entry !== undefined) {
        if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
          throw new Error(`ComfyUI 执行失败：${entry.status?.status_str ?? 'unknown'}`)
        }
        const refs: Array<{ filename: string; subfolder: string; type: string }> = []
        for (const output of Object.values(entry.outputs ?? {})) {
          for (const image of output.images ?? []) refs.push(image)
        }
        if (refs.length > 0) {
          const out: BackendImage[] = []
          for (const ref of refs) {
            const url = `${comfyBase}/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder)}&type=${encodeURIComponent(ref.type)}`
            const response = await httpRaw(url, {
              timeoutMs: 120_000,
              ...(params.signal === undefined ? {} : { signal: params.signal }),
            })
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`ComfyUI /view → HTTP ${response.status}`)
            }
            out.push({ bytes: response.body, backend: 'comfyui' })
          }
          return out
        }
      }
      const elapsed = Math.round((Date.now() - started) / 1000)
      params.onProgress?.(undefined, `ComfyUI 执行中（${elapsed}s）`)
      await delay(1200, params.signal)
    }
    throw new Error('ComfyUI 执行超时')
  }

  /** Upload an image into ComfyUI's input dir so `LoadImage` can see it. */
  async function comfyUpload(filePath: string, signal?: AbortSignal): Promise<string> {
    const bytes = await readFile(filePath)
    // Hand-built multipart body: global fetch's FormData is unavailable once
    // backend calls go through node:http (see httpRaw) and is unnecessary here.
    const boundary = `----godotimagegen${randomUUID().replace(/-/g, '')}`
    const head = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="image"; filename="${basename(filePath)}"\r\n`
      + 'Content-Type: image/png\r\n\r\n',
      'utf8',
    )
    const tail = Buffer.from(
      `\r\n--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="overwrite"\r\n\r\n'
      + `true\r\n--${boundary}--\r\n`,
      'utf8',
    )
    const body = Buffer.concat([head, bytes, tail])
    const response = await httpRaw(`${comfyBase}/upload/image`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body,
      timeoutMs: 180_000,
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ComfyUI 上传失败 → HTTP ${response.status}: ${response.body.toString('utf8').slice(0, 200)}`)
    }
    const data = JSON.parse(response.body.toString('utf8')) as { name?: string; subfolder?: string }
    const name = data.name ?? basename(filePath)
    return data.subfolder !== undefined && data.subfolder !== '' ? `${data.subfolder}/${name}` : name
  }

  /**
   * When an operation times out or is cancelled, tell the server to stop too.
   * Diffusion servers keep sampling after the client disconnects, so without
   * this an aborted request leaves an orphaned job holding the GPU and every
   * later request queues behind it.
   */
  async function interruptOnFailure<T>(backend: ResolvedBackend, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout|cancelled|aborted|ECONNRESET|socket hang up/i.test(message)) {
        try {
          if (backend === 'sdwebui') await postJsonVoid(`${sdBase}/sdapi/v1/interrupt`, {}, 8000)
          else await postJsonVoid(`${comfyBase}/interrupt`, {}, 8000)
        } catch {
          /* the backend may already be idle or gone */
        }
      }
      throw error
    }
  }

  return {
    statusAll,
    probe,
    resolve,
    isUp,
    launch,
    shutdown,
    models,
    sdTxt2Img: (params: Parameters<typeof sdTxt2Img>[0]) => interruptOnFailure('sdwebui', () => sdTxt2Img(params)),
    sdImg2Img: (params: Parameters<typeof sdImg2Img>[0]) => interruptOnFailure('sdwebui', () => sdImg2Img(params)),
    sdUpscale: (params: Parameters<typeof sdUpscale>[0]) => interruptOnFailure('sdwebui', () => sdUpscale(params)),
    sdInterrogate,
    comfyRun: (params: Parameters<typeof comfyRun>[0]) => interruptOnFailure('comfyui', () => comfyRun(params)),
    comfyGraph,
    comfyUpload,
    post,
  }
}

/** Parse the `info` JSON string A1111 returns alongside generated images. */
function parseA1111Info(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed
  } catch {
    return {}
  }
}

// ─────────────────────────── Python post-processing bridge ───────────────────────────

/** The post-processing surface handed to the backend manager. */
interface PostBridge {
  cutout(input: string, output: string, method: string, keyColor: string, tolerance: number): Promise<Record<string, unknown>>
  upscale(input: string, output: string, scale: number, width: number, height: number): Promise<Record<string, unknown>>
  tile(input: string, output: string, blend: number): Promise<Record<string, unknown>>
  info(input: string): Promise<Record<string, unknown>>
  ready(): boolean
  reason(): string
  call(cmd: string, args: string[]): Promise<Record<string, unknown>>
}

/**
 * Create the Python bridge. The script is materialised once into a temp dir and
 * every call goes through the same interpreter, so rembg/cv2/Pillow imports are
 * amortised by the OS file cache rather than re-installed.
 */
function createPostBridge(cfg: ImagegenConfig, subprocess: SubprocessSurface | undefined): PostBridge {
  const spawnProcess = makeSpawner(subprocess)
  let scriptPromise: Promise<string> | undefined

  function ensureScript(): Promise<string> {
    if (scriptPromise === undefined) {
      scriptPromise = (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gig-py-'))
        const script = join(dir, 'gig_tools.py')
        await writeFile(script, PY_TOOL_SOURCE, 'utf8')
        return script
      })()
    }
    return scriptPromise
  }

  function ready(): boolean {
    return fileExists(cfg.postPython)
  }

  function reason(): string {
    return ready()
      ? `后处理 Python：${cfg.postPython}`
      : `后处理 Python 不存在：${cfg.postPython}（背景移除/放大不可用）`
  }

  async function call(cmd: string, args: string[]): Promise<Record<string, unknown>> {
    if (!ready()) {
      throw new Error(`godot-imagegen: 后处理 Python 不存在（${cfg.postPython}），无法执行 ${cmd}`)
    }
    const script = await ensureScript()
    const dir = dirname(script)
    // The result travels through a file rather than stdout: rembg / onnxruntime
    // print unbounded warning and model-download output that would otherwise
    // interleave with (and truncate) the JSON marker.
    const resultPath = join(dir, `result-${randomUUID().slice(0, 8)}.json`)
    const proc = spawnProcess({
      argv: [cfg.postPython, '-s', script, cmd, '--result', resultPath, ...args],
      cwd: dir,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const code = await proc.done
    const raw = proc.output()

    let parsed: Record<string, unknown> | undefined
    try {
      const text = await readFile(resultPath, 'utf8')
      const candidate = JSON.parse(text) as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(candidate, 'ok')) parsed = candidate
    } catch {
      /* older/blocked run — fall back to scanning stdout below */
    }
    await rm(resultPath, { force: true }).catch(() => undefined)

    if (parsed === undefined) {
      const lines = raw.split(/\r?\n/)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line === '' || line[0] !== '{') continue
        try {
          const candidate = JSON.parse(line) as Record<string, unknown>
          if (Object.prototype.hasOwnProperty.call(candidate, 'ok')) {
            parsed = candidate
            break
          }
        } catch {
          /* not the marker line */
        }
      }
    }
    if (parsed === undefined) {
      const tail = raw.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400)
      throw new Error(`godot-imagegen: Python ${cmd} 未返回结果（exit=${String(code)}）：${tail || '（无输出）'}`)
    }
    if (parsed.ok !== true) {
      const err = new Error(String(parsed.error ?? 'Python 后处理失败')) as Error & { fallback?: string }
      if (typeof parsed.fallback === 'string') err.fallback = parsed.fallback
      throw err
    }
    return parsed
  }

  return {
    ready,
    reason,
    call,
    cutout: (input, output, method, keyColor, tolerance) =>
      call('cutout', ['--input', input, '--output', output, '--method', method, '--key', keyColor, '--tolerance', String(tolerance)]),
    upscale: (input, output, scale, width, height) =>
      call('upscale', ['--input', input, '--output', output, '--scale', String(scale), '--width', String(width), '--height', String(height)]),
    tile: (input, output, blend) => call('tile', ['--input', input, '--output', output, '--blend', String(blend)]),
    info: (input) => call('info', ['--input', input]),
  }
}

// ─────────────────────────── gallery storage ───────────────────────────

/** A reusable prompt recipe shown in the 美术工坊 panel. */
interface PromptPreset {
  id: string
  name: string
  category: ArtCategory
  prompt: string
  negativePrompt: string
  width: number
  height: number
  steps: number
  cfgScale: number
  transparent: boolean
  builtin?: boolean
}

/** The `global` half of the plugin's KV unit. */
interface ImagegenGlobal {
  settings: {
    godotProject?: string
    outDir?: string
    defaultBackend: BackendId
    lastCategory: ArtCategory
  }
  presets: PromptPreset[]
}

const TABLE_IMAGES = 'images'

/** Standard negative prompt that keeps anime game art clean. */
const BASE_NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name'

/** Built-in prompt recipes seeded on first run, one or more per art category. */
function builtinPresets(): PromptPreset[] {
  const base = (
    id: string,
    name: string,
    category: ArtCategory,
    prompt: string,
    extraNeg: string,
    transparent: boolean,
  ): PromptPreset => {
    const d = CATEGORY_DEFAULTS[category]
    return {
      id,
      name,
      category,
      prompt,
      negativePrompt: extraNeg === '' ? BASE_NEGATIVE : `${BASE_NEGATIVE}, ${extraNeg}`,
      width: d.width,
      height: d.height,
      steps: d.steps,
      cfgScale: d.cfgScale,
      transparent,
      builtin: true,
    }
  }
  return [
    base('character-sheet', '角色立绘（透明）', 'character',
      'masterpiece, best quality, 1girl, solo, full body, standing, detailed face, detailed eyes, clean lineart, flat color, game character, character design, simple background',
      'multiple views, multiple girls, busy background', true),
    base('character-turnaround', '角色三视图', 'character',
      'masterpiece, best quality, character sheet, reference sheet, 1girl, front view, side view, back view, full body, t-pose, plain white background, concept art',
      'multiple girls, shading, background', false),
    base('item-icon', '道具图标', 'item',
      'masterpiece, best quality, game item icon, (potion bottle:1.2), centered, single object, clean thick outline, vibrant colors, flat shading, white background, sticker',
      'multiple objects, text, frame, human, character', true),
    base('skill-icon', '技能图标', 'item',
      'masterpiece, best quality, game skill icon, (fire magic:1.2), glowing, centered, single symbol, bold silhouette, high contrast, dark background, rpg ui icon',
      'multiple objects, text, human face, photorealistic', true),
    base('ui-button', 'UI 按钮', 'ui',
      'game ui button, glossy, rounded corners, (empty center:1.3), metallic frame, dark fantasy style, ui element, centered, isolated, plain background',
      'text, letters, watermark, character, scenery', true),
    base('ui-panel', 'UI 面板边框', 'ui',
      'game ui panel frame, ornate border, (empty middle:1.3), dark fantasy rpg interface, nine-patch friendly, symmetric, isolated, plain background',
      'text, letters, character, busy interior', true),
    base('tile-grass', '瓦片 · 草地', 'tile',
      'seamless tileable texture, top down grass field, video game tileset, pixel perfect, flat lighting, uniform, no shadow, no border',
      'seam, border, frame, vignette, text, perspective', false),
    base('tile-stone', '瓦片 · 石地', 'tile',
      'seamless tileable texture, top down stone floor, cobblestone, video game tileset, even lighting, no shadow, no border',
      'seam, border, frame, vignette, perspective, character', false),
    base('bg-parallax', '视差背景层', 'background',
      'masterpiece, best quality, (scenery:1.2), (no humans:1.3), anime background art, layered parallax background, wide shot, soft lighting, detailed environment',
      'people, character, text, watermark, frame', false),
    base('texture-pbr', 'PBR 贴图基础色', 'texture',
      'seamless tileable material texture, (wood planks:1.2), pbr albedo, top down flat, even lighting, no shadow, no highlight, high detail',
      'seam, border, frame, object, shadow, vignette, text', false),
    base('concept-keyart', '概念图 / 关键视觉', 'concept',
      'masterpiece, best quality, concept art, key visual, dramatic lighting, cinematic composition, highly detailed, trending on artstation',
      'text, watermark, signature, lowres, bad anatomy', false),
  ]
}

// ─────────────────────────── output paths ───────────────────────────

/** Where generated art lands, and the `res://` mapping when inside a Godot project. */
interface OutputPlan {
  root: string
  godotProject?: string
}

// ─────────────────────────── gallery store ───────────────────────────

/** Gallery + settings persistence on the plugin's own KV unit. */
interface GalleryStore {
  list(projectId?: string): Promise<GalleryImage[]>
  get(id: string): Promise<GalleryImage | undefined>
  add(image: GalleryImage): Promise<void>
  remove(id: string): Promise<boolean>
  clear(projectId?: string): Promise<number>
  globals(): Promise<ImagegenGlobal>
  setGlobals(mutate: (current: ImagegenGlobal) => ImagegenGlobal): Promise<ImagegenGlobal>
}

function defaultGlobals(cfg: ImagegenConfig): ImagegenGlobal {
  return {
    settings: {
      ...(cfg.godotProject === undefined ? {} : { godotProject: cfg.godotProject }),
      ...(cfg.outDir === undefined ? {} : { outDir: cfg.outDir }),
      defaultBackend: 'auto',
      lastCategory: 'character',
    },
    presets: builtinPresets(),
  }
}

/** Merge persisted globals with the shipped defaults (built-in presets always present). */
function normalizeGlobals(raw: unknown, cfg: ImagegenConfig): ImagegenGlobal {
  const fallback = defaultGlobals(cfg)
  if (typeof raw !== 'object' || raw === null) return fallback
  const value = raw as Partial<ImagegenGlobal>
  const settings = (typeof value.settings === 'object' && value.settings !== null ? value.settings : {}) as ImagegenGlobal['settings']
  const persisted = Array.isArray(value.presets) ? value.presets : []
  const builtins = fallback.presets
  const userPresets = persisted.filter((p) => p !== null && typeof p === 'object' && (p as PromptPreset).builtin !== true)
  const overriddenBuiltins = builtins.map((b) => persisted.find((p) => (p as PromptPreset).id === b.id) ?? b)
  return {
    settings: {
      defaultBackend: settings.defaultBackend ?? 'auto',
      lastCategory: ART_CATEGORIES.includes(settings.lastCategory) ? settings.lastCategory : 'character',
      ...(typeof settings.godotProject === 'string' && settings.godotProject !== '' ? { godotProject: settings.godotProject } : {}),
      ...(typeof settings.outDir === 'string' && settings.outDir !== '' ? { outDir: settings.outDir } : {}),
    },
    presets: [...overriddenBuiltins, ...userPresets],
  }
}

/** Create the gallery store over an already-open KV unit. */
function createGalleryStore(unit: () => Promise<KvUnit>, cfg: ImagegenConfig): GalleryStore {
  let lastWrite: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = lastWrite.then(task, task)
    lastWrite = run.catch(() => undefined)
    return run
  }

  async function loadImages(): Promise<Record<string, GalleryImage>> {
    const handle = await unit()
    const { tables } = await handle.loadAll()
    return (tables[TABLE_IMAGES] ?? {}) as Record<string, GalleryImage>
  }

  return {
    async list(projectId) {
      const all = Object.values(await loadImages())
      const filtered = projectId === undefined
        ? all
        : all.filter((image) => (image.projectId ?? 'default') === projectId)
      return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    async get(id) {
      const all = await loadImages()
      return all[id]
    },
    add(image) {
      return enqueue(async () => {
        const handle = await unit()
        await handle.putRecord(TABLE_IMAGES, image.id, image)
      })
    },
    remove(id) {
      return enqueue(async () => {
        const all = await loadImages()
        if (all[id] === undefined) return false
        const handle = await unit()
        await handle.deleteRecord(TABLE_IMAGES, id)
        return true
      })
    },
    clear(projectId) {
      return enqueue(async () => {
        const all = await loadImages()
        const doomed = Object.values(all).filter((image) =>
          projectId === undefined || (image.projectId ?? 'default') === projectId)
        const handle = await unit()
        for (const image of doomed) await handle.deleteRecord(TABLE_IMAGES, image.id)
        return doomed.length
      })
    },
    async globals() {
      const handle = await unit()
      const { global } = await handle.loadAll()
      return normalizeGlobals(global, cfg)
    },
    setGlobals(mutate) {
      return enqueue(async () => {
        const handle = await unit()
        const { global } = await handle.loadAll()
        const next = mutate(normalizeGlobals(global, cfg))
        await handle.setGlobal(next)
        return next
      })
    },
  }
}

// ─────────────────────────── job registry ───────────────────────────

/** Tracks in-flight backend operations so the panel can show progress. */
interface JobRegistry {
  create(kind: Job['kind'], label: string): Job
  list(): Job[]
  get(id: string): Job | undefined
  cancel(id: string): boolean
  /** Start `work` as a job and return it synchronously (for fire-and-forget REST routes). */
  start(
    kind: Job['kind'],
    label: string,
    work: (job: Job) => Promise<GalleryImage[]>,
    onJob?: (job: Job) => void,
  ): Job
  /** Run `work` as a job and resolve with its images (or throw). */
  run(
    kind: Job['kind'],
    label: string,
    work: (job: Job) => Promise<GalleryImage[]>,
    onJob?: (job: Job) => void,
  ): Promise<GalleryImage[]>
}

function createJobRegistry(maxHistory = 40): JobRegistry {
  const jobs = new Map<string, Job>()

  function create(kind: Job['kind'], label: string): Job {
    const job: Job = {
      id: `job_${randomUUID().slice(0, 8)}`,
      kind,
      label,
      status: 'running',
      message: '排队中',
      images: [],
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
    }
    jobs.set(job.id, job)
    if (jobs.size > maxHistory) {
      const finished = [...jobs.values()]
        .filter((j) => j.status !== 'running')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      while (jobs.size > maxHistory && finished.length > 0) {
        const victim = finished.shift()
        if (victim !== undefined) jobs.delete(victim.id)
      }
    }
    return job
  }

  return {
    create,
    list: () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    get: (id) => jobs.get(id),
    cancel(id) {
      const job = jobs.get(id)
      if (job === undefined || job.status !== 'running') return false
      job.controller.abort()
      return true
    },
    start(kind, label, work, onJob) {
      const job = create(kind, label)
      onJob?.(job)
      void (async () => {
        try {
          const images = await work(job)
          job.images = images
          job.status = 'done'
          job.progress = 1
          job.message = `完成，产出 ${images.length} 张`
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          job.status = message === 'cancelled' ? 'cancelled' : 'error'
          job.error = message
          job.message = message
        } finally {
          job.finishedAt = new Date().toISOString()
          job.preview = undefined
        }
      })()
      return job
    },
    async run(kind, label, work, onJob) {
      const job = create(kind, label)
      onJob?.(job)
      try {
        const images = await work(job)
        job.images = images
        job.status = 'done'
        job.progress = 1
        job.message = `完成，产出 ${images.length} 张`
        return images
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        job.status = message === 'cancelled' ? 'cancelled' : 'error'
        job.error = message
        job.message = message
        throw error
      } finally {
        job.finishedAt = new Date().toISOString()
        job.preview = undefined
      }
    },
  }
}

// ─────────────────────────── core operations ───────────────────────────

/** Everything the operations need from the plugin's wiring. */
interface OpsDeps {
  cfg: ImagegenConfig
  backends: ReturnType<typeof createBackends>
  post: PostBridge
  gallery: GalleryStore
  jobs: JobRegistry
}

/** Normalized generation request shared by the tool and REST surfaces. */
interface GenerateInput {
  prompt: string
  negativePrompt: string
  category: ArtCategory
  name: string
  width: number
  height: number
  steps: number
  cfgScale: number
  sampler?: string
  seed: number
  batch: number
  model?: string
  backend: BackendId
  transparent: boolean
  transparentMethod: 'auto' | 'rembg' | 'chroma' | 'generative'
  seamless: boolean
  control?: { imagePath: string; type: string; weight?: number }
  projectId: string
  outDir?: string
}

/** Normalized edit request. */
interface EditInput {
  imagePath: string
  maskPath?: string
  prompt: string
  negativePrompt: string
  category: ArtCategory
  name: string
  steps: number
  cfgScale: number
  denoise: number
  sampler?: string
  seed: number
  batch: number
  model?: string
  backend: BackendId
  transparent: boolean
  control?: { imagePath: string; type: string; weight?: number }
  projectId: string
  outDir?: string
}

const CATEGORY_TRANSPARENT_BY_DEFAULT: ArtCategory[] = ['character', 'item', 'ui']

function createOps(deps: OpsDeps) {
  const { cfg, backends, post, gallery, jobs } = deps

  /** Resolve the output root and the Godot project it maps into. */
  async function outputPlan(overrideOutDir?: string): Promise<OutputPlan> {
    const globals = await gallery.globals()
    const godotProject = globals.settings.godotProject ?? cfg.godotProject
    const configured = overrideOutDir ?? globals.settings.outDir ?? cfg.outDir
    const root = configured !== undefined && configured !== ''
      ? configured
      : godotProject !== undefined && godotProject !== ''
        ? join(godotProject, 'assets', 'generated')
        : join(process.env.DSH_HOME ?? '.dsh', 'imagegen-out')
    return { root, ...(godotProject === undefined || godotProject === '' ? {} : { godotProject }) }
  }

  /** Persist bytes under `<root>/<category>/` and compute the `res://` mapping. */
  async function saveImage(
    bytes: Buffer,
    plan: OutputPlan,
    category: ArtCategory,
    name: string,
    suffix = '',
  ): Promise<{ filePath: string; resPath?: string; size: number }> {
    const dir = join(plan.root, category)
    await mkdir(dir, { recursive: true })
    const fileName = `${slugify(name)}${suffix}-${timestampLabel()}-${randomUUID().slice(0, 4)}.png`
    const filePath = join(dir, fileName)
    await writeFile(filePath, bytes)
    const info = await statSafe(filePath)
    let resPath: string | undefined
    if (plan.godotProject !== undefined && isInside(plan.godotProject, filePath)) {
      const relative = filePath.slice(resolve(plan.godotProject).length).replace(/^[\\/]+/, '')
      resPath = `res://${relative.split(sep).join('/')}`
    }
    return {
      filePath,
      ...(resPath === undefined ? {} : { resPath }),
      size: info?.size ?? bytes.length,
    }
  }

  /** Accept an absolute path, a `res://` path, or a gallery id. */
  async function resolveImagePath(value: string): Promise<string> {
    if (value.startsWith('res://')) {
      const globals = await gallery.globals()
      const project = globals.settings.godotProject ?? cfg.godotProject
      if (project === undefined || project === '') {
        throw new Error(`res:// 路径需要先配置 Godot 项目根目录（当前未配置）：${value}`)
      }
      const abs = join(project, value.slice('res://'.length))
      if (!fileExists(abs)) throw new Error(`文件不存在：${abs}（由 ${value} 解析）`)
      return abs
    }
    if (value.startsWith('img_')) {
      const record = await gallery.get(value)
      if (record !== undefined) return record.filePath
      throw new Error(`图库中找不到记录 ${value}`)
    }
    if (!isAbsolute(value)) {
      throw new Error(`图片路径必须是绝对路径、res:// 路径或图库 id，收到：${value}`)
    }
    if (!fileExists(value)) throw new Error(`文件不存在：${value}`)
    return value
  }

  /** Record a produced file in the gallery. */
  async function record(
    saved: { filePath: string; resPath?: string; size: number },
    fields: Partial<GalleryImage> & { name: string; category: ArtCategory; op: GalleryImage['op'] },
  ): Promise<GalleryImage> {
    const image: GalleryImage = {
      id: `img_${randomUUID().slice(0, 12)}`,
      op: fields.op,
      name: fields.name,
      category: fields.category,
      filePath: saved.filePath,
      ...(saved.resPath === undefined ? {} : { resPath: saved.resPath }),
      size: saved.size,
      createdAt: new Date().toISOString(),
      ...(fields.prompt === undefined ? {} : { prompt: fields.prompt }),
      ...(fields.negativePrompt === undefined ? {} : { negativePrompt: fields.negativePrompt }),
      ...(fields.seed === undefined ? {} : { seed: fields.seed }),
      ...(fields.model === undefined ? {} : { model: fields.model }),
      ...(fields.backend === undefined ? {} : { backend: fields.backend }),
      ...(fields.width === undefined ? {} : { width: fields.width }),
      ...(fields.height === undefined ? {} : { height: fields.height }),
      ...(fields.steps === undefined ? {} : { steps: fields.steps }),
      ...(fields.cfgScale === undefined ? {} : { cfgScale: fields.cfgScale }),
      ...(fields.sampler === undefined ? {} : { sampler: fields.sampler }),
      ...(fields.sourceIds === undefined ? {} : { sourceIds: fields.sourceIds }),
      ...(fields.method === undefined ? {} : { method: fields.method }),
      ...(fields.meta === undefined ? {} : { meta: fields.meta }),
      projectId: fields.projectId ?? 'default',
    }
    await gallery.add(image)
    return image
  }

  /** Run the transparent-background step on one written file, in place. */
  async function makeTransparent(
    filePath: string,
    method: 'auto' | 'rembg' | 'chroma' | 'generative',
  ): Promise<{ method: string; filePath: string }> {
    const requested = method === 'generative' ? 'auto' : method
    try {
      await post.cutout(filePath, filePath, requested, '#FFFFFF', 42)
      return { method: requested === 'chroma' ? 'chroma' : 'rembg', filePath }
    } catch (error) {
      const fallback = (error as Error & { fallback?: string }).fallback
      if (requested === 'rembg' && fallback === 'chroma') {
        await post.cutout(filePath, filePath, 'chroma', '#FFFFFF', 42)
        return { method: 'chroma', filePath }
      }
      throw error
    }
  }

  /** Convert one written file into a seamlessly tiling texture, in place. */
  async function makeSeamless(filePath: string): Promise<string> {
    await post.tile(filePath, filePath, 48)
    return 'offset-blend'
  }

  /**
   * Text-to-image. Honours `transparent` / `seamless` and writes every produced
   * image into the gallery.
   */
  async function generate(input: GenerateInput, job: Job): Promise<GalleryImage[]> {
    job.message = '正在选择后端'
    const backend = await backends.resolve(input.backend)
    const plan = await outputPlan(input.outDir)
    const images: GalleryImage[] = []

    let controlImage: string | undefined
    if (input.control !== undefined) {
      const controlPath = await resolveImagePath(input.control.imagePath)
      controlImage = await readBase64(controlPath)
      job.message = `已载入 ControlNet 参考图（${input.control.type}）`
    }

    if (backend === 'sdwebui') {
      job.message = `SD WebUI 生成中（${input.width}×${input.height}, ${input.steps} 步）`
      const produced = await backends.sdTxt2Img({
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        width: input.width,
        height: input.height,
        steps: input.steps,
        cfgScale: input.cfgScale,
        ...(input.sampler === undefined ? {} : { sampler: input.sampler }),
        seed: input.seed,
        batch: input.batch,
        ...(input.model === undefined ? {} : { model: input.model }),
        tiling: input.seamless,
        ...(controlImage === undefined || input.control === undefined
          ? {}
          : { control: { image: controlImage, type: input.control.type, ...(input.control.weight === undefined ? {} : { weight: input.control.weight }) } }),
        signal: job.controller.signal,
        onProgress: (progress, message, preview) => {
          job.progress = progress
          job.message = message
          job.preview = preview
        },
      })
      for (const item of produced) {
        const saved = await saveImage(item.bytes, plan, input.category, input.name, `-${item.seed ?? 'x'}`)
        let method: string | undefined
        if (input.transparent) {
          const result = await makeTransparent(saved.filePath, input.transparentMethod)
          method = result.method
          const refreshed = await statSafe(saved.filePath)
          if (refreshed !== undefined) saved.size = refreshed.size
        }
        if (input.seamless && (input.category === 'tile' || input.category === 'texture')) {
          await makeSeamless(saved.filePath)
        }
        const galleryImage = await record(saved, {
          name: input.name,
          category: input.category,
          op: 'generate',
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          ...(item.seed === undefined ? {} : { seed: item.seed }),
          ...(item.model === undefined ? {} : { model: item.model }),
          backend: 'sdwebui',
          width: item.width ?? input.width,
          height: item.height ?? input.height,
          steps: input.steps,
          cfgScale: input.cfgScale,
          ...(input.sampler === undefined ? {} : { sampler: input.sampler }),
          ...(method === undefined ? {} : { method }),
          projectId: input.projectId,
          ...(controlImage === undefined || input.control === undefined
            ? {}
            : { meta: { controlnet: input.control.type } }),
        })
        images.push(galleryImage)
      }
      return images
    }

    // ComfyUI: batch_size repeats the same seed, so variants are generated one by one.
    const checkpoint = pickModel(input.model, cfg.comfyModel, await backends.models('comfyui'))
    if (checkpoint === undefined) throw new Error('ComfyUI 中没有任何 checkpoint')
    const total = Math.max(1, input.batch)
    for (let index = 0; index < total; index++) {
      if (job.controller.signal.aborted) throw new Error('cancelled')
      const seed = input.seed >= 0 ? input.seed + index : Math.floor(Math.random() * 2 ** 31)
      job.message = `ComfyUI 生成中（${index + 1}/${total}，seed ${seed}）`
      const produced = await backends.comfyRun({
        graph: backends.comfyGraph({
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          width: input.width,
          height: input.height,
          steps: input.steps,
          cfgScale: input.cfgScale,
          sampler: input.sampler ?? 'dpmpp_2m',
          scheduler: 'karras',
          seed,
          batch: 1,
          checkpoint,
          rgba: input.transparent && input.transparentMethod === 'generative',
        }),
        signal: job.controller.signal,
        onProgress: (progress, message) => {
          job.progress = progress
          job.message = message
        },
      })
      for (const item of produced) {
        const saved = await saveImage(item.bytes, plan, input.category, input.name, `-${seed}`)
        let method: string | undefined
        const generative = input.transparent && input.transparentMethod === 'generative'
        if (input.transparent && !generative) {
          const result = await makeTransparent(saved.filePath, input.transparentMethod)
          method = result.method
        }
        if (input.seamless && (input.category === 'tile' || input.category === 'texture')) {
          await makeSeamless(saved.filePath)
        }
        images.push(await record(saved, {
          name: input.name,
          category: input.category,
          op: 'generate',
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          seed,
          model: checkpoint,
          backend: 'comfyui',
          width: input.width,
          height: input.height,
          steps: input.steps,
          cfgScale: input.cfgScale,
          ...(input.sampler === undefined ? {} : { sampler: input.sampler }),
          ...(method === undefined ? {} : { method }),
          ...(generative ? { method: 'layerdiffuse' } : {}),
          projectId: input.projectId,
        }))
      }
    }
    return images
  }

  /** Image-to-image, optionally masked (inpainting) and/or ControlNet-guided. */
  async function edit(input: EditInput, job: Job): Promise<GalleryImage[]> {
    const backend = await backends.resolve(input.backend)
    const source = await resolveImagePath(input.imagePath)
    const plan = await outputPlan(input.outDir)
    const initImage = await readBase64(source)
    const mask = input.maskPath === undefined ? undefined : await readBase64(await resolveImagePath(input.maskPath))
    let controlImage: string | undefined
    if (input.control !== undefined) {
      controlImage = await readBase64(await resolveImagePath(input.control.imagePath))
    }

    if (backend === 'comfyui') {
      const checkpoint = pickModel(input.model, cfg.comfyModel, await backends.models('comfyui'))
      if (checkpoint === undefined) throw new Error('ComfyUI 中没有任何 checkpoint')
      job.message = '正在上传初始图到 ComfyUI'
      const uploaded = await backends.comfyUpload(source, job.controller.signal)
      const produced = await backends.comfyRun({
        graph: backends.comfyGraph({
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          width: 0,
          height: 0,
          steps: input.steps,
          cfgScale: input.cfgScale,
          sampler: input.sampler ?? 'dpmpp_2m',
          scheduler: 'karras',
          seed: input.seed >= 0 ? input.seed : Math.floor(Math.random() * 2 ** 31),
          batch: 1,
          checkpoint,
          rgba: false,
          initImageName: uploaded,
          denoise: input.denoise,
        }),
        signal: job.controller.signal,
        onProgress: (progress, message) => {
          job.progress = progress
          job.message = message
        },
      })
      const images: GalleryImage[] = []
      for (const item of produced) {
        const saved = await saveImage(item.bytes, plan, input.category, input.name, '-edit')
        let method: string | undefined
        if (input.transparent) {
          const result = await makeTransparent(saved.filePath, 'auto')
          method = result.method
        }
        images.push(await record(saved, {
          name: input.name,
          category: input.category,
          op: 'edit',
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          model: checkpoint,
          backend: 'comfyui',
          steps: input.steps,
          cfgScale: input.cfgScale,
          ...(method === undefined ? {} : { method }),
          projectId: input.projectId,
          meta: { denoise: input.denoise, source: basename(source) },
        }))
      }
      return images
    }

    job.message = `SD WebUI 图生图（denoise ${input.denoise}）`
    const produced = await backends.sdImg2Img({
      initImage,
      ...(mask === undefined ? {} : { mask }),
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      steps: input.steps,
      cfgScale: input.cfgScale,
      denoise: input.denoise,
      ...(input.sampler === undefined ? {} : { sampler: input.sampler }),
      seed: input.seed,
      batch: input.batch,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(controlImage === undefined || input.control === undefined
        ? {}
        : { control: { image: controlImage, type: input.control.type, ...(input.control.weight === undefined ? {} : { weight: input.control.weight }) } }),
      signal: job.controller.signal,
      onProgress: (progress, message, preview) => {
        job.progress = progress
        job.message = message
        job.preview = preview
      },
    })
    const images: GalleryImage[] = []
    for (const item of produced) {
      const saved = await saveImage(item.bytes, plan, input.category, input.name, '-edit')
      let method: string | undefined
      if (input.transparent) {
        const result = await makeTransparent(saved.filePath, 'auto')
        method = result.method
      }
      images.push(await record(saved, {
        name: input.name,
        category: input.category,
        op: 'edit',
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        ...(item.seed === undefined ? {} : { seed: item.seed }),
        ...(item.model === undefined ? {} : { model: item.model }),
        backend: 'sdwebui',
        steps: input.steps,
        cfgScale: input.cfgScale,
        ...(method === undefined ? {} : { method }),
        ...(controlImage === undefined || input.control === undefined ? {} : { meta: { controlnet: input.control.type } }),
        projectId: input.projectId,
      }))
    }
    return images
  }

  /** Upscale through SD WebUI when possible, otherwise through the Python bridge. */
  async function upscale(
    input: { imagePath: string; scale: number; method: 'auto' | 'ultimate' | 'esrgan' | 'lanczos'; name: string; category: ArtCategory; projectId: string; outDir?: string },
    job: Job,
  ): Promise<GalleryImage> {
    const source = await resolveImagePath(input.imagePath)
    const plan = await outputPlan(input.outDir)
    const sourceInfo = await post.info(source).catch(() => ({}))
    const width = typeof sourceInfo.width === 'number' ? sourceInfo.width : 0
    const height = typeof sourceInfo.height === 'number' ? sourceInfo.height : 0
    const saved = await saveImage(Buffer.alloc(0), plan, input.category, input.name, `-x${input.scale}`)
    // An EXPLICIT upscale method must never silently degrade: a user who asked
    // for esrgan and quietly got a Lanczos resample has lost quality without
    // being told. Only `auto` is allowed to fall back.
    const explicit = input.method === 'esrgan' || input.method === 'ultimate'
    let fallbackReason: string | undefined

    if (input.method !== 'lanczos' && (await backends.isUp('sdwebui'))) {
      try {
        const image = await readBase64(source)
        const item = await backends.sdUpscale({
          image,
          scale: input.scale,
          signal: job.controller.signal,
          onProgress: (progress, message) => {
            job.progress = progress
            job.message = message
          },
        })
        await writeFile(saved.filePath, item.bytes)
        const refreshed = await statSafe(saved.filePath)
        if (refreshed !== undefined) saved.size = refreshed.size
        return record(saved, {
          name: input.name,
          category: input.category,
          op: 'upscale',
          backend: 'sdwebui',
          method: String(item.info?.upscaler ?? 'esrgan'),
          sourceIds: [],
          projectId: input.projectId,
          meta: {
            scale: input.scale,
            source: basename(source),
            ...(width > 0 ? { sourceWidth: width } : {}),
            ...(height > 0 ? { sourceHeight: height } : {}),
          },
        })
      } catch (error) {
        if (job.controller.signal.aborted) throw error
        if (explicit) {
          throw new Error(`SD WebUI 放大失败（method="${input.method}"）：${(error as Error).message}`)
        }
        fallbackReason = (error as Error).message
        job.message = `SD WebUI 放大失败，回退到 Lanczos：${fallbackReason.slice(0, 120)}`
      }
    } else if (explicit) {
      throw new Error(
        'SD WebUI 未运行，无法使用 esrgan/ultimate 放大。请先用 image_backend_status（action="start"）启动后端，'
        + '或改用 method="lanczos"（纯重采样，画质提升有限）。',
      )
    }

    job.message = `Lanczos 放大 ×${input.scale}`
    await post.upscale(source, saved.filePath, input.scale, 0, 0)
    const refreshed = await statSafe(saved.filePath)
    if (refreshed !== undefined) saved.size = refreshed.size
    return record(saved, {
      name: input.name,
      category: input.category,
      op: 'upscale',
      method: 'lanczos',
      projectId: input.projectId,
      meta: {
        scale: input.scale,
        source: basename(source),
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
      },
    })
  }

  /** Remove the background, producing a transparent PNG. */
  async function cutout(
    input: { imagePath: string; method: 'auto' | 'rembg' | 'chroma'; keyColor: string; tolerance: number; name: string; category: ArtCategory; projectId: string; outDir?: string },
    job: Job,
  ): Promise<GalleryImage> {
    const source = await resolveImagePath(input.imagePath)
    const plan = await outputPlan(input.outDir)
    const saved = await saveImage(Buffer.alloc(0), plan, input.category, input.name, '-cutout')
    job.message = input.method === 'chroma' ? '色键抠图中' : 'AI 抠图中（首次运行会下载 u2net 模型）'
    const result = await post.cutout(source, saved.filePath, input.method, input.keyColor, input.tolerance)
    const refreshed = await statSafe(saved.filePath)
    if (refreshed !== undefined) saved.size = refreshed.size
    return record(saved, {
      name: input.name,
      category: input.category,
      op: 'cutout',
      method: String(result.method ?? input.method),
      projectId: input.projectId,
      meta: { source: basename(source), keyColor: input.keyColor },
    })
  }

  /** Reverse-engineer a prompt from an existing image. */
  async function interrogate(
    input: { imagePath: string; model: string },
    job: Job,
  ): Promise<{ caption: string; model: string; backend: ResolvedBackend }> {
    const source = await resolveImagePath(input.imagePath)
    if (!(await backends.isUp('sdwebui'))) {
      throw new Error('反推提示词需要 SD WebUI（deepdanbooru / WD14 tagger 扩展）。请先启动 SD WebUI。')
    }
    job.message = 'SD WebUI 反推中'
    const image = await readBase64(source)
    const result = await backends.sdInterrogate({ image, model: input.model, signal: job.controller.signal })
    return { caption: result.caption, model: result.model, backend: 'sdwebui' }
  }

  return {
    generate,
    edit,
    upscale,
    cutout,
    interrogate,
    outputPlan,
    saveImage,
    resolveImagePath,
    makeTransparent,
    makeSeamless,
    jobs,
    gallery,
    cfg,
    backends,
    post,
    CATEGORY_TRANSPARENT_BY_DEFAULT,
  }
}

// ─────────────────────────── model tools ───────────────────────────

/** Wire shape of a gallery image returned by the tools. */
function imageOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string' },
      op: { type: 'string' },
      filePath: { type: 'string' },
      resPath: { type: 'string' },
      size: { type: 'number' },
      prompt: { type: 'string' },
      negativePrompt: { type: 'string' },
      seed: { type: 'number' },
      model: { type: 'string' },
      backend: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      steps: { type: 'number' },
      cfgScale: { type: 'number' },
      sampler: { type: 'string' },
      method: { type: 'string' },
      projectId: { type: 'string' },
      createdAt: { type: 'string' },
    },
    required: ['id', 'name', 'category', 'op', 'filePath', 'createdAt'],
  }
}

/** Project a gallery record onto the tool output schema (drops `meta`). */
function wireImage(image: GalleryImage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: image.id,
    name: image.name,
    category: image.category,
    op: image.op,
    filePath: image.filePath,
    createdAt: image.createdAt,
  }
  if (image.resPath !== undefined) out.resPath = image.resPath
  if (image.size !== undefined) out.size = image.size
  if (image.prompt !== undefined) out.prompt = image.prompt
  if (image.negativePrompt !== undefined) out.negativePrompt = image.negativePrompt
  if (image.seed !== undefined) out.seed = image.seed
  if (image.model !== undefined) out.model = image.model
  if (image.backend !== undefined) out.backend = image.backend
  if (image.width !== undefined) out.width = image.width
  if (image.height !== undefined) out.height = image.height
  if (image.steps !== undefined) out.steps = image.steps
  if (image.cfgScale !== undefined) out.cfgScale = image.cfgScale
  if (image.sampler !== undefined) out.sampler = image.sampler
  if (image.method !== undefined) out.method = image.method
  if (image.projectId !== undefined) out.projectId = image.projectId
  return out
}

/** One-line human summary of a produced image. */
function describeImage(image: GalleryImage): string {
  const where = image.resPath ?? image.filePath
  const extra = [
    `${image.width ?? '?'}×${image.height ?? '?'}`,
    humanSize(image.size),
    image.seed === undefined ? '' : `seed ${image.seed}`,
    image.method === undefined ? '' : image.method,
  ].filter((s) => s !== '')
  return `${image.category}/${image.name} → ${where} (${extra.join(', ')})`
}

/**
 * Register the eight `image_*` tools.
 * @param tools - the tool registry.
 * @param ops - the wired operations.
 */
function registerImageTools(tools: ToolsSurface, ops: ReturnType<typeof createOps>): void {
  const { cfg, jobs, gallery, backends, post } = ops
  const projectIdParam = { type: 'string', description: '图库归属的项目 id（可选，默认 default；与 Godot 资产管理器的项目对应）。' }

  /** Watch a tool's abort flag and cancel the matching job. */
  function watch(toolExec: { signal: { aborted: boolean } }, job: Job): () => void {
    const timer = setInterval(() => {
      if (toolExec.signal.aborted && job.status === 'running') job.controller.abort()
    }, 500)
    return () => clearInterval(timer)
  }

  async function runJob<T extends GalleryImage[]>(
    kind: Job['kind'],
    label: string,
    toolExec: { signal: { aborted: boolean } },
    work: (job: Job) => Promise<T>,
  ): Promise<T> {
    let stop: (() => void) | undefined
    try {
      return (await jobs.run(kind, label, work as (job: Job) => Promise<GalleryImage[]>, (job) => {
        stop = watch(toolExec, job)
      })) as T
    } finally {
      stop?.()
    }
  }

  /** Shared: turn tool args into a normalized generation request. */
  async function parseGenerateArgs(args: Record<string, unknown>): Promise<GenerateInput> {
    const prompt = requireString(args, 'prompt', 'prompt')
    const category = requireCategory(args)
    const defaults = CATEGORY_DEFAULTS[category]
    const transparentExplicit = optionalBoolean(args, 'transparent', 'transparent')
    const transparent = transparentExplicit
      ?? (CATEGORY_TRANSPARENT_BY_DEFAULT.includes(category) ? defaults.transparent : false)
    const seamlessExplicit = optionalBoolean(args, 'seamless', 'seamless')
    const seamless = seamlessExplicit ?? (category === 'tile' || category === 'texture')
    const controlImage = optionalString(args, 'control_image', 'control_image')
    const controlType = optionalEnum(args, 'control_type', 'control_type', Object.keys(CONTROL_PRESETS) as string[])
    return {
      prompt,
      negativePrompt: optionalString(args, 'negative_prompt', 'negative_prompt') ?? '',
      category,
      name: optionalString(args, 'name', 'name') ?? `${category}-${timestampLabel()}`,
      width: alignSize(optionalNumber(args, 'width', 'width', 64, 4096) ?? defaults.width),
      height: alignSize(optionalNumber(args, 'height', 'height', 64, 4096) ?? defaults.height),
      steps: Math.round(optionalNumber(args, 'steps', 'steps', 1, 150) ?? defaults.steps),
      cfgScale: optionalNumber(args, 'cfg_scale', 'cfg_scale', 1, 30) ?? defaults.cfgScale,
      ...(optionalString(args, 'sampler', 'sampler') === undefined ? {} : { sampler: optionalString(args, 'sampler', 'sampler') }),
      seed: Math.round(optionalNumber(args, 'seed', 'seed', -1, 2 ** 31 - 1) ?? -1),
      batch: Math.round(optionalNumber(args, 'batch', 'batch', 1, 8) ?? 1),
      ...(optionalString(args, 'model', 'model') === undefined ? {} : { model: optionalString(args, 'model', 'model') }),
      backend: optionalEnum(args, 'backend', 'backend', ['auto', 'sdwebui', 'comfyui'] as BackendId[]) ?? 'auto',
      transparent,
      transparentMethod: optionalEnum(args, 'transparent_method', 'transparent_method', ['auto', 'rembg', 'chroma', 'generative']) ?? 'auto',
      seamless,
      ...(controlImage === undefined ? {} : {
        control: {
          imagePath: controlImage,
          type: controlType ?? 'openpose',
          ...(optionalNumber(args, 'control_weight', 'control_weight', 0, 2) === undefined
            ? {}
            : { weight: optionalNumber(args, 'control_weight', 'control_weight', 0, 2) as number }),
        },
      }),
      projectId: optionalString(args, 'project_id', 'project_id') ?? 'default',
      ...(optionalString(args, 'out_dir', 'out_dir') === undefined ? {} : { outDir: optionalString(args, 'out_dir', 'out_dir') as string }),
    }
  }

  /** Shared: turn tool args into a normalized edit request. */
  async function parseEditArgs(args: Record<string, unknown>): Promise<EditInput> {
    const category = requireCategory(args)
    const defaults = CATEGORY_DEFAULTS[category]
    const controlImage = optionalString(args, 'control_image', 'control_image')
    const controlType = optionalEnum(args, 'control_type', 'control_type', Object.keys(CONTROL_PRESETS) as string[])
    const mask = optionalString(args, 'mask', 'mask')
    return {
      imagePath: requireString(args, 'image', 'image'),
      ...(mask === undefined ? {} : { maskPath: mask }),
      prompt: requireString(args, 'prompt', 'prompt'),
      negativePrompt: optionalString(args, 'negative_prompt', 'negative_prompt') ?? '',
      category,
      name: optionalString(args, 'name', 'name') ?? `${category}-edit-${timestampLabel()}`,
      steps: Math.round(optionalNumber(args, 'steps', 'steps', 1, 150) ?? defaults.steps),
      cfgScale: optionalNumber(args, 'cfg_scale', 'cfg_scale', 1, 30) ?? defaults.cfgScale,
      denoise: optionalNumber(args, 'denoise', 'denoise', 0, 1) ?? 0.6,
      ...(optionalString(args, 'sampler', 'sampler') === undefined ? {} : { sampler: optionalString(args, 'sampler', 'sampler') }),
      seed: Math.round(optionalNumber(args, 'seed', 'seed', -1, 2 ** 31 - 1) ?? -1),
      batch: Math.round(optionalNumber(args, 'batch', 'batch', 1, 8) ?? 1),
      ...(optionalString(args, 'model', 'model') === undefined ? {} : { model: optionalString(args, 'model', 'model') }),
      backend: optionalEnum(args, 'backend', 'backend', ['auto', 'sdwebui', 'comfyui'] as BackendId[]) ?? 'auto',
      transparent: optionalBoolean(args, 'transparent', 'transparent') ?? false,
      ...(controlImage === undefined ? {} : {
        control: {
          imagePath: controlImage,
          type: controlType ?? 'openpose',
          ...(optionalNumber(args, 'control_weight', 'control_weight', 0, 2) === undefined
            ? {}
            : { weight: optionalNumber(args, 'control_weight', 'control_weight', 0, 2) as number }),
        },
      }),
      projectId: optionalString(args, 'project_id', 'project_id') ?? 'default',
      ...(optionalString(args, 'out_dir', 'out_dir') === undefined ? {} : { outDir: optionalString(args, 'out_dir', 'out_dir') as string }),
    }
  }

  const generateParams: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '正向提示词。游戏美术建议参考 game-art 技能的标签式配方。' },
      negative_prompt: { type: 'string', description: '负向提示词。省略时后端使用默认质量负向词。' },
      category: { type: 'string', enum: ART_CATEGORIES, description: '美术品类；决定落盘子目录 assets/generated/<category>/、默认尺寸与默认是否透明。' },
      name: { type: 'string', description: '资产基名（用于文件名与后续注册）。省略时按品类+时间戳生成。' },
      width: { type: 'number', description: '宽（会被对齐到 64 的倍数）。默认取品类推荐值。' },
      height: { type: 'number', description: '高（会被对齐到 64 的倍数）。默认取品类推荐值。' },
      steps: { type: 'number', description: '采样步数，默认取品类推荐值。' },
      cfg_scale: { type: 'number', description: 'CFG 强度，默认取品类推荐值。' },
      sampler: { type: 'string', description: '采样器名。SD WebUI 默认 DPM++ 2M SDE；ComfyUI 默认 dpmpp_2m。' },
      seed: { type: 'number', description: '随机种子；-1（默认）表示随机。固定 seed 可复现同一张图。' },
      batch: { type: 'number', description: '生成张数（1-8，默认 1）。同一提示词的多张变体。' },
      model: { type: 'string', description: 'checkpoint 文件名。可用 image_backend_status(action="models") 查看。' },
      backend: { type: 'string', enum: ['auto', 'sdwebui', 'comfyui'], description: '指定后端；auto 优先使用默认后端并自动回落。' },
      transparent: { type: 'boolean', description: '是否要透明背景。省略时按品类默认（角色/道具/UI 为 true）。' },
      transparent_method: { type: 'string', enum: ['auto', 'rembg', 'chroma', 'generative'], description: '透明实现方式：auto=rembg（失败回落色键），chroma=色键（需纯色背景），generative=ComfyUI layerdiffuse 直出（需已下载 layerdiffuse 权重）。' },
      seamless: { type: 'boolean', description: '是否做无缝平铺后处理。省略时 tile/texture 品类默认 true。' },
      control_image: { type: 'string', description: 'ControlNet 参考图（绝对路径 / res:// / 图库 id）。用于保持姿势、线稿或结构。' },
      control_type: { type: 'string', enum: Object.keys(CONTROL_PRESETS), description: 'ControlNet 类型；需 control_image 同时给出。' },
      control_weight: { type: 'number', description: 'ControlNet 权重，默认 0.8。' },
      project_id: projectIdParam,
      out_dir: { type: 'string', description: '覆盖输出根目录（默认 Godot 项目 assets/generated 或 $DSH_HOME/imagegen-out）。' },
    },
    required: ['prompt'],
  }

  // ---- Tool 1: backend status / models / start / stop ----

  tools.register({
    name: 'image_backend_status',
    description: 'Inspect or control the local image-generation backends (SD WebUI on port 7860 and ComfyUI on port 8188, both 秋叶 integrations). action="status" reports liveness, checkpoints and capabilities; "models" lists the checkpoints to pass as the model argument; "start" launches a backend through its bundled Python and waits until it answers (1-3 minutes); "stop" only terminates an instance this plugin started. Start here before generating if you are unsure whether a backend is up.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'models', 'start', 'stop'], description: 'What to do (default status).' },
        backend: { type: 'string', enum: ['auto', 'sdwebui', 'comfyui'], description: 'Which backend (default auto: both for status/models, the default backend for start/stop).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          backends: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                port: { type: 'number' },
                root: { type: 'string' },
                running: { type: 'boolean' },
                managed: { type: 'boolean' },
                detail: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
                strengths: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'label', 'port', 'root', 'running', 'managed', 'detail', 'models', 'strengths'],
            },
          },
          postProcessing: { type: 'string' },
          outputRoot: { type: 'string' },
          godotProject: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['action', 'backends', 'postProcessing', 'outputRoot'],
      },
      render: (_args, value) => {
        const v = value as {
          action: string
          backends: Array<{ label: string; port: number; running: boolean; managed: boolean; detail: string; models: string[]; strengths: string[] }>
          postProcessing: string
          outputRoot: string
          godotProject?: string
          note?: string
        }
        const lines = v.backends.map((b) =>
          `${b.running ? '● 运行中' : '○ 未运行'} ${b.label} (:${b.port}${b.managed ? ', 由插件启动' : ''})\n    ${b.detail}` +
          (b.models.length === 0 ? '' : `\n    模型：${b.models.join(', ')}`) +
          (b.strengths.length === 0 ? '' : `\n    能力：\n      - ${b.strengths.join('\n      - ')}`))
        const extra = [
          `输出根目录：${v.outputRoot}`,
          v.godotProject === undefined ? 'Godot 项目：未配置（res:// 映射不可用）' : `Godot 项目：${v.godotProject}`,
          `后处理：${v.postProcessing}`,
          ...(v.note === undefined ? [] : [v.note]),
        ]
        return [{ type: 'text', text: `【出图后端 · ${v.action}】\n${lines.join('\n')}\n${extra.join('\n')}` }]
      },
    },
    async execute(args) {
      const action = optionalEnum(args, 'action', 'action', ['status', 'models', 'start', 'stop'] as const) ?? 'status'
      const backend = optionalEnum(args, 'backend', 'backend', ['auto', 'sdwebui', 'comfyui'] as BackendId[]) ?? 'auto'
      const note: string[] = []

      if (action === 'start' || action === 'stop') {
        const targets: ResolvedBackend[] = backend === 'auto'
          ? [cfg.defaultBackend, cfg.defaultBackend === 'sdwebui' ? 'comfyui' : 'sdwebui']
          : [backend]
        const chosen = targets[0]
        const result = action === 'start' ? await backends.launch(chosen) : await backends.shutdown(chosen)
        note.push(`${action === 'start' ? '启动' : '停止'} ${chosen}：${result.ok ? '✓' : '✗'} ${result.detail}`)
      }

      const statuses = action === 'start' || action === 'stop'
        ? [await backends.probe((optionalEnum(args, 'backend', 'backend', ['sdwebui', 'comfyui'] as ResolvedBackend[]) ?? cfg.defaultBackend))]
        : await backends.statusAll()
      const plan = await ops.outputPlan()
      return {
        action,
        backends: statuses.map((s) => ({
          id: s.id,
          label: s.label,
          port: s.port,
          root: s.root,
          running: s.running,
          managed: s.managed,
          detail: s.detail,
          models: s.models,
          strengths: s.strengths,
        })),
        postProcessing: post.reason(),
        outputRoot: plan.root,
        ...(plan.godotProject === undefined ? {} : { godotProject: plan.godotProject }),
        ...(note.length === 0 ? {} : { note: note.join('；') }),
      }
    },
  })

  // ---- Tool 2: text-to-image ----

  tools.register({
    name: 'image_generate',
    description: 'Generate a game art image locally (text-to-image) through SD WebUI or ComfyUI and save it under the Godot project as a ready-to-import asset. Pick `category` first — it sets the output subfolder, the recommended size and whether the result is transparent by default. Returns the absolute file path and, when the output lands inside the configured Godot project, a res:// path you can pass straight to godot_register_asset.',
    parameters: generateParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', items: imageOutputSchema() },
          count: { type: 'number' },
          hint: { type: 'string' },
        },
        required: ['images', 'count'],
      },
      render: (_args, value) => {
        const v = value as { images: GalleryImage[]; hint?: string }
        const lines = v.images.map((image) => `• ${describeImage(image)}`)
        const tail = v.images[0]?.resPath === undefined
          ? '\n（未落入 Godot 项目，没有 res:// 路径。可在美术工坊面板设置项目根目录后重新生成。）'
          : `\n下一步：用 godot_register_asset(asset_name, asset_type="image", file_path="${v.images[0]?.resPath}") 注册为资产。`
        return [{ type: 'text', text: `已生成 ${v.images.length} 张：\n${lines.join('\n')}${tail}${v.hint === undefined ? '' : `\n${v.hint}`}` }]
      },
    },
    async execute(args, exec) {
      const input = await parseGenerateArgs(args)
      const images = await runJob('generate', `文生图 · ${input.name}`, exec, (job) => ops.generate(input, job))
      const ranOn = images[0]?.backend
      const notes: string[] = [`后端：${ranOn ?? '?'}`]
      if (input.transparent) notes.push(`已抠成透明 PNG（${images[0]?.method ?? '?'}）`)
      if (input.seamless && (input.category === 'tile' || input.category === 'texture')) notes.push('已做无缝平铺处理')
      // Measured on this machine: the SDXL family costs ~60-77 s/step at 768²
      // on an 8 GB laptop GPU, so an 18-step image is ~20 minutes. SD1.5 is
      // roughly two orders of magnitude cheaper — worth saying out loud.
      const modelName = String(images[0]?.model ?? '')
      if (/xl|illustrious/i.test(modelName) && input.width * input.height >= 768 * 768) {
        notes.push(
          `注意：${modelName} 属 SDXL 系，本机（RTX 5060 Laptop / 8GB 显存）768×768 实测约 60–77 秒/步，`
          + `${input.steps} 步约需 ${Math.round((input.steps * 68) / 60)} 分钟。草稿阶段建议降到 ≤640×640 或改用 SD1.5（anything-v5），定稿后再用 image_upscale 放大。`,
        )
      }
      return { images: images.map(wireImage), count: images.length, hint: notes.join('；') }
    },
  })

  // ---- Tool 3: image-to-image / inpaint ----

  tools.register({
    name: 'image_edit',
    description: 'Transform an existing image (img2img / inpainting) or keep a pose/composition with ControlNet. Use this to make a character stay consistent across shots, to recolour a sprite, to paint inside a mask, or to turn a sketch into finished art. The `image` argument accepts an absolute path, a res:// path, or a gallery id returned by a previous image_* call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '源图：绝对路径、res:// 路径或图库 id。' },
        prompt: { type: 'string', description: '希望改成什么样的提示词。' },
        negative_prompt: { type: 'string', description: '负向提示词。' },
        mask: { type: 'string', description: '局部重绘蒙版（白=重绘）。与 image 同样接受三种路径形式。' },
        denoise: { type: 'number', description: '去噪强度 0-1，默认 0.6；越大改动越多，越小越贴近原图。' },
        category: { type: 'string', enum: ART_CATEGORIES, description: '美术品类（决定落盘目录与默认尺寸/透明度）。' },
        name: { type: 'string', description: '资产基名。' },
        steps: { type: 'number', description: '采样步数。' },
        cfg_scale: { type: 'number', description: 'CFG 强度。' },
        sampler: { type: 'string', description: '采样器名。' },
        seed: { type: 'number', description: '随机种子，-1 表示随机。' },
        batch: { type: 'number', description: '生成张数（1-8）。' },
        model: { type: 'string', description: 'checkpoint 文件名。' },
        backend: { type: 'string', enum: ['auto', 'sdwebui', 'comfyui'], description: '指定后端。' },
        transparent: { type: 'boolean', description: '结果是否抠成透明 PNG。' },
        control_image: { type: 'string', description: 'ControlNet 参考图。' },
        control_type: { type: 'string', enum: Object.keys(CONTROL_PRESETS), description: 'ControlNet 类型。' },
        control_weight: { type: 'number', description: 'ControlNet 权重，默认 0.8。' },
        project_id: projectIdParam,
        out_dir: { type: 'string', description: '覆盖输出根目录。' },
      },
      required: ['image', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', items: imageOutputSchema() },
          count: { type: 'number' },
        },
        required: ['images', 'count'],
      },
      render: (_args, value) => {
        const v = value as { images: GalleryImage[] }
        return [{ type: 'text', text: `编辑完成 ${v.images.length} 张：\n${v.images.map((i) => `• ${describeImage(i)}`).join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const input = await parseEditArgs(args)
      const images = await runJob('edit', `图生图 · ${input.name}`, exec, (job) => ops.edit(input, job))
      return { images: images.map(wireImage), count: images.length }
    },
  })

  // ---- Tool 4: variants ----

  tools.register({
    name: 'image_variants',
    description: 'Produce several variants of one prompt in a single call so you can pick the best composition — the game-art equivalent of a contact sheet. Same parameters as image_generate; `count` replaces `batch`. Leave seed at -1 to explore, or fix it to explore neighbouring seeds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...(generateParams.properties as Record<string, unknown>),
        count: { type: 'number', description: '变体数量（1-8，默认 4）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', items: imageOutputSchema() },
          count: { type: 'number' },
        },
        required: ['images', 'count'],
      },
      render: (_args, value) => {
        const v = value as { images: GalleryImage[] }
        return [{ type: 'text', text: `产出 ${v.images.length} 个变体：\n${v.images.map((i) => `• ${describeImage(i)}`).join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const merged: Record<string, unknown> = { ...args }
      merged.batch = Math.round(optionalNumber(args, 'count', 'count', 1, 8) ?? 4)
      const input = await parseGenerateArgs(merged)
      input.name = optionalString(args, 'name', 'name') ?? `${input.category}-variants-${timestampLabel()}`
      const images = await runJob('variants', `变体 · ${input.name}`, exec, (job) => ops.generate(input, job))
      return { images: images.map(wireImage), count: images.length }
    },
  })

  // ---- Tool 5: upscale ----

  tools.register({
    name: 'image_upscale',
    description: 'Upscale an image for use as a game asset — SD WebUI first (RealESRGAN / ESRGAN / AnimeSharp / SwinIR, the anime-tuned models), falling back to a Lanczos resample if SD WebUI is down. Use it after picking a variant: upscale 2x-4x, then import. Returns a new gallery entry; the source file is never modified.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '源图：绝对路径、res:// 路径或图库 id。' },
        scale: { type: 'number', description: '放大倍数，默认 2。' },
        method: { type: 'string', enum: ['auto', 'esrgan', 'lanczos'], description: 'auto/esrgan 走 SD WebUI 放大模型；lanczos 强制本地重采样。' },
        name: { type: 'string', description: '资产基名。' },
        category: { type: 'string', enum: ART_CATEGORIES, description: '美术品类（决定落盘目录）。' },
        project_id: projectIdParam,
        out_dir: { type: 'string', description: '覆盖输出根目录。' },
      },
      required: ['image'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: imageOutputSchema(),
          note: { type: 'string' },
        },
        required: ['image'],
      },
      render: (_args, value) => {
        const v = value as { image: GalleryImage; note?: string }
        return [{
          type: 'text',
          text: `放大完成：${describeImage(v.image)}${v.note === undefined ? '' : `\n${v.note}`}`,
        }]
      },
    },
    async execute(args, exec) {
      const category = requireCategory(args)
      const sourceName = basename(await ops.resolveImagePath(requireString(args, 'image', 'image'))).replace(/\.[^.]+$/, '')
      const payload = {
        imagePath: requireString(args, 'image', 'image'),
        scale: optionalNumber(args, 'scale', 'scale', 1, 8) ?? 2,
        method: optionalEnum(args, 'method', 'method', ['auto', 'esrgan', 'lanczos'] as const) ?? 'auto',
        name: optionalString(args, 'name', 'name') ?? `${sourceName}-x${optionalNumber(args, 'scale', 'scale', 1, 8) ?? 2}`,
        category,
        projectId: optionalString(args, 'project_id', 'project_id') ?? 'default',
        ...(optionalString(args, 'out_dir', 'out_dir') === undefined ? {} : { outDir: optionalString(args, 'out_dir', 'out_dir') as string }),
      }
      const images = await runJob('upscale', `放大 · ${payload.name}`, exec, async (job) => [await ops.upscale(payload, job)])
      const image = images[0]
      const reason = image.meta?.fallbackReason
      return {
        image: wireImage(image),
        ...(typeof reason === 'string'
          ? { note: `注意：SD WebUI 放大失败（${reason.slice(0, 160)}），已回退到 Lanczos 重采样——画质提升有限，建议排查后端后重试。` }
          : {}),
      }
    },
  })

  // ---- Tool 6: cutout ----

  tools.register({
    name: 'image_cutout',
    description: 'Remove the background and write a transparent PNG — the step that turns a generated illustration into a usable sprite, icon or UI element. method="rembg" runs a real segmentation model (u2net; the first call downloads ~176 MB), "chroma" keys out a flat background colour with Pillow (works offline, best results when the prompt asked for a plain white/black background), and "auto" tries rembg and falls back to chroma. For generative transparency straight out of the sampler, use image_generate(transparent_method="generative") on ComfyUI instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '源图：绝对路径、res:// 路径或图库 id。' },
        method: { type: 'string', enum: ['auto', 'rembg', 'chroma'], description: '抠图方式，默认 auto。' },
        key_color: { type: 'string', description: '色键颜色（method=chroma 时用），如 "#FFFFFF"。默认 #FFFFFF。' },
        tolerance: { type: 'number', description: '色键容差（0-255），默认 42。' },
        name: { type: 'string', description: '资产基名。' },
        category: { type: 'string', enum: ART_CATEGORIES, description: '美术品类（决定落盘目录）。' },
        project_id: projectIdParam,
        out_dir: { type: 'string', description: '覆盖输出根目录。' },
      },
      required: ['image'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { image: imageOutputSchema() },
        required: ['image'],
      },
      render: (_args, value) => {
        const image = (value as { image: GalleryImage }).image
        return [{ type: 'text', text: `抠图完成（${image.method ?? '?'}）：${describeImage(image)}` }]
      },
    },
    async execute(args, exec) {
      const category = requireCategory(args)
      const sourceName = basename(await ops.resolveImagePath(requireString(args, 'image', 'image'))).replace(/\.[^.]+$/, '')
      const payload = {
        imagePath: requireString(args, 'image', 'image'),
        method: optionalEnum(args, 'method', 'method', ['auto', 'rembg', 'chroma'] as const) ?? 'auto',
        keyColor: optionalString(args, 'key_color', 'key_color') ?? '#FFFFFF',
        tolerance: optionalNumber(args, 'tolerance', 'tolerance', 0, 255) ?? 42,
        name: optionalString(args, 'name', 'name') ?? `${sourceName}-cutout`,
        category,
        projectId: optionalString(args, 'project_id', 'project_id') ?? 'default',
        ...(optionalString(args, 'out_dir', 'out_dir') === undefined ? {} : { outDir: optionalString(args, 'out_dir', 'out_dir') as string }),
      }
      const images = await runJob('cutout', `抠图 · ${payload.name}`, exec, async (job) => [await ops.cutout(payload, job)])
      return { image: wireImage(images[0]) }
    },
  })

  // ---- Tool 7: interrogate ----

  tools.register({
    name: 'image_interrogate',
    description: 'Read an existing image and return the tag prompt that describes it. Two routes are tried automatically: the built-in A1111 /sdapi/v1/interrogate endpoint (deepdanbooru / CLIP) and, when that is absent, the WD14 tagger extension\'s /tagger/v1/interrogate. Use it to match an art style you already have: interrogate a reference sprite, then reuse the returned tags as the prompt base for a whole set of new assets. Note that the FIRST WD14 call downloads its ONNX model (hundreds of MB) and can take minutes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '源图：绝对路径、res:// 路径或图库 id。' },
        model: { type: 'string', description: '反推模型名。默认 deepdanbooru；也可填 WD14 模型名（如 wd14-convnextv2-v2、wd-eva02-large-tagger-v3）。' },
      },
      required: ['image'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          caption: { type: 'string' },
          model: { type: 'string' },
          backend: { type: 'string' },
        },
        required: ['caption', 'model', 'backend'],
      },
      render: (_args, value) => {
        const v = value as { caption: string; model: string; backend: string }
        return [{ type: 'text', text: `反推结果（${v.model} @ ${v.backend}）：\n${v.caption}` }]
      },
    },
    async execute(args, exec) {
      const imagePath = requireString(args, 'image', 'image')
      const model = optionalString(args, 'model', 'model') ?? 'deepdanbooru'
      let captured: { caption: string; model: string; backend: ResolvedBackend } | undefined
      await runJob('interrogate', '反推提示词', exec, async (job) => {
        captured = await ops.interrogate({ imagePath, model }, job)
        return []
      })
      const result = captured ?? { caption: '', model, backend: 'sdwebui' as ResolvedBackend }
      return { caption: result.caption, model: result.model, backend: result.backend }
    },
  })

  // ---- Tool 8: gallery ----

  tools.register({
    name: 'image_gallery',
    description: 'Browse and clean up the images this plugin has produced. action="list" returns the stored records (id, name, category, disk path, res:// path, prompt, seed, model, size); action="delete" removes one record by id (pass keep_file=true to leave the PNG on disk); action="clear" removes every record of a project. Use it to find the id or the res:// path of an earlier generation before editing, upscaling or registering it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'delete', 'clear'], description: '操作（默认 list）。' },
        id: { type: 'string', description: 'action=delete 时要删除的图库 id。' },
        category: { type: 'string', enum: ART_CATEGORIES, description: 'action=list 时按品类过滤。' },
        project_id: projectIdParam,
        keep_file: { type: 'boolean', description: 'action=delete 时是否保留磁盘文件（默认 false，会删除 PNG）。' },
        limit: { type: 'number', description: 'action=list 返回条数上限，默认 50。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          images: { type: 'array', items: imageOutputSchema() },
          removed: { type: 'number' },
        },
        required: ['action', 'images', 'removed'],
      },
      render: (_args, value) => {
        const v = value as { action: string; images: GalleryImage[]; removed: number }
        if (v.action === 'delete') return [{ type: 'text', text: `已删除 ${v.removed} 条记录。` }]
        if (v.action === 'clear') return [{ type: 'text', text: `已清空 ${v.removed} 条记录。` }]
        if (v.images.length === 0) return [{ type: 'text', text: '图库为空。' }]
        const lines = v.images.map((i) => `• [${i.id}] ${i.category}/${i.name} — ${i.resPath ?? i.filePath} (${humanSize(i.size)})`)
        return [{ type: 'text', text: `图库 ${v.images.length} 条：\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const action = optionalEnum(args, 'action', 'action', ['list', 'delete', 'clear'] as const) ?? 'list'
      const projectId = optionalString(args, 'project_id', 'project_id')
      if (action === 'delete') {
        const id = requireString(args, 'id', 'id')
        const record = await gallery.get(id)
        if (record === undefined) throw new Error(`图库中找不到记录 ${id}`)
        const removed = (await gallery.remove(id)) ? 1 : 0
        if (removed > 0 && optionalBoolean(args, 'keep_file', 'keep_file') !== true) {
          await rm(record.filePath, { force: true }).catch(() => undefined)
        }
        return { action, images: [], removed }
      }
      if (action === 'clear') {
        const doomed = await gallery.list(projectId)
        const removed = await gallery.clear(projectId)
        if (optionalBoolean(args, 'keep_file', 'keep_file') !== true) {
          for (const record of doomed) await rm(record.filePath, { force: true }).catch(() => undefined)
        }
        return { action, images: [], removed }
      }
      const category = optionalEnum(args, 'category', 'category', ART_CATEGORIES)
      const limit = Math.round(optionalNumber(args, 'limit', 'limit', 1, 500) ?? 50)
      const all = await gallery.list(projectId)
      const filtered = category === undefined ? all : all.filter((image) => image.category === category)
      return { action, images: filtered.slice(0, limit).map(wireImage), removed: 0 }
    },
  })
}

// ─────────────────────────── REST surface (/gig) ───────────────────────────

/** Wire shape of a job for the panel (never leaks the AbortController). */
function wireJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    progress: job.progress ?? null,
    message: job.message,
    preview: job.preview === undefined ? null : `data:image/png;base64,${job.preview}`,
    error: job.error ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    images: job.images.map(wireImage),
  }
}

/**
 * Register the eight model tools plus the optional `webServer` surface, and open
 * the gallery KV unit lazily.
 * @param ctx - plugin context; `tools` and `storage` are hard dependencies.
 * @param config - optional backend paths/ports; every field has a working default.
 */
export function apply(ctx: Context, config: unknown): void {
  const tools = (ctx as unknown as { tools: ToolsSurface }).tools
  const storage = (ctx as unknown as { storage: StorageSurface }).storage
  const effect = (ctx as unknown as { effect: EffectFn }).effect
  const scoped = ctx as unknown as { get?: (name: string) => unknown }
  const subprocess = typeof scoped.get === 'function'
    ? (scoped.get('subprocess') as SubprocessSurface | undefined)
    : undefined

  const cfg = resolveConfig(config)
  const post = createPostBridge(cfg, subprocess)
  const backends = createBackends(cfg, subprocess, post)
  const jobs = createJobRegistry()

  // One live handle per KV unit for the whole plugin lifetime; closed with the fiber.
  let unitPromise: Promise<KvUnit> | undefined
  let unitHandle: KvUnit | undefined
  let disposed = false
  function openUnit(): Promise<KvUnit> {
    // Once the fiber is gone a stale in-flight operation must not re-open the
    // unit: a KV unit allows exactly one live handle per backend, so reopening
    // here would collide with the replacement plugin instance's own handle.
    if (disposed) {
      throw new Error('godot-imagegen: this plugin instance was disposed; its storage unit is closed')
    }
    if (unitPromise === undefined) {
      const backend = storage.backend.get('json')
      if (backend.kv === undefined) {
        throw new Error('godot-imagegen: the "json" storage backend has no kv facet — load @deepseek-ai/storage-json')
      }
      unitPromise = backend.kv.open({
        name: cfg.unitName,
        version: 1,
        tables: [TABLE_IMAGES],
        hasGlobal: true,
      }).then((handle) => {
        unitHandle = handle
        return handle
      })
    }
    return unitPromise
  }

  const gallery = createGalleryStore(openUnit, cfg)
  const ops = createOps({ cfg, backends, post, gallery, jobs })

  registerImageTools(tools, ops)

  // Disposal must cancel in-flight work AND release the gallery unit: a KV unit
  // allows exactly one live handle per backend, so leaking it would make a later
  // re-apply (hot patch reload) fail with "unit is already open".
  effect(
    () => () => {
      disposed = true
      for (const job of jobs.list()) {
        if (job.status === 'running') job.controller.abort()
      }
      const handle = unitHandle
      const pending = unitPromise
      unitHandle = undefined
      if (handle !== undefined) void handle.close().catch(() => undefined)
      else if (pending !== undefined) void pending.then((opened) => opened.close()).catch(() => undefined)
    },
    'godot-imagegen: cancel jobs and close the gallery unit',
  )

  // The webserver may mount after plugin activation, so routes register through
  // ctx.inject (the composition-conditional pattern). Headless profiles simply
  // never run this callback and keep the plugin tool-only.
  ctx.inject(['webServer'], (scopedCtx) => {
    const webServer = (scopedCtx as unknown as { webServer: WebServerSurface }).webServer
    const sendJson = (res: HttpRes, status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    const readJsonBody = async (req: HttpReq): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return {}
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new ClientRouteError('request body must be valid JSON')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ClientRouteError('request body must be a JSON object')
      }
      return parsed as Record<string, unknown>
    }

    const handler: HttpHandler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        const method = (req.method ?? 'GET').toUpperCase()
        const pathname = url.pathname

        if (method === 'GET' && pathname === '/gig/state') {
          const [statuses, globals] = await Promise.all([backends.statusAll(), gallery.globals()])
          const plan = await ops.outputPlan()
          const images = await gallery.list()
          const counts: Record<string, number> = {}
          for (const image of images) counts[image.category] = (counts[image.category] ?? 0) + 1
          sendJson(res, 200, {
            backends: statuses,
            postProcessing: { ready: post.ready(), detail: post.reason() },
            output: { root: plan.root, godotProject: plan.godotProject ?? null },
            settings: globals.settings,
            presets: globals.presets,
            defaults: CATEGORY_DEFAULTS,
            categories: ART_CATEGORIES,
            controlTypes: Object.keys(CONTROL_PRESETS),
            gallery: { total: images.length, byCategory: counts },
          })
          return
        }

        if (method === 'GET' && pathname === '/gig/gallery') {
          // NB: searchParams.get() yields null for an absent key — keep it
          // falsy rather than coalescing to undefined, or the filters below
          // would match every record against `undefined`.
          const project = url.searchParams.get('project') || undefined
          const category = url.searchParams.get('category') || undefined
          const limit = Number(url.searchParams.get('limit') ?? '200')
          const wanted = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200
          let images = await gallery.list(project)
          if (category !== undefined) {
            images = images.filter((image) => image.category === category)
          }
          sendJson(res, 200, { images: images.slice(0, wanted), total: images.length })
          return
        }

        if (method === 'GET' && pathname === '/gig/jobs') {
          sendJson(res, 200, { jobs: jobs.list().map(wireJob) })
          return
        }

        if (method === 'GET' && pathname === '/gig/file') {
          const id = url.searchParams.get('id') ?? ''
          const record = await gallery.get(id)
          if (record === undefined) {
            sendJson(res, 404, { error: `unknown image id ${id}` })
            return
          }
          const bytes = await readFile(record.filePath)
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
          res.end(bytes)
          return
        }

        if (method === 'POST' && pathname === '/gig/backend/start') {
          const body = await readJsonBody(req)
          const which = optionalEnum(body, 'backend', 'backend', ['sdwebui', 'comfyui'] as ResolvedBackend[]) ?? cfg.defaultBackend
          const result = await backends.launch(which)
          sendJson(res, 200, result)
          return
        }

        if (method === 'POST' && pathname === '/gig/backend/stop') {
          const body = await readJsonBody(req)
          const which = optionalEnum(body, 'backend', 'backend', ['sdwebui', 'comfyui'] as ResolvedBackend[]) ?? cfg.defaultBackend
          const result = await backends.shutdown(which)
          sendJson(res, 200, result)
          return
        }

        if (method === 'POST' && pathname === '/gig/settings') {
          const body = await readJsonBody(req)
          const next = await gallery.setGlobals((current) => ({
            ...current,
            settings: {
              ...current.settings,
              ...(body.godotProject === undefined ? {} : { godotProject: String(body.godotProject) }),
              ...(body.outDir === undefined ? {} : { outDir: String(body.outDir) }),
              ...(body.defaultBackend === undefined ? {} : { defaultBackend: body.defaultBackend as BackendId }),
              ...(body.lastCategory === undefined ? {} : { lastCategory: body.lastCategory as ArtCategory }),
            },
          }))
          sendJson(res, 200, { settings: next.settings })
          return
        }

        if (method === 'POST' && pathname === '/gig/presets') {
          const body = await readJsonBody(req)
          const preset: PromptPreset = {
            id: typeof body.id === 'string' && body.id !== '' ? body.id : `preset-${randomUUID().slice(0, 8)}`,
            name: String(body.name ?? '未命名预设'),
            category: (body.category as ArtCategory) ?? 'concept',
            prompt: String(body.prompt ?? ''),
            negativePrompt: String(body.negativePrompt ?? ''),
            width: Number(body.width ?? 1024),
            height: Number(body.height ?? 1024),
            steps: Number(body.steps ?? 28),
            cfgScale: Number(body.cfgScale ?? 7),
            transparent: body.transparent === true,
          }
          const next = await gallery.setGlobals((current) => {
            const others = current.presets.filter((p) => p.id !== preset.id)
            return { ...current, presets: [...others, preset] }
          })
          sendJson(res, 200, { presets: next.presets })
          return
        }

        if (method === 'POST' && pathname === '/gig/presets/delete') {
          const body = await readJsonBody(req)
          const id = requireString(body, 'id', 'id')
          const next = await gallery.setGlobals((current) => ({
            ...current,
            presets: current.presets.filter((p) => p.id !== id || p.builtin === true),
          }))
          sendJson(res, 200, { presets: next.presets })
          return
        }

        if (method === 'POST' && pathname === '/gig/gallery/delete') {
          const body = await readJsonBody(req)
          const id = requireString(body, 'id', 'id')
          const record = await gallery.get(id)
          if (record === undefined) throw new ClientRouteError(`unknown image id ${id}`)
          await gallery.remove(id)
          if (body.keepFile !== true) await rm(record.filePath, { force: true }).catch(() => undefined)
          sendJson(res, 200, { ok: true })
          return
        }

        if (method === 'POST' && pathname === '/gig/gallery/clear') {
          const body = await readJsonBody(req)
          const project = typeof body.project === 'string' && body.project !== '' ? body.project : undefined
          const doomed = await gallery.list(project)
          const removed = await gallery.clear(project)
          if (body.keepFile !== true) {
            for (const record of doomed) await rm(record.filePath, { force: true }).catch(() => undefined)
          }
          sendJson(res, 200, { removed })
          return
        }

        if (method === 'POST' && pathname === '/gig/jobs/cancel') {
          const body = await readJsonBody(req)
          const id = requireString(body, 'id', 'id')
          sendJson(res, 200, { ok: jobs.cancel(id) })
          return
        }

        // Fire-and-forget job routes: the panel polls /gig/jobs for progress.
        if (method === 'POST' && pathname === '/gig/generate') {
          const body = await readJsonBody(req)
          const input = await parseGenerateBody(body)
          const job = jobs.start(
            body.count === undefined ? 'generate' : 'variants',
            `文生图 · ${input.name}`,
            (j) => ops.generate(input, j),
          )
          sendJson(res, 200, { jobId: job.id })
          return
        }

        if (method === 'POST' && pathname === '/gig/edit') {
          const body = await readJsonBody(req)
          const input = await parseEditBody(body)
          const job = jobs.start('edit', `图生图 · ${input.name}`, (j) => ops.edit(input, j))
          sendJson(res, 200, { jobId: job.id })
          return
        }

        if (method === 'POST' && pathname === '/gig/upscale') {
          const body = await readJsonBody(req)
          const payload = {
            imagePath: requireString(body, 'image', 'image'),
            scale: optionalNumber(body, 'scale', 'scale', 1, 8) ?? 2,
            method: optionalEnum(body, 'method', 'method', ['auto', 'ultimate', 'esrgan', 'lanczos'] as const) ?? 'auto',
            name: optionalString(body, 'name', 'name') ?? `upscale-${timestampLabel()}`,
            category: requireCategory(body),
            projectId: optionalString(body, 'projectId', 'projectId') ?? 'default',
          }
          const job = jobs.start('upscale', `放大 · ${payload.name}`, async (j) => [await ops.upscale(payload, j)])
          sendJson(res, 200, { jobId: job.id })
          return
        }

        if (method === 'POST' && pathname === '/gig/cutout') {
          const body = await readJsonBody(req)
          const payload = {
            imagePath: requireString(body, 'image', 'image'),
            method: optionalEnum(body, 'method', 'method', ['auto', 'rembg', 'chroma'] as const) ?? 'auto',
            keyColor: optionalString(body, 'keyColor', 'keyColor') ?? '#FFFFFF',
            tolerance: optionalNumber(body, 'tolerance', 'tolerance', 0, 255) ?? 42,
            name: optionalString(body, 'name', 'name') ?? `cutout-${timestampLabel()}`,
            category: requireCategory(body),
            projectId: optionalString(body, 'projectId', 'projectId') ?? 'default',
          }
          const job = jobs.start('cutout', `抠图 · ${payload.name}`, async (j) => [await ops.cutout(payload, j)])
          sendJson(res, 200, { jobId: job.id })
          return
        }

        if (method === 'POST' && pathname === '/gig/interrogate') {
          const body = await readJsonBody(req)
          const job = jobs.start('interrogate', '反推提示词', async (j) => {
            const result = await ops.interrogate({
              imagePath: requireString(body, 'image', 'image'),
              model: optionalString(body, 'model', 'model') ?? 'deepdanbooru',
            }, j)
            j.message = result.caption
            return []
          })
          sendJson(res, 200, { jobId: job.id })
          return
        }

        sendJson(res, 404, { error: `unknown route ${method} ${pathname}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const clientError = error instanceof ClientRouteError
          || message.startsWith('image_')
          || message.startsWith('godot-imagegen:')
          || message.includes('must be')
          || message.includes('body')
          || message.includes('unknown image id')
        sendJson(res, clientError ? 400 : 500, { error: message })
      }
    }

    effect(
      () => webServer.register({ kind: 'prefix', path: '/gig', handler }),
      'godot-imagegen: REST routes',
    )
  })

  /** REST body → generation input (mirrors the tool parser but with camelCase fields). */
  async function parseGenerateBody(body: Record<string, unknown>): Promise<GenerateInput> {
    const category = requireCategory(body)
    const defaults = CATEGORY_DEFAULTS[category]
    const transparentExplicit = optionalBoolean(body, 'transparent', 'transparent')
    const seamlessExplicit = optionalBoolean(body, 'seamless', 'seamless')
    const controlImage = optionalString(body, 'controlImage', 'controlImage')
    const count = optionalNumber(body, 'count', 'count', 1, 8)
    return {
      prompt: requireString(body, 'prompt', 'prompt'),
      negativePrompt: optionalString(body, 'negativePrompt', 'negativePrompt') ?? '',
      category,
      name: optionalString(body, 'name', 'name') ?? `${category}-${timestampLabel()}`,
      width: alignSize(optionalNumber(body, 'width', 'width', 64, 4096) ?? defaults.width),
      height: alignSize(optionalNumber(body, 'height', 'height', 64, 4096) ?? defaults.height),
      steps: Math.round(optionalNumber(body, 'steps', 'steps', 1, 150) ?? defaults.steps),
      cfgScale: optionalNumber(body, 'cfgScale', 'cfgScale', 1, 30) ?? defaults.cfgScale,
      ...(optionalString(body, 'sampler', 'sampler') === undefined ? {} : { sampler: optionalString(body, 'sampler', 'sampler') }),
      seed: Math.round(optionalNumber(body, 'seed', 'seed', -1, 2 ** 31 - 1) ?? -1),
      batch: Math.round(count ?? optionalNumber(body, 'batch', 'batch', 1, 8) ?? 1),
      ...(optionalString(body, 'model', 'model') === undefined ? {} : { model: optionalString(body, 'model', 'model') }),
      backend: optionalEnum(body, 'backend', 'backend', ['auto', 'sdwebui', 'comfyui'] as BackendId[]) ?? 'auto',
      transparent: transparentExplicit ?? CATEGORY_TRANSPARENT_BY_DEFAULT.includes(category),
      transparentMethod: optionalEnum(body, 'transparentMethod', 'transparentMethod', ['auto', 'rembg', 'chroma', 'generative']) ?? 'auto',
      seamless: seamlessExplicit ?? (category === 'tile' || category === 'texture'),
      ...(controlImage === undefined ? {} : {
        control: {
          imagePath: controlImage,
          type: optionalEnum(body, 'controlType', 'controlType', Object.keys(CONTROL_PRESETS) as string[]) ?? 'openpose',
          ...(optionalNumber(body, 'controlWeight', 'controlWeight', 0, 2) === undefined
            ? {}
            : { weight: optionalNumber(body, 'controlWeight', 'controlWeight', 0, 2) as number }),
        },
      }),
      projectId: optionalString(body, 'projectId', 'projectId') ?? 'default',
      ...(optionalString(body, 'outDir', 'outDir') === undefined ? {} : { outDir: optionalString(body, 'outDir', 'outDir') as string }),
    }
  }

  /** REST body → edit input. */
  async function parseEditBody(body: Record<string, unknown>): Promise<EditInput> {
    const category = requireCategory(body)
    const defaults = CATEGORY_DEFAULTS[category]
    const controlImage = optionalString(body, 'controlImage', 'controlImage')
    const mask = optionalString(body, 'mask', 'mask')
    return {
      imagePath: requireString(body, 'image', 'image'),
      ...(mask === undefined ? {} : { maskPath: mask }),
      prompt: requireString(body, 'prompt', 'prompt'),
      negativePrompt: optionalString(body, 'negativePrompt', 'negativePrompt') ?? '',
      category,
      name: optionalString(body, 'name', 'name') ?? `${category}-edit-${timestampLabel()}`,
      steps: Math.round(optionalNumber(body, 'steps', 'steps', 1, 150) ?? defaults.steps),
      cfgScale: optionalNumber(body, 'cfgScale', 'cfgScale', 1, 30) ?? defaults.cfgScale,
      denoise: optionalNumber(body, 'denoise', 'denoise', 0, 1) ?? 0.6,
      ...(optionalString(body, 'sampler', 'sampler') === undefined ? {} : { sampler: optionalString(body, 'sampler', 'sampler') }),
      seed: Math.round(optionalNumber(body, 'seed', 'seed', -1, 2 ** 31 - 1) ?? -1),
      batch: Math.round(optionalNumber(body, 'batch', 'batch', 1, 8) ?? 1),
      ...(optionalString(body, 'model', 'model') === undefined ? {} : { model: optionalString(body, 'model', 'model') }),
      backend: optionalEnum(body, 'backend', 'backend', ['auto', 'sdwebui', 'comfyui'] as BackendId[]) ?? 'auto',
      transparent: optionalBoolean(body, 'transparent', 'transparent') ?? false,
      ...(controlImage === undefined ? {} : {
        control: {
          imagePath: controlImage,
          type: optionalEnum(body, 'controlType', 'controlType', Object.keys(CONTROL_PRESETS) as string[]) ?? 'openpose',
          ...(optionalNumber(body, 'controlWeight', 'controlWeight', 0, 2) === undefined
            ? {}
            : { weight: optionalNumber(body, 'controlWeight', 'controlWeight', 0, 2) as number }),
        },
      }),
      projectId: optionalString(body, 'projectId', 'projectId') ?? 'default',
      ...(optionalString(body, 'outDir', 'outDir') === undefined ? {} : { outDir: optionalString(body, 'outDir', 'outDir') as string }),
    }
  }
}






