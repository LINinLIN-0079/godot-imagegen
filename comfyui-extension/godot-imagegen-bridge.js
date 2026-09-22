/**
 * godot-imagegen bridge — a ComfyUI web extension.
 *
 * This file is the SOURCE OF TRUTH and lives in the plugin's own repository. At
 * install time the host substitutes the two placeholders below and copies the
 * result into the ComfyUI install:
 *
 *   __DSH_ORIGIN__  the DeepSeek Harness web origin (e.g. http://127.0.0.1:43120)
 *   __TOKEN__       a per-install secret, so no other local page can drive the canvas
 *
 * What it does: long-polls the DSH host on the poll interval and, when the host
 * has an instruction, either loads a workflow onto the canvas with
 * `app.loadGraphData` or applies a patch. It also reports the canvas back up, so
 * the agent can see what the user is actually working on rather than guessing.
 *
 * Why there are no imports: ComfyUI's own extensions commonly do
 * `import { app } from "../../scripts/app.js"`, but that path only exists in some
 * frontend builds. Waiting for the app object instead works on every build and
 * does not depend on how the frontend chose to load this file (module or classic
 * script).
 */
(function () {
  'use strict'

  var DSH_ORIGIN = '__DSH_ORIGIN__'
  var TOKEN = '__TOKEN__'
  var POLL_MS = 1500
  /** After this many consecutive failures, back off instead of hammering. */
  var MAX_ERRORS = 8

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
      if (app.workflowManager && typeof app.workflowManager.activeWorkflow === 'object' && app.workflowManager.activeWorkflow) {
        title = String(app.workflowManager.activeWorkflow.name || '')
      }
    } catch (e) { /* older builds */ }
    return {
      nodeCount: nodes.length,
      classes: Object.keys(classes).sort(),
      missingClasses: missing,
      title: title,
    }
  }

  /** Ask the host for instructions; report the canvas state on the way up. */
  function poll(state, ack) {
    return fetch(DSH_ORIGIN + '/gig/bridge/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, state: state, ack: ack || [] }),
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
  }

  /** Put a UI-format workflow on the canvas. */
  function loadGraph(graph) {
    var app = findApp()
    if (!app) throw new Error('ComfyUI app 尚未就绪')
    if (typeof app.loadGraphData !== 'function') throw new Error('此 ComfyUI 版本没有 app.loadGraphData')
    return app.loadGraphData(graph)
  }

  function start(app) {
    // Bookkeeping only: registering makes this extension visible in the
    // extension list on builds that track it. The polling below does not depend
    // on it.
    try {
      if (typeof app.registerExtension === 'function') {
        app.registerExtension({ name: 'godot-imagegen.bridge', setup: function () {} })
      }
    } catch (e) { /* ignore */ }

    var errors = 0
    var pendingAck = []

    function tick() {
      var state = summarizeGraph()
      var ack = pendingAck
      pendingAck = []
      poll(state, ack).then(function (result) {
        errors = 0
        var commands = (result && result.commands) || []
        for (var i = 0; i < commands.length; i++) {
          var command = commands[i]
          try {
            if (command.kind === 'workflow.load' && command.payload && command.payload.graph) {
              loadGraph(command.payload.graph)
            }
          } catch (e) {
            // Report the failure instead of swallowing it: the agent needs to
            // know the canvas refused the graph.
            console.warn('[godot-imagegen] 载入工作流失败', e)
          }
          pendingAck.push(command.id)
        }
      }).catch(function () {
        errors += 1
      })
      var delay = errors > MAX_ERRORS ? Math.min(POLL_MS * 8, POLL_MS * errors) : POLL_MS
      setTimeout(tick, delay)
    }

    console.info('[godot-imagegen] bridge 已启动，宿主：' + DSH_ORIGIN)
    tick()
  }

  waitForApp(60000).then(function (app) {
    if (!app) {
      console.warn('[godot-imagegen] 等不到 ComfyUI app 对象，bridge 未启动')
      return
    }
    start(app)
  })
})()
