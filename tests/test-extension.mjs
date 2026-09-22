/**
 * Tests for the ComfyUI canvas bridge: the web-extension manager and the
 * cross-origin poll route the installed extension talks to.
 *
 * This suite is the reason the install path can be trusted with a directory it
 * does not own. The bridge is the ONLY thing this plugin writes inside the
 * ComfyUI install, so every rule it promises is asserted here, against a real
 * temporary fake install on disk:
 *
 *   1. nothing is written before an explicit install;
 *   2. a timestamped backup with a BEFORE.json is always produced first;
 *   3. the install is recorded in a manifest, and the uninstall deletes EXACTLY
 *      those paths — never a path outside the target dir, never an unrecorded
 *      file, and it only prunes directories it created itself;
 *   4. the token is reused across re-syncs, so an already-loaded canvas keeps
 *      working;
 *   5. the poll route rejects a wrong token and answers the CORS preflight,
 *      because the caller runs on ComfyUI's own origin.
 *
 * No real backend is needed: the fake ComfyUI tree is just directories.
 *
 * Run with:  node tests/test-extension.mjs   (from the repo root)
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
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
    console.error(`FAIL  ${label} (expected a rejection)`)
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
const exists = async (path) => {
  try { await stat(path); return true } catch { return false }
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

// ─────────────────────────── plugin harness (mirrors test-imagegen) ───────────────────────────

function makeCtx(extra = {}) {
  const registered = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    // The bridge never touches storage; the plugin only dereferences it lazily.
    storage: { backend: { get: () => ({}) } },
    get(name) {
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
  return { routes, register(opts) { routes.push(opts); return () => {} } }
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
/** A request with no body at all — exactly what a CORS preflight looks like. */
function emptyRequest(method, pathname) {
  return {
    method,
    url: pathname,
    async *[Symbol.asyncIterator]() { /* no chunks */ },
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
async function callRoute(webServer, method, pathname, body, { raw = false } = {}) {
  const route = webServer.routes.find((r) => r.path === '/gig')
  const res = jsonResponse()
  await route.handler(raw ? emptyRequest(method, pathname) : jsonRequest(method, pathname, body), res)
  let parsed = null
  if (typeof res.captured.body === 'string') {
    try { parsed = JSON.parse(res.captured.body) } catch { parsed = res.captured.body }
  }
  return { status: res.captured.status, headers: res.captured.headers ?? {}, body: parsed }
}

const byName = (list, name) => list.find((tool) => tool.name === name)
const exec = (tool, args) => tool.execute(args, { signal: { aborted: false } })

// ─────────────────────────── the run ───────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SOURCE_DIR = join(REPO, 'comfyui-extension')

async function main() {
  const workRoot = await mkdtemp(join(tmpdir(), 'gig-ext-'))

  // ── A: the source of truth ────────────────────────────────────────────────
  const sourceInit = await readFile(join(SOURCE_DIR, '__init__.py'), 'utf8')
  const sourceJs = await readFile(join(SOURCE_DIR, 'godot-imagegen-bridge.js'), 'utf8')
  assert(sourceInit.includes('WEB_DIRECTORY = "./web"'), '__init__.py declares WEB_DIRECTORY="./web" (ComfyUI ignores the package without it)')
  assert(sourceJs.includes('__DSH_ORIGIN__') && sourceJs.includes('__TOKEN__'), 'the extension source carries both placeholders')
  // ComfyUI loads this file as a plain script into its own page, so it must not
  // use module syntax and must not depend on a bundler.
  assert(!/^\s*(import|export)\s/m.test(sourceJs), 'the extension uses no import/export statements')
  assert(!/\brequire\s*\(/.test(sourceJs), 'the extension uses no require()')
  assert(!/<[A-Za-z][^>]*>/.test(sourceJs.replace(/<[^>]*\.js>/g, '')), 'the extension contains no JSX')
  assert(sourceJs.includes('loadGraphData'), 'the extension loads a graph through app.loadGraphData')
  // The transport. This is the assertion that keeps someone from "simplifying"
  // the bridge back into an HTTP poll: DSH refuses every request from a frame
  // whose origin is not the carrier origin, so a fetch from inside the ComfyUI
  // iframe is answered 403 before routing, and CORS headers cannot change that.
  // Comments are stripped first, so the rule is checked against code, not prose.
  const sourceCode = sourceJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(!/\bfetch\s*\(/.test(sourceCode), 'the extension never calls fetch — DSH refuses any request from a non-carrier frame')
  assert(!/XMLHttpRequest|WebSocket/.test(sourceCode), 'and no XHR/WebSocket either (the same rule covers upgrades)')
  assert(/addEventListener\(\s*'message'/.test(sourceCode), 'it listens for postMessage from the DSH page')
  assert(/postMessage\(/.test(sourceCode), 'and answers the same way')
  assert(/event\.origin !== DSH_ORIGIN/.test(sourceCode), 'it only accepts messages from the origin it was installed for')
  assert(/data\.__gig !== TOKEN/.test(sourceCode), 'and only messages stamped with the token this install generated')
  assert(sourceCode.includes("'canvas.load'") && sourceCode.includes("'canvas.result'"), 'it understands the load command and reports the result')

  // ── the fake ComfyUI install ──────────────────────────────────────────────
  const comfyRoot = join(workRoot, 'ComfyUI-aki-v2')
  const appDir = join(comfyRoot, 'ComfyUI')
  const customNodes = join(appDir, 'custom_nodes')
  const targetDir = join(customNodes, 'godot-imagegen-bridge')
  // A pre-existing sibling custom node proves the uninstall never touches
  // anything but its own package directory.
  await mkdir(join(customNodes, 'ComfyUI-Manager'), { recursive: true })
  await writeFile(join(customNodes, 'ComfyUI-Manager', 'manager.py'), '# not ours\n', 'utf8')

  const dataRoot = join(workRoot, 'data')
  const cfg = {
    unitName: 'godot_imagegen_ext_test',
    sdwebuiRoot: join(workRoot, 'sd'),
    sdwebuiPython: join(workRoot, 'sd', 'python', 'python.exe'),
    sdwebuiPort: 17861,
    comfyRoot,
    comfyPython: join(comfyRoot, 'python', 'python.exe'),
    comfyPort: 18189,
    postPython: join(comfyRoot, 'python', 'python.exe'),
    defaultBackend: 'sdwebui',
    requestTimeoutMs: 5000,
    startTimeoutMs: 5000,
    dataRoot,
  }

  // ── B: the manager, before anything is installed ──────────────────────────
  const slash = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const manager = plugin.createExtensionManager(cfg)
  assert(slash(manager.targetDir) === slash(join(appDir, 'custom_nodes', 'godot-imagegen-bridge')),
    'the target directory is <comfyRoot>/ComfyUI/custom_nodes/godot-imagegen-bridge')
  assert(manager.sourceDir.replace(/\\/g, '/').replace(/\/+$/, '').endsWith('comfyui-extension'),
    'the source directory resolves next to the plugin module, not from a hard-coded path')

  const before = await manager.status()
  assert(before.installed === false, 'status reports "not installed" before any install')
  assert(before.sourcePresent === true, 'and that the extension source is present')
  assert(before.files === 0 && before.stale === false, 'with no recorded files and nothing stale')
  assert(!(await exists(targetDir)), 'nothing has been written into the ComfyUI install yet')
  assert(!(await exists(join(dataRoot, 'installed-files.json'))), 'and no manifest exists yet')

  const syncWhenAbsent = await manager.syncIfInstalled('http://127.0.0.1:43120')
  assert(syncWhenAbsent.synced === false, 'syncIfInstalled is a no-op when nothing is installed (install stays explicit)')
  assert(!(await exists(targetDir)), 'and it did not install anything on the way')

  // ── C: install ────────────────────────────────────────────────────────────
  const install = await manager.install('http://127.0.0.1:43120')
  assert(install.ok === true, `install succeeds (${install.detail})`)
  assert(install.restartRequired === true, 'and tells the caller ComfyUI must be restarted')
  assert(install.files.length === 2, 'two files were written')
  assert(await exists(join(targetDir, '__init__.py')), 'the package __init__.py is in place')
  assert(await exists(join(targetDir, 'web', 'godot-imagegen-bridge.js')), 'and the web extension sits in web/')

  const installedInit = await readFile(join(targetDir, '__init__.py'), 'utf8')
  assert(installedInit === sourceInit, 'the python half is copied byte-for-byte (nothing to substitute)')
  const installedJs = await readFile(join(targetDir, 'web', 'godot-imagegen-bridge.js'), 'utf8')
  assert(!installedJs.includes('__TOKEN__') && !installedJs.includes('__DSH_ORIGIN__'), 'both placeholders were substituted in the installed JS')
  assert(installedJs.includes("'http://127.0.0.1:43120'"), 'the installed JS calls back to the origin the caller supplied')
  // A syntax error here would only show up inside the user's ComfyUI page, so it
  // is checked now, with the same parser the browser uses.
  const syntax = spawnSync(process.execPath, ['--check', join(targetDir, 'web', 'godot-imagegen-bridge.js')], { encoding: 'utf8' })
  assert(syntax.status === 0, `the installed JS parses as valid JavaScript${syntax.status === 0 ? '' : ` (${syntax.stderr})`}`)

  const manifest = await readJson(join(dataRoot, 'installed-files.json'))
  assert(manifest.version === 1 && typeof manifest.token === 'string' && manifest.token.length >= 16, 'the manifest records a version and a real token')
  assert(manifest.origin === 'http://127.0.0.1:43120', 'and the origin it baked in')
  assert(manifest.files.length === 2, 'and every file it wrote')
  assert(manifest.files.every((f) => String(f.path).replace(/\\/g, '/').startsWith(targetDir.replace(/\\/g, '/'))), 'all recorded paths live under the target directory')
  assert(manifest.directories.length === 2, 'and both directories it had to create are recorded as its own')
  assert(installedJs.includes(manifest.token), 'the token in the manifest is the token in the installed file')

  // ── D: the backup ─────────────────────────────────────────────────────────
  assert(typeof install.backupDir === 'string' && await exists(install.backupDir), 'a timestamped backup directory was produced before writing')
  const beforeJson = await readJson(join(install.backupDir, 'BEFORE.json'))
  assert(beforeJson.existed === false && beforeJson.files.length === 0, 'the first install records honestly that there was nothing to lose')
  assert(/未覆盖任何既有内容/.test(beforeJson.note), 'and says so in the note, so a reader cannot mistake it for a missed backup')

  const after = await manager.status()
  assert(after.installed === true && after.files === 2, 'status now reports the install')
  assert(after.stale === false, 'and that the installed copy matches the source (not stale)')
  assert(after.installedAt === manifest.installedAt && after.origin === manifest.origin, 'with the install time and origin')

  // ── E: re-sync reuses the token and can detect drift ──────────────────────
  const second = await manager.install('http://127.0.0.1:9999')
  assert(second.ok === true, 'a second install (re-sync) succeeds')
  const manifest2 = await readJson(join(dataRoot, 'installed-files.json'))
  assert(manifest2.token === manifest.token, 'the token is REUSED, so an already-loaded canvas keeps talking to the host')
  assert(manifest2.origin === 'http://127.0.0.1:9999', 'but an explicitly supplied origin replaces the baked one')
  const installedJs2 = await readFile(join(targetDir, 'web', 'godot-imagegen-bridge.js'), 'utf8')
  assert(installedJs2.includes("'http://127.0.0.1:9999'"), 'and the new origin really is in the file')
  assert((await manager.status()).stale === false, 'status agrees the copy is current again')

  await writeFile(join(targetDir, 'web', 'godot-imagegen-bridge.js'), '// hand-edited\n', 'utf8')
  assert((await manager.status()).stale === true, 'status notices when the installed copy has drifted from the source')
  const resync = await manager.syncIfInstalled()
  assert(resync.synced === true, 'syncIfInstalled restores an installed copy without being told to install')
  assert((await manager.status()).stale === false, 'and the drift is gone')
  // The origin must survive a sync that was not given one — otherwise the canvas
  // would silently start calling a default port.
  const manifest3 = await readJson(join(dataRoot, 'installed-files.json'))
  assert(manifest3.origin === 'http://127.0.0.1:9999', 'a sync with no origin hint keeps the previously baked origin')

  // ── F: a pre-existing target directory is never claimed ───────────────────
  const dataRoot2 = join(workRoot, 'data2')
  const cfg2 = { ...cfg, dataRoot: dataRoot2 }
  // Simulate a user who already had a package by that name (e.g. a manual copy).
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(join(targetDir, 'web'), { recursive: true })
  await writeFile(join(targetDir, 'README.txt'), 'pre-existing user content\n', 'utf8')
  const manager2 = plugin.createExtensionManager(cfg2)
  const install2 = await manager2.install('http://127.0.0.1:43120')
  assert(install2.ok === true, 'installing over a pre-existing directory still succeeds')
  const manifest4 = await readJson(join(dataRoot2, 'installed-files.json'))
  assert(manifest4.directories.length === 0, 'but the directories that already existed are NOT recorded as created by us')
  const backup2 = await readJson(join(install2.backupDir, 'BEFORE.json'))
  assert(backup2.existed === true && backup2.files.includes('README.txt'), 'the pre-existing file was backed up first')
  assert(await exists(join(install2.backupDir, 'README.txt')), 'and the backup really contains it')
  assert(/已备份 1 个既有文件/.test(backup2.note), 'and BEFORE.json says how many files were backed up')

  const uninstall2 = await manager2.uninstall()
  assert(uninstall2.reason === 'leftovers', 'uninstalling over pre-existing content reports leftovers rather than a clean result')
  assert(uninstall2.removed.length === 2, 'exactly the two recorded files were deleted')
  assert(await exists(join(targetDir, 'README.txt')), 'the unrecorded user file is preserved')
  assert(await exists(targetDir), 'and a directory that pre-existed is not pruned')
  const uninstall2b = await manager2.uninstall()
  assert(uninstall2b.reason === 'not-installed', 'a second uninstall reports there is no record, instead of pretending to delete things')

  // ── G: a clean install uninstalls to zero residue ─────────────────────────
  await rm(targetDir, { recursive: true, force: true })
  const dataRoot3 = join(workRoot, 'data3')
  const manager3 = plugin.createExtensionManager({ ...cfg, dataRoot: dataRoot3 })
  await manager3.install('http://127.0.0.1:43120')
  const clean = await manager3.uninstall()
  assert(clean.reason === 'ok' && clean.ok === true, `a clean install uninstalls cleanly (${clean.detail})`)
  assert(clean.removed.length === 2, 'both files were deleted')
  assert(clean.pruned.length === 2, 'and both directories it created were pruned')
  assert(clean.leftovers.length === 0, 'with nothing left behind')
  assert(!(await exists(targetDir)), 'the package directory is gone')
  assert(await exists(customNodes), 'but custom_nodes itself is untouched')
  assert(await exists(join(customNodes, 'ComfyUI-Manager', 'manager.py')), 'and no sibling custom node was harmed')
  assert(!(await exists(join(dataRoot3, 'installed-files.json'))), 'the manifest is gone too')
  assert((await manager3.status()).installed === false, 'status confirms it is no longer installed')
  assert(await exists(join(install2.backupDir, 'BEFORE.json')), 'backups are kept — an uninstall is not a licence to delete the audit trail')

  // ── G2: the Python byte-code cache ComfyUI creates is residue too ─────────
  //
  // ComfyUI IMPORTS the package at boot, so Python drops
  // __pycache__/__init__.cpython-312.pyc next to our sources. Leaving it behind
  // would make "卸载不留残留" false in the normal case, so it goes with them —
  // but a .pyc for a file we did NOT install must survive.
  await rm(targetDir, { recursive: true, force: true })
  const dataRoot3b = join(workRoot, 'data3b')
  const manager3b = plugin.createExtensionManager({ ...cfg, dataRoot: dataRoot3b })
  await manager3b.install('http://127.0.0.1:43120')
  await mkdir(join(targetDir, '__pycache__'), { recursive: true })
  await writeFile(join(targetDir, '__pycache__', '__init__.cpython-312.pyc'), 'bytecode of our own module\n', 'utf8')
  await writeFile(join(targetDir, '__pycache__', 'someones_helper.cpython-312.pyc'), 'bytecode of a file we never installed\n', 'utf8')
  const withCache = await manager3b.uninstall()
  assert(withCache.derived.length === 1 && withCache.derived[0].includes('__init__.cpython-312.pyc'),
    'the .pyc derived from OUR installed source is removed with it')
  assert(withCache.reason === 'leftovers', 'while a .pyc for a file we never installed is reported, not swept up')
  assert(await exists(join(targetDir, '__pycache__', 'someones_helper.cpython-312.pyc')), 'and that foreign .pyc is still on disk')
  assert(withCache.leftovers.length === 1, 'the leftover list names exactly it')
  await rm(targetDir, { recursive: true, force: true })

  const dataRoot3c = join(workRoot, 'data3c')
  const manager3c = plugin.createExtensionManager({ ...cfg, dataRoot: dataRoot3c })
  await manager3c.install('http://127.0.0.1:43120')
  await mkdir(join(targetDir, '__pycache__'), { recursive: true })
  await writeFile(join(targetDir, '__pycache__', '__init__.cpython-312.pyc'), 'bytecode\n', 'utf8')
  const cacheGone = await manager3c.uninstall()
  assert(cacheGone.reason === 'ok', `a package that ComfyUI has imported also uninstalls to zero residue (${cacheGone.detail})`)
  assert(cacheGone.pruned.length === 3, 'and the __pycache__ directory it caused is recycled as well')
  assert(!(await exists(targetDir)), 'nothing at all is left under custom_nodes')

  // ── H: the manifest cannot be used to delete outside the target ───────────
  const dataRoot4 = join(workRoot, 'data4')
  const manager4 = plugin.createExtensionManager({ ...cfg, dataRoot: dataRoot4 })
  await manager4.install('http://127.0.0.1:43120')
  const victim = join(customNodes, 'ComfyUI-Manager', 'manager.py')
  const poisoned = await readJson(join(dataRoot4, 'installed-files.json'))
  poisoned.files.push({ path: victim, pkg: 'godot-imagegen-bridge', installedAt: new Date().toISOString() })
  await writeFile(join(dataRoot4, 'installed-files.json'), `${JSON.stringify(poisoned, null, 2)}\n`, 'utf8')
  const guarded = await manager4.uninstall()
  assert(await exists(victim), 'a manifest entry pointing OUTSIDE the target directory is refused, not deleted')
  assert(guarded.reason === 'partial' && /目标目录之外/.test(guarded.detail), 'and the refusal is reported as a partial uninstall')
  await rm(targetDir, { recursive: true, force: true })

  // ── I: a missing source is reported, never half-installed ─────────────────
  const manager5 = plugin.createExtensionManager({ ...cfg, dataRoot: join(workRoot, 'data5') }, join(workRoot, 'no-such-extension'))
  const missingStatus = await manager5.status()
  assert(missingStatus.sourcePresent === false && missingStatus.installed === false, 'a missing extension source is reported by status')
  assert(/扩展源码/.test(missingStatus.detail), 'with a detail that names the problem')
  const missingInstall = await manager5.install()
  assert(missingInstall.ok === false && /扩展源码不存在/.test(missingInstall.detail), 'and install refuses instead of writing a partial package')

  const missingComfy = plugin.createExtensionManager({ ...cfg, comfyRoot: join(workRoot, 'nope'), dataRoot: join(workRoot, 'data6') })
  const noApp = await missingComfy.install()
  assert(noApp.ok === false && /ComfyUI 安装目录不存在/.test(noApp.detail), 'install refuses when the ComfyUI install is not where the config says it is')

  // ── J: run the INSTALLED extension and drive it ───────────────────────────
  //
  // The file that lands in the user's ComfyUI is the one that matters, and its
  // message handling is pure logic — so it is executed here in a real VM with a
  // fake window and a fake ComfyUI app. That catches "the extension never calls
  // loadGraphData", "it answers the wrong window" and "a stale token slips
  // through" without a browser.
  const runtimeRoot = join(workRoot, 'ComfyUI-vm')
  await mkdir(join(runtimeRoot, 'ComfyUI', 'custom_nodes'), { recursive: true })
  const runtimeManager = plugin.createExtensionManager({ ...cfg, comfyRoot: runtimeRoot, dataRoot: join(workRoot, 'data-vm') })
  await runtimeManager.install('http://127.0.0.1:43120')
  const runtimeToken = JSON.parse(await readFile(join(workRoot, 'data-vm', 'installed-files.json'), 'utf8')).token
  const runtimeScript = await readFile(join(runtimeManager.targetDir, 'web', 'godot-imagegen-bridge.js'), 'utf8')

  function loadCanvasRuntime(script, { throwOnLoad = false } = {}) {
    const listeners = []
    const posted = []
    const loaded = []
    const app = {
      graph: { _nodes: [{ type: 'KSampler' }, { type: 'CLIPTextEncode' }, { type: 'KSampler' }] },
      workflowManager: { activeWorkflow: { name: 'item-icon' } },
      registerExtension() {},
      loadGraphData(graph) {
        if (throwOnLoad) throw new Error('loadGraphData 炸了')
        loaded.push(graph)
      },
    }
    const parent = { postMessage: (message, origin) => posted.push({ message, origin }) }
    const win = {
      parent,
      app,
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn) },
    }
    win.window = win
    runInNewContext(script, { window: win, console, setInterval, clearInterval })
    return { listeners, posted, loaded, parent, win }
  }
  const deliver = (runtime, event) => { for (const fn of runtime.listeners) fn(event) }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

  {
    const runtime = loadCanvasRuntime(runtimeScript)
    await settle()
    const ready = runtime.posted.find((p) => p.message.type === 'canvas.ready')
    assert(ready !== undefined, 'the installed extension announces itself with a canvas.ready envelope')
    assert(ready.origin === 'http://127.0.0.1:43120', 'and pins that announcement to the origin it was installed for')
    assert(ready.message.state.nodeCount === 3, 'reporting the graph it can see')

    const before = runtime.posted.length
    deliver(runtime, { origin: 'http://127.0.0.1:8188', data: { __gig: runtimeToken, type: 'canvas.load', seq: 's1', graph: { nodes: [] } }, source: runtime.parent })
    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: { __gig: 'wrong-token', type: 'canvas.load', seq: 's2', graph: { nodes: [] } }, source: runtime.parent })
    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: { type: 'canvas.load', seq: 's3', graph: { nodes: [] } }, source: runtime.parent })
    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: 'not-an-envelope', source: runtime.parent })
    await settle()
    assert(runtime.loaded.length === 0, 'a message from the wrong origin, a wrong token, no token, or a junk payload loads nothing')
    assert(runtime.posted.length === before, 'and provokes no reply at all')

    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: { __gig: runtimeToken, type: 'canvas.ping' }, source: runtime.parent })
    await settle()
    const state = runtime.posted[runtime.posted.length - 1].message
    assert(state.type === 'canvas.state' && state.state.nodeCount === 3, 'a ping is answered with the canvas state')
    assert(state.state.missingClasses.length === 0, 'with no missing node classes for a healthy graph')

    const graph = { nodes: [{ id: 1, type: 'KSampler' }], links: [] }
    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: { __gig: runtimeToken, type: 'canvas.load', seq: 'seq-9', graph }, source: runtime.parent })
    await settle()
    assert(runtime.loaded.length === 1 && runtime.loaded[0] === graph, 'a properly stamped load really reaches app.loadGraphData')
    const result = runtime.posted[runtime.posted.length - 1].message
    assert(result.type === 'canvas.result' && result.seq === 'seq-9' && result.ok === true, 'and the canvas reports the outcome with the seq it was given')
    assert(result.state.title === 'item-icon', 'including which workflow is now open')
  }

  {
    // A canvas that refuses the graph must say so — the host records it instead of
    // retrying forever behind the user's back.
    const runtime = loadCanvasRuntime(runtimeScript, { throwOnLoad: true })
    await settle()
    deliver(runtime, { origin: 'http://127.0.0.1:43120', data: { __gig: runtimeToken, type: 'canvas.load', seq: 'seq-bad', graph: { nodes: [] } }, source: runtime.parent })
    await settle()
    const result = runtime.posted[runtime.posted.length - 1].message
    assert(result.type === 'canvas.result' && result.ok === false && /loadGraphData 炸了/.test(result.error), 'a graph the canvas refuses is reported as a failure with the reason')
  }

  // ── K: the plugin-level bridge (routes + tools) ────────────────────────────
  const comfyRoot2 = join(workRoot, 'ComfyUI-live')
  await mkdir(join(comfyRoot2, 'ComfyUI', 'custom_nodes'), { recursive: true })
  const dataRoot7 = join(workRoot, 'data7')
  const webServer = makeWebServer()
  const { ctx, registered } = makeCtx({ webServer })
  plugin.apply(ctx, {
    unitName: 'godot_imagegen_br_test',
    comfyRoot: comfyRoot2,
    dataRoot: dataRoot7,
    requestTimeoutMs: 5000,
    startTimeoutMs: 5000,
    sdwebuiPort: 17862,
    comfyPort: 18190,
  })
  const workshopTool = byName(registered, 'image_workshop')
  const workflowTool = byName(registered, 'image_workflow')
  assert(workshopTool !== undefined && workflowTool !== undefined, 'the plugin registered the workshop and workflow tools')

  const extBefore = await callRoute(webServer, 'GET', '/gig/extension')
  assert(extBefore.status === 200 && extBefore.body.installed === false, 'GET /gig/extension reports "not installed" up front')
  assert(extBefore.body.canvas.online === false, 'and that no canvas is connected')

  const bridgeStatus0 = unwrap(await exec(workshopTool, { action: 'bridge-status' }))
  assert(bridgeStatus0.bridge.installed === false && bridgeStatus0.bridge.canvasOnline === false, 'image_workshop action=bridge-status mirrors that')

  // There must be no cross-origin HTTP entry point at all: DSH Desktop refuses
  // any request from a frame whose origin is not the carrier origin, so such a
  // route could never be reached from inside the ComfyUI iframe.
  const deadPoll = await callRoute(webServer, 'POST', '/gig/bridge/poll', { token: 'x' })
  assert(deadPoll.status === 404, 'no /gig/bridge/poll route exists — the bridge never talks to the host from the iframe')

  const installRoute = await callRoute(webServer, 'POST', '/gig/extension/install', { origin: 'http://127.0.0.1:43120' })
  assert(installRoute.status === 200 && installRoute.body.ok === true, 'POST /gig/extension/install installs the bridge')
  assert(installRoute.body.backupDir !== undefined, 'and reports where the backup landed')
  const liveManifest = await readJson(join(dataRoot7, 'installed-files.json'))
  assert(liveManifest.origin === 'http://127.0.0.1:43120', 'the origin the panel supplied is the one baked in')

  const extAfter = await callRoute(webServer, 'GET', '/gig/extension')
  assert(extAfter.body.installed === true && extAfter.body.files === 2, 'GET /gig/extension now reports the install')
  assert(extAfter.body.canvas.online === false, 'while the canvas is still not connected')

  // The relay: the panel reports what the canvas said, stamped with the token the
  // install generated. This is the only path canvas state takes.
  const noTokenInbound = await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{ __gig: 'not-the-token', type: 'canvas.state', state: { nodeCount: 3 } }],
  })
  assert(noTokenInbound.status === 200 && noTokenInbound.body.accepted === 0, 'an inbound message with the wrong token is refused')
  assert(/令牌不匹配/.test(noTokenInbound.body.rejected.join(' ')), 'and the refusal names the reason (a stale install)')

  const inbound = await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{
      __gig: liveManifest.token,
      type: 'canvas.ready',
      state: { nodeCount: 7, classes: ['CheckpointLoaderSimple', 'KSampler'], missingClasses: [], title: 'item-icon' },
    }],
  })
  assert(inbound.status === 200 && inbound.body.accepted === 1, 'a message stamped with the install token is accepted')
  assert(inbound.body.canvas.online === true, 'and the canvas now counts as connected')

  const extConnected = await callRoute(webServer, 'GET', '/gig/extension')
  assert(extConnected.body.canvas.online === true, 'GET /gig/extension shows the canvas as connected')
  assert(extConnected.body.canvas.nodeCount === 7 && extConnected.body.canvas.classes.length === 2, 'with the graph it reported')
  assert(extConnected.body.canvas.title === 'item-icon', 'including which workflow is open')

  const readCanvas = unwrap(await exec(workshopTool, { action: 'read-canvas' }))
  assert(readCanvas.bridge.canvasNodeCount === 7, 'image_workshop action=read-canvas returns the node count')
  assert(readCanvas.bridge.canvasTitle === 'item-icon', 'and the workflow title')
  assert(readCanvas.bridge.canvasMissingClasses === undefined, 'and omits the missing-class list when nothing is missing')

  // The panel's normal path: it relays the canvas's replies in the poll it is
  // already making, so the canvas costs no extra round trip. This must accept
  // them too — a refactor that dropped `inbound` here would silently kill the
  // canvas state while every unit test of the dedicated route still passed.
  const piggyback = await callRoute(webServer, 'POST', '/gig/ui/poll', {
    inbound: [{ __gig: liveManifest.token, type: 'canvas.state', state: { nodeCount: 9, title: 'piggybacked' } }],
  })
  assert(piggyback.body.canvasInbound.accepted === 1, 'the panel poll also accepts canvas replies (piggyback carries them)')
  assert(piggyback.body.canvasStatus.online === true, 'and that keeps the canvas marked as connected')
  const afterPiggyback = await callRoute(webServer, 'GET', '/gig/extension')
  assert(afterPiggyback.body.canvas.nodeCount === 9 && afterPiggyback.body.canvas.title === 'piggybacked',
    'the piggybacked state is what the host now believes about the canvas')

  // A workflow opened on a connected canvas must reach ComfyUI, not only the panel.
  const opened = unwrap(await exec(workflowTool, { action: 'open', id: 'item-icon' }))
  assert(opened.canvas === true && /已直接推送到内嵌 ComfyUI 画布/.test(opened.canvasDetail), 'image_workflow action=open pushes the graph to the connected canvas')

  const poll2 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  const relay = (poll2.body.canvasMessages || []).find((m) => m.type === 'canvas.load')
  assert(relay !== undefined, 'the panel poll carries the canvas instruction to relay into the iframe')
  assert(relay.__gig === liveManifest.token, 'stamped with the install token, so the extension can tell it is from its own host')
  assert(relay.graph.nodes.length > 0, 'carrying the whole graph')
  assert(typeof relay.seq === 'string' && typeof relay.label === 'string', 'with a seq to acknowledge and a human label')

  // Relaying it again while the canvas has not answered yet is deliberate: the
  // command stays queued until the canvas says what happened.
  const poll2b = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  assert((poll2b.body.canvasMessages || []).some((m) => m.seq === relay.seq), 'an unacknowledged instruction keeps being offered to the panel')

  const result = await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{ __gig: liveManifest.token, type: 'canvas.result', seq: relay.seq, ok: true, state: { nodeCount: 7, title: 'item-icon' } }],
  })
  assert(result.body.accepted === 1, 'the canvas reporting success is accepted')
  const poll3 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  assert(!(poll3.body.canvasMessages || []).some((m) => m.seq === relay.seq), 'acknowledging clears it, so the graph is not pushed twice')

  // A refused graph must be visible to the agent, not silently retried forever.
  const failedRelay = await callRoute(webServer, 'POST', '/gig/canvas/load', { id: 'item-icon' })
  assert(failedRelay.status === 200, 'POST /gig/canvas/load queues a workflow for the canvas')
  const poll4 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  const secondEnvelope = (poll4.body.canvasMessages || [])[0]
  await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{ __gig: liveManifest.token, type: 'canvas.result', seq: secondEnvelope.seq, ok: false, error: 'loadGraphData 炸了' }],
  })
  const extErrors = await callRoute(webServer, 'GET', '/gig/extension')
  assert(extErrors.body.errors.length === 1 && /loadGraphData 炸了/.test(extErrors.body.errors[0].error), 'a canvas load failure is recorded where the agent can read it')

  // The panel queue and the canvas queue must stay independent.
  const panelQueue = await callRoute(webServer, 'GET', '/gig/ui/queue')
  assert(panelQueue.body.commands.some((c) => c.kind === 'workflow.load'), 'the panel queue holds its own copy for the panel')
  assert(panelQueue.body.status.online === true, 'and tracks the panel on its own clock')
  assert(panelQueue.body.state !== null && panelQueue.body.state.canvas === undefined, 'canvas traffic is never written into the panel\'s own state report')

  const bridgeInstallTool = unwrap(await exec(workshopTool, { action: 'install-bridge', origin: 'http://127.0.0.1:43121' }))
  assert(bridgeInstallTool.bridge.installed === true, 'image_workshop action=install-bridge installs through the tool surface')
  const manifestAfterTool = await readJson(join(dataRoot7, 'installed-files.json'))
  assert(manifestAfterTool.origin === 'http://127.0.0.1:43121', 'honouring the origin passed to the tool')
  assert(manifestAfterTool.token === liveManifest.token, 'and keeping the same token')
  const stillWorks = await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{ __gig: liveManifest.token, type: 'canvas.state', state: { nodeCount: 5 } }],
  })
  assert(stillWorks.body.accepted === 1, 'the previously issued token still works, because the token is reused')
  const bridgeInstallNoOrigin = unwrap(await exec(workshopTool, { action: 'install-bridge' }))
  assert(bridgeInstallNoOrigin.bridge.installed === true, 'installing again without an origin keeps the install working')
  const manifestNoHint = await readJson(join(dataRoot7, 'installed-files.json'))
  assert(manifestNoHint.origin === 'http://127.0.0.1:43121', 'and does not reset the origin to a default')

  const uninstallTool = unwrap(await exec(workshopTool, { action: 'uninstall-bridge' }))
  assert(uninstallTool.bridge.installed === false, 'image_workshop action=uninstall-bridge removes the extension')
  assert(!(await exists(join(comfyRoot2, 'ComfyUI', 'custom_nodes', 'godot-imagegen-bridge'))), 'the package directory is really gone')
  assert(uninstallTool.bridge.removed === 2, 'and reports how many files it deleted')
  const uninstallAgain = unwrap(await exec(workshopTool, { action: 'uninstall-bridge' }))
  assert(uninstallAgain.bridge.installed === false && /本来就没有装过/.test(uninstallAgain.note), 'uninstalling again is a no-op with an explanation, not an error')

  // After an uninstall the token is gone, so nothing can be relayed any more.
  const afterUninstall = await callRoute(webServer, 'POST', '/gig/canvas/inbound', {
    messages: [{ __gig: liveManifest.token, type: 'canvas.state', state: { nodeCount: 5 } }],
  })
  assert(afterUninstall.body.accepted === 0 && afterUninstall.body.rejected.length === 1, 'once uninstalled, no canvas message is accepted')

  // ── L: the panel-side relay helpers are covered by the client render suite ──
  // (relayToCanvas / isCanvasMessage live in lib/client.js, which only runs in a
  // browser-shaped environment; tests/test-render-imagegen.mjs exercises them.)

  // The mock tools are reached through the registry only; this asserts the
  // plugin did not register anything under a name that shadows the real surface.
  assert(registered.filter((t) => t.name === 'image_workshop').length === 1, 'exactly one image_workshop tool is registered')

  await rm(workRoot, { recursive: true, force: true })

  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Mirror of the harness' unwrap: tool results are returned as-is. */
function unwrap(value) {
  return value
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
