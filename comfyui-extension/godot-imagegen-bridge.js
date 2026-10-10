/**
 * godot-imagegen bridge — a ComfyUI web extension.
 *
 * This file is the SOURCE OF TRUTH and lives in the plugin's own repository. At
 * install time the host substitutes the two placeholders below and copies the
 * result into the ComfyUI install:
 *
 *   __DSH_ORIGIN__  the DeepSeek Harness web origin (e.g. http://127.0.0.1:43120)
 *   __TOKEN__       a per-install secret, so a stray page cannot drive the canvas
 *
 * ── Why this talks over postMessage and NOT over HTTP ─────────────────────────
 *
 * The obvious design — this extension long-polls the DSH host on an HTTP route —
 * DOES NOT WORK, and the reason is worth recording so nobody "simplifies" it back:
 *
 * DSH Desktop attaches a per-generation capability header to the Electron
 * renderer's traffic, and its web server refuses any request that does not carry
 * it. The header is attached only when `details.frame.origin` is the carrier
 * origin (see `requestComesFromRendererOrigin`). This page runs on ComfyUI's own
 * origin inside an iframe, so the header is deliberately NOT attached and every
 * request it makes to the DSH origin is answered 403 "forbidden" — the capability
 * must never travel away from the local carrier. CORS headers cannot help: the
 * request is rejected before routing, and the same rule covers WebSocket upgrades.
 *
 * postMessage is the channel that DOES work: the parent frame is the DSH page
 * itself, which already holds the capability. So the DSH panel relays for us —
 * it hands commands down and carries our canvas report back up.
 *
 *  美术工坊 panel (DSH origin)  ──postMessage──►  this extension (ComfyUI origin)
 *                               ◄──postMessage──
 *
 * ── Why there are no imports ─────────────────────────────────────────────────
 *
 * ComfyUI's own extensions commonly do `import { app } from "../../scripts/app.js"`,
 * but that path only exists in some frontend builds. Waiting for the app object
 * instead works on every build and does not depend on how the frontend chose to
 * load this file (module or classic script).
 */
(function () {
  'use strict'

  var DSH_ORIGIN = '__DSH_ORIGIN__'
  var TOKEN = '__TOKEN__'

  /**
   * How long a load is allowed to keep not-matching before it is called a refusal.
   *
   * The graph swap is asynchronous and a heavy workflow takes real time to
   * instantiate, so a single early sample reads a slow-but-successful load as a
   * refusal. Reading the state too early is precisely how this check's author first
   * mis-read a perfectly working canvas as a broken one.
   */
  var LOAD_SETTLE_MS = 2500

  /** The ComfyUI app object, whichever way this frontend build exposes it. */
  function findApp() {
    try {
      var api = window.comfyAPI
      if (api && api.app && api.app.app) return api.app.app
    } catch (e) { /* ignore */ }
    try {
      if (window.app) return window.app
    } catch (e) { /* ignore */ }
    return undefined
  }

  /** Wait for the frontend to boot; the extension may run before it is ready. */
  function waitForApp(timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (timeoutMs || 60000)
      var timer = setInterval(function () {
        var app = findApp()
        if (app && app.graph !== undefined) {
          clearInterval(timer)
          resolve(app)
          return
        }
        if (Date.now() > deadline) {
          clearInterval(timer)
          resolve(undefined)
        }
      }, 250)
    })
  }

  /** Which node classes the canvas is using, and how many nodes it has. */
  /**
   * A comparable fingerprint of a graph's node classes, counts included.
   *
   * Neither half is enough on its own. Node counts alone cannot tell two loads
   * apart — pushing a 7-node workflow onto a canvas already holding a DIFFERENT
   * 7-node one looks identical — and a set of class names alone misses a load that
   * dropped a node. So: class × count, sorted.
   */
  function signatureOf(counts) {
    return Object.keys(counts).sort().map(function (type) {
      return type + '×' + counts[type]
    }).join(', ')
  }

  /** The same fingerprint, taken from a UI-format document we are about to push. */
  function graphSignature(graph) {
    var nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : []
    var counts = {}
    for (var i = 0; i < nodes.length; i++) {
      var type = (nodes[i] && nodes[i].type) || 'unknown'
      counts[type] = (counts[type] || 0) + 1
    }
    return signatureOf(counts)
  }

  function summarizeGraph() {
    var app = findApp()
    var graph = app && app.graph
    if (!graph) return undefined
    var nodes = graph._nodes || graph.nodes || []
    if (!Array.isArray(nodes)) return undefined
    var classes = {}
    var missing = []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i] || {}
      var type = node.type || node.comfyClass || 'unknown'
      classes[type] = (classes[type] || 0) + 1
      // LiteGraph keeps a node whose class could not be resolved as a bare node
      // with `has_errors`; surfacing it means the agent learns the workflow needs
      // a custom node this install does not have.
      if (node.has_errors === true || type === 'unknown') missing.push(type)
    }
    var title = ''
    try {
      var manager = app.workflowManager
      if (manager && typeof manager.activeWorkflow === 'object' && manager.activeWorkflow) {
        title = String(manager.activeWorkflow.name || '')
      }
    } catch (e) { /* older builds */ }
    return {
      nodeCount: nodes.length,
      classes: Object.keys(classes).sort(),
      signature: signatureOf(classes),
      missingClasses: missing,
      title: title,
    }
  }

  /**
   * Put a UI-format workflow on the canvas.
   *
   * Deliberately NOT async, and deliberately not awaited by the caller before it
   * decides anything: on a REFUSED load this build may never settle that promise
   * (ComfyUI reports the refusal with a modal and leaves it hanging). Awaiting it
   * first therefore means sending NO verdict at all — the host sees neither success
   * nor failure, which is worse than the lie it replaced. The promise is handed
   * back so a rejection can be one way to reach a verdict, while the caller reaches
   * one anyway when it never settles.
   */
  function loadGraph(graph) {
    var app = findApp()
    if (!app) throw new Error('ComfyUI app 尚未就绪')
    if (typeof app.loadGraphData !== 'function') throw new Error('此 ComfyUI 版本没有 app.loadGraphData')
    var result = app.loadGraphData(graph)
    // The nodes the highlight was on are gone with the old graph, so the run
    // currently in flight has to be re-lit on the graph that just arrived — and
    // FORCED, because the run state itself did not change and the "same run, skip
    // the redraw" guard would otherwise skip exactly this repaint.
    if (lastRun) applyRun(lastRun, true)
    return result
  }

  // ── the running-workflow overlay ──────────────────────────────────────────
  //
  // The canvas is a foreign page and already has its own idea of "the current
  // workflow": `app.loadGraphData` swaps the nodes, but the title in the sidebar
  // keeps the name of whatever the user had open. That is why a host that only
  // replaced the graph still LOOKED like nothing happened. So the plugin's run is
  // announced inside the canvas instead: a banner naming the run and its step,
  // plus a highlight on the node ComfyUI is executing right now.
  //
  // The node ids line up because `apiToUi` preserves the ids ComfyUI reports over
  // its own WebSocket — the graph on the canvas and the executing event refer to
  // the same node.
  var banner = null
  var lit = null
  var lastRun = null
  var drawnKey = ''

  function ensureBanner() {
    if (banner && banner.parentNode) return banner
    if (typeof document === 'undefined' || !document || !document.body) return null
    banner = document.createElement('div')
    banner.setAttribute('data-gig-run', '')
    banner.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);'
      + 'z-index:2147483000;pointer-events:none;display:none;white-space:nowrap;'
      + 'padding:6px 14px;border-radius:999px;font:12px/1.45 system-ui,"Segoe UI",sans-serif;'
      + 'background:rgba(15,23,42,.92);color:#e2e8f0;border:1px solid rgba(34,197,94,.65);'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.35)'
    document.body.appendChild(banner)
    return banner
  }

  /** Drop the highlight, restoring the node's own colours. */
  function unlight() {
    if (lit === null) return
    var app = findApp()
    var graph = app && app.graph
    var id = lit
    lit = null
    if (!graph || typeof graph.getNodeById !== 'function') return
    try {
      var node = graph.getNodeById(Number(id))
      if (!node) return
      node.boxcolor = undefined
      node.bgcolor = undefined
      if (typeof graph.setDirtyCanvas === 'function') graph.setDirtyCanvas(true, true)
    } catch (e) { /* a node that cannot be repainted is not worth an error */ }
  }

  /** Draw the run state the host put on its heartbeat. `null` clears it. */
  function drawRun(run, force) {
    // Remembered before the "unchanged, skip the repaint" guard: the graph can be
    // replaced under an unchanged run (the host re-offers an unacknowledged load on
    // every poll), and that repaint still has to know which node is running.
    lastRun = run === undefined ? null : run
    var label = run && typeof run === 'object' ? String(run.label || 'ComfyUI') : ''
    var key = run && typeof run === 'object'
      ? label + '|' + run.value + '/' + run.max + '|' + run.nodeId
      : 'idle'
    if (!force && key === drawnKey) return
    drawnKey = key
    var el = ensureBanner()
    unlight()
    if (run === null || run === undefined || typeof run !== 'object') {
      if (el) el.style.display = 'none'
      return
    }
    var text = '▶ 正在运行 · ' + label
    if (run.value !== undefined && run.value !== null && run.max) text += ' · 采样 ' + run.value + '/' + run.max
    if (run.nodes) text += ' · ' + run.nodes + ' 个节点'
    if (el) {
      el.textContent = text
      el.style.display = 'block'
    }
    if (run.nodeId === undefined || run.nodeId === null) return
    var app = findApp()
    var graph = app && app.graph
    if (!graph || typeof graph.getNodeById !== 'function') return
    var node = graph.getNodeById(Number(run.nodeId))
    if (!node) return
    lit = String(run.nodeId)
    try {
      node.boxcolor = '#22c55e'
      node.bgcolor = '#14532d'
      if (typeof graph.setDirtyCanvas === 'function') graph.setDirtyCanvas(true, true)
    } catch (e) { /* ignore */ }
  }

  /** Never let the overlay break the heartbeat it rides on. */
  function applyRun(run, force) {
    try {
      drawRun(run, force)
    } catch (e) {
      console.warn('[godot-imagegen] 画布运行提示绘制失败', e)
    }
  }

  /** Answer the parent frame, always pinned to the origin we were installed for. */
  function reply(source, message) {
    if (!source || typeof source.postMessage !== 'function') return
    try {
      source.postMessage(message, DSH_ORIGIN)
    } catch (e) { /* the panel may have navigated away */ }
  }

  var ready = waitForApp(60000)

  ready.then(function (app) {
    // Announce once the canvas exists, so the panel learns it is live without
    // waiting for its next relay round-trip.
    reply(window.parent, { __gig: TOKEN, type: 'canvas.ready', state: summarizeGraph() })
    if (!app) console.warn('[godot-imagegen] 等不到 ComfyUI app 对象，bridge 仍会等待指令')
    else console.info('[godot-imagegen] bridge 已就绪，宿主：' + DSH_ORIGIN)
  })

  window.addEventListener('message', function (event) {
    // Two independent gates: the message must come from the DSH page, and it must
    // carry the token THIS install was generated with. A stale copy in another
    // ComfyUI install therefore cannot be driven by this host.
    if (event.origin !== DSH_ORIGIN) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.__gig !== TOKEN) return

    if (data.type === 'canvas.ping') {
      // The heartbeat carries the run in flight, when there is one: the host
      // stamps its own progress onto it, so the canvas follows the same numbers
      // the panel shows and no extra queue entry has to be acknowledged.
      applyRun(data.run)
      reply(event.source, { __gig: TOKEN, type: 'canvas.state', state: summarizeGraph() })
      return
    }

    if (data.type !== 'canvas.load' || !data.graph) return

    ready.then(function () {
      var verdictSent = false
      var send = function (ok, detail, state) {
        if (verdictSent) return
        verdictSent = true
        if (ok) {
          reply(event.source, { __gig: TOKEN, type: 'canvas.result', seq: data.seq, ok: true, state: state })
          return
        }
        // Report the failure instead of swallowing it: the agent needs to know the
        // canvas refused the graph.
        console.warn('[godot-imagegen] 载入工作流失败', detail)
        reply(event.source, { __gig: TOKEN, type: 'canvas.result', seq: data.seq, ok: false, error: detail, state: state })
      }

      var expected = graphSignature(data.graph)
      var refusal = function (state) {
        var actual = state && state.signature
        return '画布没有换图（等了 ' + Math.round(LOAD_SETTLE_MS / 1000) + ' 秒）：推过去的是「' + expected + '」，画布上实际是「' + actual + '」。'
          + 'ComfyUI 前端拒绝了这次载入——最常见的原因是这张图钉了本机没有的资源'
          + '（checkpoint / 放大权重 / input 图片），它通常只在画布上弹一个提示框，不抛错。'
      }

      // The load's own promise is ONE signal, never the gate. On a refused load this
      // build may leave it unsettled forever — that is exactly how the previous
      // version came to send NO verdict at all, which is worse than the success it
      // used to claim.
      var rejected = null
      try {
        var pending = loadGraph(data.graph)
        if (pending && typeof pending.then === 'function') {
          pending.then(
            function () { /* resolved: the signature check below still decides */ },
            function (error) { rejected = error && error.message ? error.message : String(error) },
          )
        }
      } catch (error) {
        send(false, error && error.message ? error.message : String(error), summarizeGraph())
        return
      }

      if (typeof setTimeout !== 'function') {
        // A bare VM harness without timers: one look, immediately.
        var immediate = summarizeGraph()
        if (rejected !== null) send(false, rejected, immediate)
        else if (expected === '' || (immediate && immediate.signature) === expected) send(true, null, immediate)
        else send(false, refusal(immediate), immediate)
        return
      }

      // Otherwise: exactly one verdict, from whichever signal arrives first —
      // a rejection, a matching signature, or the window expiring with the graph
      // still not swapped. Keep looking rather than sampling once; see
      // LOAD_SETTLE_MS for why an early single sample is worse than useless here.
      var deadline = Date.now() + LOAD_SETTLE_MS
      var look = function () {
        var state = summarizeGraph()
        if (rejected !== null) { send(false, rejected, state); return }
        if (expected === '' || (state && state.signature) === expected) { send(true, null, state); return }
        if (Date.now() >= deadline) { send(false, refusal(state), state); return }
        setTimeout(look, 200)
      }
      setTimeout(look, 250)
    })
  })

  // Bookkeeping only: registering makes this extension visible in the extension
  // list on builds that track it. The relay above does not depend on it.
  ready.then(function (app) {
    try {
      if (app && typeof app.registerExtension === 'function') {
        app.registerExtension({ name: 'godot-imagegen.bridge', setup: function () {} })
      }
    } catch (e) { /* ignore */ }
  })
})()
