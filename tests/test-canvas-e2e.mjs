/**
 * End-to-end test of the canvas bridge against the extension ACTUALLY INSTALLED on
 * this machine, driven through the plugin's REAL host routes.
 *
 * Every other suite tests one layer: the manager in isolation, the routes with a
 * synthetic token, the extension in a VM. This one wires the whole loop together
 * with the real artifacts —
 *
 *   host routes  <->  panel relay  <->  the installed .js (with its baked token)
 *
 * — and it is READ-ONLY by construction: it never installs, uninstalls or writes
 * anything. The manifest's size and mtime are captured before and after and
 * asserted unchanged, so "read-only" is checked rather than promised.
 *
 * The one thing it cannot cover is the browser's own postMessage plumbing between
 * the panel and the iframe (there is no browser here); that half is covered by the
 * client suite's executed-effect test, and the two halves meet at the envelope
 * shape this file reproduces exactly.
 *
 * Run with:  node tests/test-canvas-e2e.mjs
 * Env:       GIG_COMFY_ROOT, GIG_DATA_ROOT
 */
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
const note = (text) => console.log(`NOTE  ${text}`)

// ── the real installation ────────────────────────────────────────────────────

const COMFY_ROOT = (process.env.GIG_COMFY_ROOT || 'D:/AKI open/ComfyUI-aki-v2').replace(/\\/g, '/')
const DATA_ROOT = (process.env.GIG_DATA_ROOT || join(process.env.USERPROFILE || '.', '.dsh', 'godot-imagegen')).replace(/\\/g, '/')
const cfg = {
  unitName: 'godot_imagegen_e2e',
  sdwebuiRoot: '.', sdwebuiPython: '.', sdwebuiPort: 17870,
  comfyRoot: COMFY_ROOT, comfyPython: `${COMFY_ROOT}/python/python.exe`, comfyPort: 18192,
  postPython: '.', defaultBackend: 'sdwebui',
  requestTimeoutMs: 4000, startTimeoutMs: 4000,
  dataRoot: DATA_ROOT,
}

const manager = plugin.createExtensionManager(cfg)
const manifestPath = join(DATA_ROOT, 'installed-files.json')
const installedJsPath = join(manager.targetDir, 'web', 'godot-imagegen-bridge.js')

if (!existsSync(manifestPath) || !existsSync(installedJsPath)) {
  note(`画布桥接没有安装（${manager.targetDir}）——先装好再跑这个端到端测试。`)
  process.exit(0)
}
const before = await stat(manifestPath)
const stubBefore = await stat(installedJsPath)

// ── the harness: a plugin instance over the plugin's own routes ──────────────

function makeCtx(extra = {}) {
  const registered = []
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    storage: { backend: { get: () => ({}) } },
    get(name) { return name === 'webServer' ? extra.webServer : undefined },
    inject(deps, callback) {
      if (deps.includes('webServer') && extra.webServer !== undefined) {
        callback(Object.assign(Object.create(ctx), { webServer: extra.webServer }))
      }
      return () => {}
    },
    effect(callback) { const cleanup = callback(); return cleanup },
  }
  return { ctx, registered }
}
function makeWebServer() {
  const routes = []
  return { routes, register(opts) { routes.push(opts); return () => {} } }
}
function jsonRequest(method, pathname, body) {
  return { method, url: pathname, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8') } }
}
function jsonResponse() {
  const captured = {}
  return { captured, writeHead(status, headers) { captured.status = status; captured.headers = headers }, end(body) { captured.body = body } }
}
async function callRoute(webServer, method, pathname, body) {
  const route = webServer.routes.find((r) => r.path === '/gig')
  const res = jsonResponse()
  await route.handler(jsonRequest(method, pathname, body), res)
  let parsed = null
  if (typeof res.captured.body === 'string') { try { parsed = JSON.parse(res.captured.body) } catch { parsed = res.captured.body } }
  return { status: res.captured.status, body: parsed }
}

const webServer = makeWebServer()
const { ctx, registered } = makeCtx({ webServer })
plugin.apply(ctx, cfg)
const workshopTool = registered.find((t) => t.name === 'image_workshop')
const workflowTool = registered.find((t) => t.name === 'image_workflow')
const exec = (tool, args) => tool.execute(args, { signal: { aborted: false } })

// ── the "browser": the INSTALLED file, with a fake ComfyUI and a fake parent ──

/** A LiteGraph-shaped graph: real node objects, so id lookups behave like the app. */
function makeGraph(specs) {
  const nodes = specs.map((spec, index) => (typeof spec === 'string'
    ? { id: index + 1, type: spec }
    : { id: spec.id, type: spec.type }))
  return {
    _nodes: nodes,
    getNodeById(id) { return nodes.find((node) => node.id === Number(id)) },
    setDirtyCanvas() { this.dirty = (this.dirty || 0) + 1 },
  }
}

function loadInstalledExtension(script, { nodes = ['KSampler', 'CLIPTextEncode', 'KSampler'], title = 'item-icon', refuseLoad = false } = {}) {
  const posted = []
  const loaded = []
  const listeners = []
  const app = {
    graph: makeGraph(nodes),
    workflowManager: { activeWorkflow: { name: title } },
    registerExtension() {},
    loadGraphData(graph) {
      if (refuseLoad) throw new Error('画布拒绝了这个图')
      loaded.push(graph)
      // A real load REPLACES the graph, so the nodes the overlay had lit are gone
      // and the extension has to re-light them on the incoming ones.
      app.graph = makeGraph((graph && Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => ({ id: node.id, type: node.type })))
    },
  }
  // Just enough DOM for the run banner: createElement + appendChild + style.
  const banner = {
    tagName: 'DIV', style: { cssText: '', display: '' }, textContent: '', parentNode: null,
    setAttribute(name, value) { this[name] = value },
  }
  const doc = {
    body: { appendChild(el) { el.parentNode = this } },
    createElement() { return banner },
  }
  const parent = { postMessage(message, origin) { posted.push({ message, origin }) } }
  const win = { parent, app, addEventListener(type, fn) { if (type === 'message') listeners.push(fn) } }
  win.window = win
  runInNewContext(script, { window: win, console, setInterval, clearInterval, document: doc })
  return {
    posted, loaded, parent, app, banner,
    /** The nodes the canvas currently holds — what the overlay can light up. */
    get nodes() { return app.graph._nodes },
    /** Deliver one envelope from the panel into the iframe. */
    deliver(message, { origin } = {}) {
      const event = { origin, data: message, source: parent }
      for (const fn of listeners) fn(event)
    },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

async function main() {
  const installedScript = await readFile(installedJsPath, 'utf8')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const origin = manifest.origin
  const token = manifest.token
  console.log(`INFO  扩展：${installedJsPath}`)
  console.log(`INFO  宿主 origin：${origin}（令牌 ${token.slice(0, 6)}…，${token.length} 字符）`)

  // ── 1. the install itself ─────────────────────────────────────────────────
  const status = await callRoute(webServer, 'GET', '/gig/extension')
  assert(status.status === 200 && status.body.installed === true, 'GET /gig/extension reports the bridge as installed')
  assert(status.body.stale === false, 'and that the installed copy matches the plugin source (not stale)')
  assert(status.body.files === 2, 'with both files recorded in the manifest')
  assert(status.body.origin === origin, 'and the origin the panel reported at install time')
  assert(status.body.canvas.online === false, 'and no canvas has spoken yet')

  // ── 2. the heartbeat the host stamps ──────────────────────────────────────
  const poll = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
  assert(poll.body.canvasPing && poll.body.canvasPing.type === 'canvas.ping', 'the panel poll carries a heartbeat')
  assert(poll.body.canvasPing.__gig === token, 'stamped with the token the INSTALLED file carries')
  assert(Array.isArray(poll.body.canvasMessages) && poll.body.canvasMessages.length === 0, 'and no instruction is queued yet')

  // ── 3. the real extension answers the heartbeat ───────────────────────────
  {
    const canvas = loadInstalledExtension(installedScript)
    await settle()
    const hello = canvas.posted.find((p) => p.message.type === 'canvas.ready')
    assert(hello !== undefined, 'the INSTALLED extension announces itself on boot')
    assert(hello.origin === origin, 'pinned to the origin baked into it')
    assert(hello.message.state.nodeCount === 3, 'reporting the graph it can see')

    canvas.deliver(poll.body.canvasPing, { origin })
    await settle()
    const pong = canvas.posted[canvas.posted.length - 1].message
    assert(pong.type === 'canvas.state' && pong.seq === undefined, 'and answers a heartbeat with a plain state report')

    const inbound = await callRoute(webServer, 'POST', '/gig/canvas/inbound', { messages: [pong] })
    assert(inbound.body.accepted === 1, 'the host accepts the reply relayed by the panel')
    assert(inbound.body.canvas.online === true, 'and now considers the canvas connected')

    const after = await callRoute(webServer, 'GET', '/gig/extension')
    assert(after.body.canvas.online === true, 'GET /gig/extension agrees')
    assert(after.body.canvas.nodeCount === 3 && after.body.canvas.title === 'item-icon', 'with the node count and workflow title read off the canvas')

    // ── 4. the real artifact refuses what it must ───────────────────────────
    const wrongOrigin = canvas.posted.length
    canvas.deliver({ __gig: token, type: 'canvas.load', seq: 'x1', graph: { nodes: [] } }, { origin: 'http://127.0.0.1:9999' })
    canvas.deliver({ __gig: 'stale-token', type: 'canvas.load', seq: 'x2', graph: { nodes: [] } }, { origin })
    canvas.deliver({ type: 'canvas.load', seq: 'x3', graph: { nodes: [] } }, { origin })
    await settle()
    assert(canvas.loaded.length === 0 && canvas.posted.length === wrongOrigin,
      'a wrong origin, a stale token or a missing token loads nothing and gets no reply')
  }

  // ── 5. a real workflow pushed from the conversation ───────────────────────
  const list = await exec(workflowTool, { action: 'list' })
  const first = (list.workflows || [])[0]
  if (first === undefined) {
    note('工作流库是空的，跳过"把工作流推到画布"这一段（先打开一次美术工坊让它播种）。')
  } else {
    const canvas = loadInstalledExtension(installedScript)
    await settle()
    canvas.deliver(poll.body.canvasPing, { origin })
    await settle()
    await callRoute(webServer, 'POST', '/gig/canvas/inbound', { messages: [canvas.posted[canvas.posted.length - 1].message] })

    const opened = await exec(workflowTool, { action: 'open', id: first.id })
    assert(opened.canvas === true, `image_workflow action=open reports the canvas took the graph (${first.id})`)

    const poll2 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
    const load = (poll2.body.canvasMessages || []).find((m) => m.type === 'canvas.load')
    assert(load !== undefined, 'the next poll offers that instruction to the panel')
    assert(load.__gig === token && load.graph.nodes.length > 0, 'stamped with the real token and carrying the whole graph')

    canvas.deliver(load, { origin })
    await settle()
    assert(canvas.loaded.length === 1 && canvas.loaded[0] === load.graph,
      'the INSTALLED extension really handed that graph to app.loadGraphData')
    const result = canvas.posted[canvas.posted.length - 1].message
    assert(result.type === 'canvas.result' && result.seq === load.seq && result.ok === true,
      'and reported the outcome with the seq it was given')

    await callRoute(webServer, 'POST', '/gig/ui/poll', { inbound: [result] })
    const poll3 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
    assert(!(poll3.body.canvasMessages || []).some((m) => m.seq === load.seq),
      'the acknowledgement (carried by the panel poll) clears it, so it is not pushed twice')
    assert(poll3.body.canvasStatus.pending === 0, 'and the canvas queue is empty again')

    // The panel's own button goes through a different route than the tool, and it
    // must land in the same queue: it is the entry point the user actually clicks.
    const viaButton = await callRoute(webServer, 'POST', '/gig/canvas/load', { id: first.id })
    assert(viaButton.status === 200 && viaButton.body.delivered === true, 'POST /gig/canvas/load (the panel button) reports delivery')
    const poll4 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
    const buttonLoad = (poll4.body.canvasMessages || []).find((m) => m.type === 'canvas.load')
    assert(buttonLoad !== undefined, 'and the very next poll offers it to the panel, like the tool path')
    canvas.deliver(buttonLoad, { origin })
    await settle()
    assert(canvas.loaded.length === 2, 'the installed extension loaded it too')
    await callRoute(webServer, 'POST', '/gig/ui/poll', { inbound: [canvas.posted[canvas.posted.length - 1].message] })
    const poll5 = await callRoute(webServer, 'POST', '/gig/ui/poll', {})
    assert(poll5.body.canvasStatus.pending === 0, 'and acknowledging it drains the queue again')
  }

  // ── 6. a graph the canvas refuses is reported, not retried forever ────────
  {
    const canvas = loadInstalledExtension(installedScript, { refuseLoad: true })
    await settle()
    const bad = { __gig: token, type: 'canvas.load', seq: 'refused-1', graph: { nodes: [{ id: 1, type: 'KSampler' }] } }
    canvas.deliver(bad, { origin })
    await settle()
    const result = canvas.posted[canvas.posted.length - 1].message
    assert(result.ok === false && /画布拒绝了这个图/.test(result.error), 'a refusing canvas reports ok:false with the reason')

    const relayed = await callRoute(webServer, 'POST', '/gig/ui/poll', { inbound: [result] })
    assert(relayed.body.canvasInbound.accepted === 1, 'the panel relays that failure up')
    const errors = await callRoute(webServer, 'GET', '/gig/extension')
    assert(errors.body.errors.some((e) => /画布拒绝了这个图/.test(e.error)),
      'and the refusal is recorded on the host (the route the PANEL reads)')

    // The next two lines used to be one assertion claiming "the host surfaces it
    // where the AGENT can read it (image_workshop bridge-status)" while only ever
    // checking the route above — and the tool reported no errors at all. So an
    // agent that had just been told 「✓ 已直接推送到内嵌 ComfyUI 画布」 had no way to
    // learn the canvas had refused the graph. Asserted against the tool now.
    const statusTool = await exec(workshopTool, { action: 'bridge-status' })
    assert(statusTool.bridge.installed === true, 'image_workshop action=bridge-status sees the real install')
    assert(Array.isArray(statusTool.bridge.canvasErrors)
      && statusTool.bridge.canvasErrors.some((line) => /画布拒绝了这个图/.test(line)),
      'and the TOOL exposes the refusal, so the AGENT can read it and not only the panel')
    const readCanvas = await exec(workshopTool, { action: 'read-canvas' })
    assert(readCanvas.bridge.canvasOnline === true, 'and read-canvas sees the canvas that just answered')
    assert(readCanvas.bridge.canvasMissingClasses === undefined, 'with no missing node classes for the clean graph')
  }

  // ── 7. the bug the user hit: does it still drop at 15s? ───────────────────
  {
    const canvas = loadInstalledExtension(installedScript)
    await settle()
    canvas.deliver(poll.body.canvasPing, { origin })
    await settle()
    await callRoute(webServer, 'POST', '/gig/canvas/inbound', { messages: [canvas.posted[canvas.posted.length - 1].message] })
    const atStart = await callRoute(webServer, 'GET', '/gig/extension')
    assert(atStart.body.canvas.online === true, 'canvas connected before the wait')

    note('等 16 秒（超过面板的 15 秒窗口）再问一次——这一步就是复现用户看到的"过一小会就掉线"…')
    await new Promise((resolve) => setTimeout(resolve, 16_000))
    const later = await callRoute(webServer, 'GET', '/gig/extension')
    assert(later.body.canvas.online === true,
      `16 秒没有新上报后画布仍算在线（画布窗口 60 秒；面板窗口 15 秒）—— 已在 ${later.body.canvas.lastPollSecondsAgo} 秒前上报`)
    assert(later.body.canvas.lastPollSecondsAgo >= 15, 'and the card can still say how long the silence has been')
  }

  // ── 8. the run overlay (what "画布上看不到在跑什么" was) ───────────────────
  //
  // The panel's heartbeat carries the run the host has in flight. This section
  // drives that envelope into the INSTALLED extension and checks the two things
  // the user was missing: the canvas says which run it is, and it marks the node
  // ComfyUI is executing.
  {
    const canvas = loadInstalledExtension(installedScript)
    await settle()
    const run = { label: '生成 · 药水', nodes: 3, startedAt: '2026-01-01T00:00:00Z' }

    canvas.deliver({ __gig: token, type: 'canvas.ping', run: Object.assign({}, run, { nodeId: '2' }) }, { origin })
    await settle()
    const lit = canvas.nodes.find((node) => node.id === 2)
    assert(lit !== undefined && lit.boxcolor === '#22c55e', 'the node ComfyUI is executing gets highlighted')
    assert(canvas.banner.style.display === 'block' && canvas.banner.textContent.includes('正在运行 · 生成 · 药水'),
      'and the canvas itself names the run that is on it')
    assert(canvas.banner[ 'data-gig-run' ] !== undefined, 'the banner is marked, so it is ours and not ComfyUI chrome')

    canvas.deliver({ __gig: token, type: 'canvas.ping', run: Object.assign({}, run, { nodeId: '2', value: 4, max: 10 }) }, { origin })
    await settle()
    assert(canvas.banner.textContent.includes('采样 4/10'), 'the step count rides the same heartbeat')

    // A load that arrives mid-run REPLACES the whole graph — and the host re-offers
    // an unacknowledged load on every poll, so this happens repeatedly during a
    // run. The highlight has to move onto the new node objects each time instead
    // of dying with the old ones.
    const swap = { __gig: token, type: 'canvas.load', seq: 'swap-1', name: '生成 · 药水', running: true, graph: { nodes: [{ id: 7, type: 'KSampler' }] } }
    canvas.deliver(swap, { origin })
    await settle()
    assert(canvas.nodes.find((node) => node.id === 2) === undefined, 'a loaded graph replaces the canvas rather than merging into it')
    canvas.deliver({ __gig: token, type: 'canvas.ping', run: Object.assign({}, run, { nodeId: '7' }) }, { origin })
    await settle()
    assert(canvas.nodes.find((node) => node.id === 7).boxcolor === '#22c55e', 'the new graph gets the running node highlighted on it')
    // Re-delivered (exactly what the panel does while the load is unacknowledged):
    // the run state is unchanged, yet the highlight must be re-applied to the graph
    // that just replaced it.
    canvas.deliver(swap, { origin })
    await settle()
    assert(canvas.nodes.find((node) => node.id === 7).boxcolor === '#22c55e',
      'and re-delivering that same graph keeps the highlight, rather than skipping the repaint')

    canvas.deliver({ __gig: token, type: 'canvas.ping' }, { origin })
    await settle()
    const after = canvas.nodes.find((node) => node.id === 7)
    assert(after.boxcolor === undefined, 'an idle heartbeat drops the highlight')
    assert(canvas.banner.style.display === 'none', 'and hides the run banner again')

    // A canvas that never got a run envelope must not draw one: this is the
    // ordinary "nothing is running" heartbeat.
    const quiet = loadInstalledExtension(installedScript)
    await settle()
    quiet.deliver({ __gig: token, type: 'canvas.ping' }, { origin })
    await settle()
    assert(quiet.banner.style.display !== 'block', 'a plain heartbeat draws no banner at all')
  }

  // ── 9. read-only, checked rather than promised ────────────────────────────
  const after = await stat(manifestPath)
  const stubAfter = await stat(installedJsPath)
  assert(after.size === before.size && after.mtimeMs === before.mtimeMs, 'the install manifest was not touched by this test')
  assert(stubAfter.mtimeMs === stubBefore.mtimeMs, 'and neither was the installed extension')

  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
