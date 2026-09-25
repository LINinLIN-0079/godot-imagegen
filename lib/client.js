/**
 * godot-imagegen — browser half of the godot-imagegen plugin.
 *
 * Registers ONE tab into the dsh-better-sidebar service (`ctx.betterSidebar`):
 * 「美术工坊」(Art Studio). It has three shapes, decided by where the tab lives:
 *
 *   1. ENTRY (docked in the sidebar, the default) — a compact status strip plus
 *      the ways in: start a backend, expand the full workbench, run a workflow.
 *      The sidebar is ~430px wide, which is not a place to put a node canvas.
 *   2. WORKBENCH (floating, or the user asked to expand) — a responsive layout:
 *      three columns when the element is wide (gallery / ComfyUI canvas /
 *      parameters), stacked sections when it is narrow.
 *   3. FULLSCREEN — the same workbench with the FLOAT WINDOW's geometry patched
 *      to the viewport. Nothing is moved between panes: only the float entry's
 *      x/y/w/h change, so a bug here can never corrupt the sidebar layout.
 *
 * Floating is a USER gesture (drag the tab into the conversation area). This
 * plugin deliberately does not do the pane-tree surgery that floating a docked
 * tab would need, because that would couple it to dsh-better-sidebar's internal
 * state shape. Once floating, the geometry is fair game (it persists per
 * session), so fullscreen/restore work entirely through the public
 * `store.reduce`.
 *
 * The agent drives this panel through the host's UI command queue: the same 1.5s
 * poll that watches jobs carries this panel's state UP and pulls queued
 * instructions DOWN (see the `image_workshop` tool). 「发送到对话」 goes the other
 * way, through the public `conversation.input` service.
 *
 * This file is served verbatim by the client-modules node half at
 * /plugins/godot-imagegen/client.js and runs as a classic script, so it must
 * stay plain JavaScript in the CJS-factory handoff format and may only require
 * seed words / registered graph modules ('react' is the only one used).
 */
window.__ModuleLoader__.load({
  id: 'godot-imagegen',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useState, useEffect, useCallback, useMemo, useRef } = React
    const h = React.createElement

    // ── theme tokens (DSH CSS variables) with neutral fallbacks ──
    const token = (name, fallback) => `var(${name}, ${fallback})`
    const C = {
      text: token('--dsh-text', '#e6e8ee'),
      dim: token('--dsh-text-dim', '#98a0b3'),
      border: token('--dsh-border', 'rgba(255,255,255,0.12)'),
      panel: token('--dsh-panel', 'rgba(255,255,255,0.035)'),
      panel2: token('--dsh-panel-strong', 'rgba(255,255,255,0.07)'),
      accent: token('--dsh-accent', '#4f8cff'),
      bg: token('--dsh-bg', '#161a22'),
      ok: '#3fb27f',
      warn: '#d98e3f',
      err: '#e05a5a',
      radius: '8px',
    }

    const s = {
      root: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', color: C.text, fontSize: '12px', height: '100%', overflow: 'auto', boxSizing: 'border-box' },
      card: { border: `1px solid ${C.border}`, borderRadius: C.radius, background: C.panel, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', cursor: 'pointer', userSelect: 'none' },
      title: { fontWeight: 600, fontSize: '12px', letterSpacing: '0.2px' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', minWidth: 0 },
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' },
      grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' },
      label: { color: C.dim, fontSize: '11px' },
      input: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '5px 7px', fontSize: '12px', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },
      textarea: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '6px 7px', fontSize: '12px', width: '100%', boxSizing: 'border-box', minHeight: '62px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 },
      btn: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
      btnPrimary: { background: C.accent, color: '#fff', border: '1px solid transparent', borderRadius: '6px', padding: '7px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
      btnTiny: { background: 'transparent', color: C.dim, border: `1px solid ${C.border}`, borderRadius: '5px', padding: '2px 6px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: '4px', border: `1px solid ${C.border}`, borderRadius: '999px', padding: '1px 7px', fontSize: '10px', color: C.dim, whiteSpace: 'nowrap' },
      dot: (on) => ({ width: '7px', height: '7px', borderRadius: '50%', background: on ? C.ok : C.err, flex: '0 0 auto' }),
      bar: { height: '5px', borderRadius: '3px', background: C.panel2, overflow: 'hidden' },
      barFill: { height: '100%', background: C.accent, transition: 'width .3s ease' },
      thumbGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '6px' },
      thumb: (active) => ({ border: `2px solid ${active ? C.accent : 'transparent'}`, borderRadius: '6px', overflow: 'hidden', cursor: 'pointer', background: C.panel2, aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center' }),
      img: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
      modal: { background: C.bg, border: `1px solid ${C.border}`, borderRadius: '10px', maxWidth: '92vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      modalBody: { display: 'flex', gap: '14px', padding: '14px', overflow: 'auto', flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: C.dim, wordBreak: 'break-all' },
      toastWrap: { position: 'fixed', right: '16px', bottom: '16px', zIndex: 4100, display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '380px' },
      toast: (kind) => ({ background: C.bg, border: `1px solid ${kind === 'error' ? C.err : kind === 'ok' ? C.ok : C.border}`, borderRadius: '8px', padding: '8px 10px', fontSize: '12px', color: C.text, boxShadow: '0 6px 22px rgba(0,0,0,.35)' }),
      frame: { border: `1px solid ${C.border}`, borderRadius: C.radius, overflow: 'hidden', background: '#fff', minHeight: '320px', flex: 1, position: 'relative', display: 'flex' },
    }

    // ── icons (inline SVG, no icon dependency) ──
    const svg = (size, children) => h('svg', { width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }, children)
    const IconBrush = (size) => svg(size, [
      h('path', { key: 'a', d: 'M9.5 14.5 3 21' }),
      h('path', { key: 'b', d: 'M14 4.5a3.5 3.5 0 0 1 5 5L12 16.5l-5-5Z' }),
      h('path', { key: 'c', d: 'M7 18c0 1.5-1 2.5-2.5 3' }),
    ])

    // ── same-origin JSON helper over the plugin's /gig routes ──
    async function api(path, options) {
      const res = await fetch(path, options)
      let body = null
      try { body = await res.json() } catch { /* non-JSON error body */ }
      if (!res.ok) {
        throw new Error((body && typeof body.error === 'string' && body.error) || '请求失败（' + res.status + '）')
      }
      return body
    }
    const postJson = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })

    /**
     * Where this page is served from.
     *
     * The ComfyUI canvas is a different origin, so the bridge extension can only
     * call back to an absolute URL — and it has to be THIS one, not a guess. Read
     * it from the page, and return undefined rather than a made-up default when
     * there is no window (tests, SSR), so the host can apply its own fallback.
     */
    function dshOrigin() {
      try {
        if (typeof window === 'undefined' || !window.location) return undefined
        const origin = window.location.origin
        return typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : undefined
      } catch { return undefined }
    }

    /**
     * Trim free text; a blank box means "not provided" rather than "".
     * The host tolerates "" as well, but keeping meaningless values off the wire
     * makes the request readable and avoids tripping a neighbour's validator
     * (godot-asset-planner's optionalString does reject "").
     */
    const trimText = (value) => {
      const trimmed = String(value == null ? '' : value).trim()
      return trimmed === '' ? undefined : trimmed
    }

    const humanSize = (bytes) => {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }
    const basename = (p) => String(p || '').split(/[\\/]/).pop() || ''

    const CATEGORY_LABELS = {
      character: '角色', item: '道具图标', ui: 'UI 素材', tile: '瓦片',
      background: '背景', texture: '3D 贴图', concept: '概念图',
    }
    const categoryLabel = (c) => CATEGORY_LABELS[c] || c

    // ────────────────────────── panel placement ──────────────────────────

    /**
     * Where this tab currently lives. `known` is false when the sidebar service
     * is unavailable (or reports no state yet), in which case the panel shows the
     * full workbench — a narrower default would hide the tool behind a guess.
     */
    function readPlacement(service, tabId) {
      if (!service || typeof service.getSnapshot !== 'function') return { known: false, floating: false }
      try {
        const snapshot = service.getSnapshot()
        const state = snapshot && snapshot.state
        if (!state || !Array.isArray(state.floats)) return { known: false, floating: false }
        return { known: true, floating: state.floats.some((f) => f && f.tab && f.tab.id === tabId) }
      } catch {
        return { known: false, floating: false }
      }
    }

    function usePlacement(props) {
      const service = props && props.ctx ? props.ctx.betterSidebar : undefined
      const tabId = props && props.tab ? props.tab.id : undefined
      const [placement, setPlacement] = useState(() => readPlacement(service, tabId))
      useEffect(() => {
        if (!service || typeof service.subscribeState !== 'function') return undefined
        const refresh = () => setPlacement(readPlacement(service, tabId))
        refresh()
        return service.subscribeState(refresh)
      }, [service, tabId])
      return { placement, service, tabId }
    }

    /** The geometry a float returns to when leaving fullscreen. */
    const DEFAULT_FLOAT = { w: 390, h: 780 }

    /**
     * Patch ONE float entry's geometry through the store's public reducer.
     *
     * Deliberately narrow: it only ever rewrites x/y/w/h of the entry whose tab
     * id matches, so a bug here cannot rearrange panes or lose a tab. Returns
     * false (changing nothing) when the tab is not floating.
     */
    function patchFloatGeometry(store, tabId, geometry) {
      if (!store || typeof store.reduce !== 'function' || !tabId) return false
      try {
        let applied = false
        store.reduce((state) => {
          if (!state || !Array.isArray(state.floats)) return state
          let changed = false
          const floats = state.floats.map((entry) => {
            if (!entry || !entry.tab || entry.tab.id !== tabId) return entry
            changed = true
            return Object.assign({}, entry, geometry)
          })
          if (!changed) return state
          applied = true
          return Object.assign({}, state, { floats })
        })
        return applied
      } catch {
        return false
      }
    }

    /** Remember the float geometry in the tab's own meta so it survives a reload. */
    function rememberGeometry(service, tab, geometry) {
      if (!service || typeof service.updateTab !== 'function' || !tab || !tab.id) return
      try {
        service.updateTab(tab.id, { meta: Object.assign({}, tab.meta || {}, { gigFloat: geometry }) })
      } catch { /* persistence is best-effort */ }
    }

    function useFullscreen(props, placement) {
      const store = props ? props.store : undefined
      const tab = props ? props.tab : undefined
      const service = props && props.ctx ? props.ctx.betterSidebar : undefined
      const [isFull, setIsFull] = useState(false)
      const lastGeometry = useRef((tab && tab.meta && tab.meta.gigFloat) || null)

      const enter = useCallback(() => {
        if (!placement.floating) return false
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800
        const current = lastGeometry.current
        // Remember where to come back to before expanding.
        const restore = current && current.w < vw - 8 && current.h < vh - 8
          ? current
          : Object.assign({}, DEFAULT_FLOAT, {
            x: Math.max(0, Math.round((vw - DEFAULT_FLOAT.w) / 2)),
            y: Math.max(0, Math.round((vh - DEFAULT_FLOAT.h) / 2)),
          })
        const ok = patchFloatGeometry(store, tab && tab.id, { x: 0, y: 0, w: vw, h: vh })
        if (ok) {
          lastGeometry.current = restore
          rememberGeometry(service, tab, restore)
          setIsFull(true)
        }
        return ok
      }, [placement.floating, store, service, tab])

      const exit = useCallback(() => {
        const restore = lastGeometry.current || Object.assign({}, DEFAULT_FLOAT)
        const ok = patchFloatGeometry(store, tab && tab.id, {
          x: typeof restore.x === 'number' ? restore.x : 40,
          y: typeof restore.y === 'number' ? restore.y : 40,
          w: typeof restore.w === 'number' ? restore.w : DEFAULT_FLOAT.w,
          h: typeof restore.h === 'number' ? restore.h : DEFAULT_FLOAT.h,
        })
        if (ok) setIsFull(false)
        return ok
      }, [store, tab])

      return { isFull, enter, exit, canFullscreen: placement.floating }
    }

    /** Observe an element's width (0 until measured, e.g. without a DOM). */
    function useElementWidth(ref) {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            setWidth(entry.contentRect ? entry.contentRect.width : 0)
          }
        })
        observer.observe(node)
        setWidth(node.clientWidth || 0)
        return () => observer.disconnect()
      }, [ref])
      return width
    }

    // ────────────────────────── conversation bridge ──────────────────────────

    /**
     * Put text into the composer draft through the public conversation service.
     *
     * The shape is the one dsh-better-sidebar itself uses:
     * `ctx.get('conversation').input.for(ctx.sessions.scope(sessionId))`. Every
     * step is probed because a missing service must degrade to a message, not a
     * crash — the panel is still useful without it.
     */
    function sendToConversation(ctx, scope, text) {
      try {
        if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: '对话服务不可用' }
        const conversation = ctx.get('conversation')
        if (!conversation || typeof conversation.input !== 'object' || typeof conversation.input.for !== 'function') {
          return { ok: false, reason: '对话输入服务不可用（请确认当前会话已打开）' }
        }
        const sessionId = scope && scope.sessionId ? scope.sessionId : ''
        const sessions = ctx.sessions
        const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
        if (!actx) return { ok: false, reason: '拿不到当前会话的上下文' }
        const input = conversation.input.for(actx)
        if (!input || typeof input.setDraft !== 'function') return { ok: false, reason: '对话输入服务不可用' }
        let draft = ''
        try {
          if (input.state && typeof input.state.getState === 'function') draft = String(input.state.getState().draft || '')
          else if (input.state && typeof input.state.getSnapshot === 'function') draft = String(input.state.getSnapshot().draft || '')
        } catch { /* reading the draft is best-effort */ }
        input.setDraft(draft + (draft === '' ? '' : '\n') + text)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    // ────────────────────────── shared bits ──────────────────────────

    function Section(props) {
      const [open, setOpen] = useState(props.defaultOpen !== false)
      // A collapsed section normally UNMOUNTS its body. For the ComfyUI canvas that
      // is destructive: unmounting the iframe throws the whole ComfyUI page away, so
      // re-expanding it reloads the frontend from scratch — which drops the bridge
      // connection and everything the page was holding. Sections that opt into
      // keepMounted hide their children instead of destroying them.
      const body = props.keepMounted === true
        ? h('div', { style: { display: open ? 'block' : 'none' } }, props.children)
        : (open ? props.children : null)
      return h('div', { style: Object.assign({}, s.card, props.style || {}) },
        h('div', { style: s.head, onClick: () => setOpen(!open) },
          h('span', { style: s.title }, (open ? '▾ ' : '▸ ') + props.title),
          props.right ? h('span', { style: s.row, onClick: (e) => e.stopPropagation() }, props.right) : null,
        ),
        body,
      )
    }

    function BackendCard(props) {
      const { backends, postProcessing, busy, onStart, onStop, onRefresh } = props
      return h(Section, {
        title: '后端',
        right: h('button', { style: s.btnTiny, onClick: onRefresh, disabled: busy }, '刷新'),
      },
      (backends || []).map((b) => h('div', { key: b.id, style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
        h('div', { style: s.row },
          h('span', { style: s.dot(b.running) }),
          h('span', { style: { fontWeight: 600 } }, b.label),
          h('span', { style: s.pill }, ':' + b.port),
          b.managed ? h('span', { style: s.pill }, '插件已启动') : null,
          h('span', { style: { flex: 1 } }),
          b.running
            ? h('button', { style: s.btnTiny, disabled: busy || !b.managed, title: b.managed ? '停止本插件启动的实例' : '非本插件启动，拒绝终止', onClick: () => onStop(b.id) }, '停止')
            : h('button', { style: s.btnTiny, disabled: busy, onClick: () => onStart(b.id) }, '启动'),
        ),
        h('div', { style: { color: C.dim, fontSize: '11px', lineHeight: 1.4 } }, b.detail || ''),
        b.running && b.models && b.models.length > 0
          ? h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.4 } }, '模型：' + b.models.join('、'))
          : null,
      )),
      h('div', { style: { color: C.dim, fontSize: '11px', borderTop: `1px solid ${C.border}`, paddingTop: '6px' } },
        (postProcessing && postProcessing.ready ? '✓ ' : '✗ ') + ((postProcessing && postProcessing.detail) || '')),
      )
    }

    function SettingsCard(props) {
      const { output, settings, onSave } = props
      const [project, setProject] = useState((settings && settings.godotProject) || '')
      const [outDir, setOutDir] = useState((settings && settings.outDir) || '')
      useEffect(() => { setProject((settings && settings.godotProject) || '') }, [settings && settings.godotProject])
      useEffect(() => { setOutDir((settings && settings.outDir) || '') }, [settings && settings.outDir])
      const dirty = project !== ((settings && settings.godotProject) || '') || outDir !== ((settings && settings.outDir) || '')
      return h(Section, { title: '设置', defaultOpen: !(settings && settings.godotProject) },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: s.label }, 'Godot 项目根目录'),
          h('input', {
            style: s.input, value: project, placeholder: 'D:/my-game（留空则输出到 DSH_HOME）',
            onChange: (e) => setProject(e.target.value),
          }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: s.label }, '输出根目录（覆盖）'),
          h('input', {
            style: s.input, value: outDir, placeholder: '默认 <项目>/assets/generated',
            onChange: (e) => setOutDir(e.target.value),
          }),
        ),
        h('div', { style: s.mono }, '当前输出：' + ((output && output.root) || '?')),
        output && output.godotProject
          ? h('div', { style: { color: C.ok, fontSize: '11px' } }, 'res:// 映射可用')
          : h('div', { style: { color: C.warn, fontSize: '11px' } }, '未配置 Godot 项目：不会产生 res:// 路径'),
        h('button', {
          style: Object.assign({}, s.btn, { width: '100%', opacity: dirty ? 1 : 0.5 }),
          disabled: !dirty,
          onClick: () => onSave({ godotProject: project, outDir: outDir }),
        }, dirty ? '保存设置' : '已保存'),
      )
    }

    // ────────────────────────── the SD WebUI form ──────────────────────────
    //
    // This form is SD WebUI ONLY by design: ComfyUI is driven from the canvas and
    // the workflow library, where its graph is actually visible. A ComfyUI
    // backend selector here would invite configuring a graph you cannot see.

    function PromptForm(props) {
      const { form, setForm, presets, categories, defaults, controlTypes, models, busy, onGenerate, onSavePreset, sdwebuiReady, currentModel } = props
      const set = (key) => (e) => {
        const value = e && e.target ? e.target.value : e
        setForm((f) => Object.assign({}, f, { [key]: value }))
      }
      const setNum = (key) => (e) => setForm((f) => Object.assign({}, f, { [key]: Number(e.target.value) }))
      const setBool = (key) => (e) => setForm((f) => Object.assign({}, f, { [key]: e.target.checked }))
      const applyPreset = (id) => {
        const p = (presets || []).find((x) => x.id === id)
        if (!p) return
        setForm((f) => Object.assign({}, f, {
          presetId: id,
          prompt: p.prompt,
          negativePrompt: p.negativePrompt,
          category: p.category,
          width: p.width,
          height: p.height,
          steps: p.steps,
          cfgScale: p.cfgScale,
          transparent: p.transparent,
        }))
      }
      const byCategory = useMemo(() => {
        const out = {}
        ;(presets || []).forEach((p) => {
          const key = p.category || 'concept'
          if (!out[key]) out[key] = []
          out[key].push(p)
        })
        return out
      }, [presets])
      const catDefaults = (defaults && defaults[form.category]) || {}

      return h(Section, { title: '出图（SD WebUI）' },
        sdwebuiReady === false
          ? h('div', { style: { color: C.warn, fontSize: '11px', lineHeight: 1.5 } },
              'SD WebUI 未运行。这个表单只走 SD WebUI；ComfyUI 请用上方的画布与工作流。')
          : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: s.label }, '提示词预设'),
          h('select', { style: s.input, value: form.presetId || '', onChange: (e) => applyPreset(e.target.value) },
            h('option', { value: '' }, '— 选择预设 —'),
            Object.keys(byCategory).map((cat) => h('optgroup', { key: cat, label: categoryLabel(cat) },
              byCategory[cat].map((p) => h('option', { key: p.id, value: p.id }, p.name + (p.builtin ? '' : ' *'))),
            )),
          ),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: s.label }, '正向提示词'),
          h('textarea', { style: s.textarea, value: form.prompt || '', onChange: set('prompt'), placeholder: 'masterpiece, best quality, ...' }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: s.label }, '负向提示词'),
          h('textarea', { style: Object.assign({}, s.textarea, { minHeight: '42px' }), value: form.negativePrompt || '', onChange: set('negativePrompt') }),
        ),
        h('div', { style: s.grid2 },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '品类'),
            h('select', { style: s.input, value: form.category, onChange: (e) => {
              const category = e.target.value
              const d = (defaults && defaults[category]) || {}
              setForm((f) => Object.assign({}, f, {
                category,
                width: d.width || f.width,
                height: d.height || f.height,
                steps: d.steps || f.steps,
                cfgScale: d.cfgScale || f.cfgScale,
                transparent: !!d.transparent,
                seamless: category === 'tile' || category === 'texture',
              }))
            } },
              (categories || []).map((c) => h('option', { key: c, value: c }, categoryLabel(c))),
            ),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '模型'),
            h('select', { style: s.input, value: form.model || '', onChange: set('model') },
              // "No model chosen" is not "no model": A1111 keeps whatever is
              // loaded, and on this machine that meant a 512²/12-step request ran
              // on SDXL and took 231s instead of ~5s on SD1.5. Naming the effective
              // checkpoint is what makes that choice visible.
              h('option', { value: '' }, currentModel ? `— 后端当前：${currentModel} —` : '— 后端默认 —'),
              (models || []).map((m) => h('option', { key: m, value: m }, m)),
            ),
          ),
        ),
        h('div', { style: s.grid3 },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '宽'),
            h('input', { style: s.input, type: 'number', step: 64, value: form.width, onChange: setNum('width') }),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '高'),
            h('input', { style: s.input, type: 'number', step: 64, value: form.height, onChange: setNum('height') }),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '张数'),
            h('input', { style: s.input, type: 'number', min: 1, max: 8, value: form.count, onChange: setNum('count') }),
          ),
        ),
        h('div', { style: s.grid3 },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '步数'),
            h('input', { style: s.input, type: 'number', value: form.steps, onChange: setNum('steps') }),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, 'CFG'),
            h('input', { style: s.input, type: 'number', step: 0.5, value: form.cfgScale, onChange: setNum('cfgScale') }),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '种子'),
            h('input', { style: s.input, type: 'number', value: form.seed, onChange: setNum('seed') }),
          ),
        ),
        h('div', { style: s.row },
          h('label', { style: s.row },
            h('input', { type: 'checkbox', checked: !!form.transparent, onChange: setBool('transparent') }),
            h('span', {}, '透明背景'),
          ),
          h('label', { style: s.row },
            h('input', { type: 'checkbox', checked: !!form.seamless, onChange: setBool('seamless') }),
            h('span', {}, '无缝平铺'),
          ),
        ),
        form.transparent
          ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              h('span', { style: s.label }, '透明方式'),
              h('select', { style: s.input, value: form.transparentMethod, onChange: set('transparentMethod') },
                h('option', { value: 'auto' }, 'auto（rembg，失败回落色键）'),
                h('option', { value: 'rembg' }, 'rembg（AI 抠图，首次下载模型）'),
                h('option', { value: 'chroma' }, 'chroma（纯色背景抠图）'),
                h('option', { value: 'generative' }, 'generative（ComfyUI layerdiffuse 直出）'),
              ),
            )
          : null,
        h('div', { style: s.grid2 },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, 'ControlNet'),
            h('select', { style: s.input, value: form.controlType || '', onChange: (e) => setForm((f) => Object.assign({}, f, { controlType: e.target.value })) },
              h('option', { value: '' }, '— 不用 —'),
              (controlTypes || []).map((t) => h('option', { key: t, value: t }, t)),
            ),
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('span', { style: s.label }, '控制图路径'),
            h('input', { style: s.input, value: form.controlImage || '', placeholder: '绝对路径 / res://', onChange: set('controlImage') }),
          ),
        ),
        h('div', { style: s.grid2 },
          h('button', { style: Object.assign({}, s.btnPrimary, { width: '100%' }), disabled: busy || !form.prompt, onClick: onGenerate },
            busy ? '生成中…' : '生成'),
          h('button', { style: Object.assign({}, s.btn, { width: '100%' }), disabled: !form.prompt, onClick: onSavePreset }, '存为预设'),
        ),
        h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.4 } },
          (catDefaults.hint || '') + (form.category === 'tile' || form.category === 'texture' ? '（默认做无缝处理）' : '')),
      )
    }

    // ────────────────────────── jobs + gallery ──────────────────────────

    function JobsStrip(props) {
      const { jobs, onCancel } = props
      if (!jobs || jobs.length === 0) return null
      return h(Section, { title: '任务 (' + jobs.filter((j) => j.status === 'running').length + ' 运行中)' },
        jobs.slice(0, 6).map((j) => h('div', { key: j.id, style: { display: 'flex', flexDirection: 'column', gap: '4px', borderBottom: `1px solid ${C.border}`, paddingBottom: '6px' } },
          h('div', { style: s.row },
            h('span', { style: s.dot(j.status === 'done') }),
            h('span', { style: { fontWeight: 600 } }, j.label),
            h('span', { style: s.pill }, j.status),
            h('span', { style: { flex: 1 } }),
            j.status === 'running' ? h('button', { style: s.btnTiny, onClick: () => onCancel(j.id) }, '取消') : null,
          ),
          h('div', { style: s.bar },
            h('div', { style: Object.assign({}, s.barFill, { width: ((j.progress == null ? (j.status === 'done' ? 1 : 0.06) : j.progress) * 100).toFixed(1) + '%', background: j.status === 'error' ? C.err : j.status === 'done' ? C.ok : C.accent }) }),
          ),
          h('div', { style: { color: j.status === 'error' ? C.err : C.dim, fontSize: '11px', lineHeight: 1.4, wordBreak: 'break-word' } }, j.message || ''),
          // The advisory is a SEPARATE line on purpose: the message is a running
          // commentary that the next progress update overwrites within
          // milliseconds, so a warning parked there would be unreadable. This line
          // stays for the whole render — which is the point, since it exists to say
          // the render will take a very long time.
          j.advisory ? h('div', { style: { color: C.warn, fontSize: '10px', lineHeight: 1.45, wordBreak: 'break-word' } }, j.advisory) : null,
          j.preview ? h('img', { src: j.preview, style: { maxHeight: '120px', borderRadius: '6px', alignSelf: 'flex-start' } }) : null,
        )),
      )
    }

    function GalleryPane(props) {
      const { images, filter, categories, selectedId, onFilter, onSelect, onRefresh } = props
      return h(Section, { title: '图库 (' + (images || []).length + ')' },
        h('div', { style: s.row },
          h('select', { style: Object.assign({}, s.input, { width: 'auto' }), value: filter, onChange: (e) => onFilter(e.target.value) },
            h('option', { value: '' }, '全部品类'),
            (categories || []).map((c) => h('option', { key: c, value: c }, categoryLabel(c))),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { style: s.btnTiny, onClick: onRefresh }, '刷新'),
        ),
        (images || []).length === 0
          ? h('div', { style: { color: C.dim, fontSize: '11px' } }, '还没有生成的图片。')
          : h('div', { style: s.thumbGrid },
              (images || []).map((image) => h('div', {
                key: image.id,
                style: s.thumb(selectedId === image.id),
                title: image.name + ' · ' + (image.resPath || image.filePath),
                onClick: () => onSelect(image),
              },
                h('img', { src: '/gig/file?id=' + encodeURIComponent(image.id), style: s.img, loading: 'lazy' }),
              )),
            ),
      )
    }

    function Lightbox(props) {
      const { image, plannerProject, busy, onClose, onAction, onRegister } = props
      const [goal, setGoal] = useState('')
      const [assetName, setAssetName] = useState('')
      useEffect(() => { setAssetName(image ? image.name : '') }, [image && image.id])
      if (!image) return null
      const canRegister = !!(image.resPath || image.filePath)
      return h('div', { style: s.overlay, onClick: onClose },
        h('div', { style: s.modal, onClick: (e) => e.stopPropagation() },
          h('div', { style: s.modalBody },
            h('img', { src: '/gig/file?id=' + encodeURIComponent(image.id), style: { maxWidth: '44vw', maxHeight: '74vh', borderRadius: '8px', background: 'repeating-conic-gradient(#333 0% 25%, #3c3c3c 0% 50%) 50% / 18px 18px' } }),
            h('div', { style: { minWidth: '260px', maxWidth: '340px', display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', { style: s.row },
                h('span', { style: s.pill }, categoryLabel(image.category)),
                h('span', { style: s.pill }, image.backend || '?'),
                image.method ? h('span', { style: s.pill }, image.method) : null,
              ),
              h('div', { style: s.mono }, image.resPath || image.filePath),
              h('div', { style: { color: C.dim, fontSize: '11px' } },
                (image.width || '?') + '×' + (image.height || '?') + ' · ' + humanSize(image.size) + ' · seed ' + (image.seed == null ? '?' : image.seed)),
              image.prompt ? h('div', { style: { color: C.dim, fontSize: '11px', maxHeight: '90px', overflow: 'auto', lineHeight: 1.45 } }, image.prompt) : null,
              h('div', { style: s.row },
                h('button', { style: s.btn, disabled: busy, onClick: () => onAction('upscale', image) }, '放大 2×'),
                h('button', { style: s.btn, disabled: busy, onClick: () => onAction('cutout', image) }, '抠透明'),
                h('button', { style: s.btn, disabled: busy, onClick: () => onAction('interrogate', image) }, '反推提示词'),
              ),
              h('div', { style: s.row },
                h('button', { style: s.btn, disabled: busy, onClick: () => onAction('to-conversation', image) }, '发送到对话'),
                h('button', { style: s.btn, disabled: busy, onClick: () => onAction('copy', image) }, '复制路径'),
              ),
              h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '5px' } },
                h('div', { style: { fontWeight: 600 } }, '注册为 Godot 资产'),
                h('div', { style: { color: C.dim, fontSize: '10px' } }, '项目：' + (plannerProject || 'default')),
                h('input', { style: s.input, value: assetName, onChange: (e) => setAssetName(e.target.value), placeholder: '资产名称' }),
                h('input', { style: s.input, value: goal, onChange: (e) => setGoal(e.target.value), placeholder: '关联目标（可选）' }),
                h('button', {
                  style: Object.assign({}, s.btnPrimary, { width: '100%', opacity: canRegister ? 1 : 0.5 }),
                  disabled: !canRegister || !assetName,
                  onClick: () => onRegister(image, assetName, goal),
                }, '一键注册'),
              ),
              h('div', { style: s.row },
                h('button', { style: Object.assign({}, s.btn, { color: C.err }), disabled: busy, onClick: () => onAction('delete', image) }, '删除'),
                h('span', { style: { flex: 1 } }),
                h('button', { style: s.btn, onClick: onClose }, '关闭'),
              ),
            ),
          ),
        ),
      )
    }

    // ────────────────────────── workflow bar + canvas ──────────────────────────

    function WorkflowBar(props) {
      const { workflows, activeId, activeGraph, busy, onPick, onRun, onReload, onSaveToLibrary, canvasOnline, comfyPort } = props
      const active = (workflows || []).find((w) => w.id === activeId)
      return h(Section, { title: 'ComfyUI 工作流' },
        h('div', { style: s.row },
          h('select', {
            style: Object.assign({}, s.input, { flex: 1, minWidth: '120px' }),
            value: activeId || '',
            onChange: (e) => onPick(e.target.value),
          },
            h('option', { value: '' }, '— 选择工作流 —'),
            (workflows || []).map((w) => h('option', { key: w.id, value: w.id }, `${w.name}（${w.nodeCount} 节点）`)),
          ),
          h('button', { style: s.btnTiny, disabled: busy || !activeId, onClick: onReload }, '重载'),
        ),
        active
          ? h('div', { style: { color: C.dim, fontSize: '11px', lineHeight: 1.45 } },
              active.description || '',
              h('div', { style: s.mono }, `${active.nodeCount} 节点 · ${(active.classes || []).slice(0, 6).join(', ')}${(active.classes || []).length > 6 ? '…' : ''}`),
            )
          : h('div', { style: { color: C.dim, fontSize: '11px' } }, '选一个工作流即可在画布里编辑，或直接运行。'),
        h('div', { style: s.row },
          h('button', { style: s.btnPrimary, disabled: busy || !activeId || !canvasOnline, onClick: onRun }, '运行工作流'),
          h('button', { style: s.btn, disabled: busy || !activeGraph, onClick: onSaveToLibrary }, '把画布存回库'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            style: s.btnTiny,
            title: '在系统浏览器里打开完整 ComfyUI',
            onClick: () => { if (typeof window !== 'undefined' && window.open) window.open(`http://127.0.0.1:${comfyPort || 8188}`, '_blank', 'noopener') },
          }, '外部打开'),
        ),
      )
    }

    function CanvasPane(props) {
      const { port, online, busy, reloadKey, onStart, onReload, frameRef } = props
      const url = `http://127.0.0.1:${port || 8188}`
      if (!online) {
        return h('div', { style: Object.assign({}, s.frame, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: C.dim, background: C.panel, padding: '18px', textAlign: 'center' }) },
          h('div', { style: { fontSize: '12px' } }, 'ComfyUI 未运行，画布无法显示。'),
          h('button', { style: s.btnPrimary, disabled: busy, onClick: onStart }, busy ? '启动中…' : '启动 ComfyUI'),
          h('div', { style: { fontSize: '10px', lineHeight: 1.5 } }, '启动约需 1–2 分钟。也可以点「外部打开」在系统浏览器里使用。'),
        )
      }
      return h('div', { style: Object.assign({}, s.frame, { flexDirection: 'column' }) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', background: C.panel, borderBottom: `1px solid ${C.border}` } },
          h('span', { style: s.dot(true) }),
          h('span', { style: { color: C.dim, fontSize: '10px' } }, `画布：${url}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: s.btnTiny, onClick: onReload }, '重新载入画布'),
        ),
        h('iframe', {
          key: reloadKey,
          ref: frameRef,
          src: url,
          title: 'ComfyUI',
          style: { flex: 1, width: '100%', border: '0', display: 'block', background: '#fff' },
          allow: 'clipboard-read; clipboard-write',
        }),
      )
    }

    /**
     * The bridge between this panel and the ComfyUI canvas inside the iframe.
     *
     * The iframe is a foreign page, so nothing here can reach into it: the only
     * way the agent's workflow edits appear on the canvas is the small web
     * extension this card installs into ComfyUI. That is why the card says
     * plainly whether the extension is on disk AND whether a canvas is
     * answering — those are two different facts, and the usual reason "nothing
     * happens" is that ComfyUI has not been restarted since the install.
     */
    function BridgeCard(props) {
      const { bridge, busy, onInstall, onUninstall, onPush, onRefresh, canPush, run } = props
      const installed = !!(bridge && bridge.installed)
      const canvas = (bridge && bridge.canvas) || {}
      const canvasOnline = !!canvas.online
      const nodes = canvas.nodeCount
      const errors = (bridge && Array.isArray(bridge.errors)) ? bridge.errors : []
      return h(Section, { title: '画布桥接（对话 ↔ ComfyUI）' },
        h('div', { style: s.row },
          h('span', { style: s.dot(installed) }),
          h('span', null, installed ? '扩展已安装' : '扩展未安装'),
          h('span', { style: { flex: 1 } }),
          installed
            ? h('button', { style: s.btnTiny, disabled: busy, onClick: onUninstall }, '卸载扩展')
            : h('button', { style: s.btnPrimary, disabled: busy, onClick: onInstall }, '安装到 ComfyUI'),
          h('button', { style: s.btnTiny, disabled: busy, onClick: onRefresh }, '刷新'),
        ),
        h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.55 } }, (bridge && bridge.detail) || '正在读取扩展状态…'),
        installed
          ? h('div', { style: s.row },
              h('span', { style: s.dot(canvasOnline) }),
              h('span', { style: { fontSize: '10px', color: C.dim } }, canvasStatusLine(canvas, nodes, canvasOnline)),
            )
          : h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.55 } },
              '装上之后，你（或代理）在对话里说“把 item-icon 放到画布上”，画布就会真的切过去，不必手动导入 JSON。'
              + '未安装时画布依然能手动画，只是对话改不动它。',
            ),
        installed && bridge && bridge.stale
          ? h('div', { style: { color: C.warn, fontSize: '10px' } }, '磁盘上的副本与插件源码不一致：重新点一次「安装到 ComfyUI」即可同步。')
          : null,
        installed && canvasOnline && canPush
          ? h('button', { style: Object.assign({}, s.btn, { width: '100%' }), disabled: busy, onClick: onPush }, '把当前工作流推到画布')
          : null,
        run
          ? h('div', { style: { color: C.ok, fontSize: '10px', lineHeight: 1.5 } }, runLine(run))
          : null,
        installed && canvasTitle(canvas)
          ? h('div', { style: { color: C.dim, fontSize: '10px' } }, `画布正在编辑：${canvasTitle(canvas)}`)
          : null,
        installed && Array.isArray(canvas.missingClasses) && canvas.missingClasses.length > 0
          ? h('div', { style: { color: C.warn, fontSize: '10px', lineHeight: 1.5 } },
              `画布缺少这些节点类型，工作流跑不起来：${canvas.missingClasses.join('、')}`)
          : null,
        // A graph the canvas refused. Without this the failure would only exist in
        // the host's memory, and the user would see a push that "did nothing".
        errors.length > 0
          ? h('div', { style: { color: C.err, fontSize: '10px', lineHeight: 1.5 } },
              `画布拒绝了最近 ${errors.length} 次载入：`,
              errors.slice(-3).map((entry, index) => h('div', { key: index, style: s.mono }, String((entry && entry.error) || entry))))
          : null,
        installed && bridge && bridge.targetDir ? h('div', { style: s.mono }, bridge.targetDir) : null,
      )
    }
    /** The title the canvas reported, or '' when it reported none. */
    function canvasTitle(canvas) {
      return canvas && typeof canvas.title === 'string' ? canvas.title : ''
    }

    /**
     * The run the host says is in flight.
     *
     * This is what makes "画布上还是最开始那个工作流" impossible to misread: the
     * canvas swaps to the graph that was actually submitted, and this line names
     * it and counts its steps, right where the canvas is.
     */
    function runLine(run) {
      let text = `▶ 正在运行 · ${run.label || 'ComfyUI'}`
      if (run.value !== undefined && run.value !== null && run.max) text += ` · 采样 ${run.value}/${run.max}`
      if (run.nodes) text += ` · ${run.nodes} 个节点`
      return text
    }

    /** Cheap identity, so the 1.5s poll only re-renders when the run changed. */
    function runKey(run) {
      if (run === null || run === undefined) return ''
      return `${run.label}|${run.value}|${run.max}|${run.nodeId}|${run.nodes}`
    }

    /**
     * Hand the canvas envelopes to the ComfyUI iframe.
     *
     * This is the ONLY route into the iframe, and it is deliberately dumb: the
     * panel never reads the token inside an envelope, it just delivers it. The
     * extension on the other side verifies the origin it was installed for.
     */
    function relayToCanvas(frame, origin, messages) {
      if (!frame || typeof frame.postMessage !== 'function') return 0
      if (typeof origin !== 'string' || origin === '') return 0
      let sent = 0
      for (const message of messages || []) {
        if (message === null || typeof message !== 'object') continue
        try { frame.postMessage(message, origin); sent++ } catch { /* the frame navigated */ }
      }
      return sent
    }

    /**
     * Whether a window message really came from our canvas iframe.
     *
     * `event.source` is the check that matters — a page can lie about nothing
     * here, and it keeps another DSH-origin page from feeding us fake canvas
     * state. The envelope shape is only a cheap pre-filter.
     */
    function isCanvasMessage(event, frame) {
      if (!frame || event.source !== frame) return false
      const data = event.data
      return !!data && typeof data === 'object' && typeof data.__gig === 'string' && typeof data.type === 'string'
    }

    /**
     * What to hand the canvas this tick: the queued instructions, plus the
     * heartbeat the host stamps alongside them.
     *
     * The ping is a separate field precisely because it is NOT a queued command —
     * it carries no seq and needs no ack, so it must not enter the panel's ack
     * bookkeeping. Without it an idle canvas goes quiet: the extension answers
     * only when asked, so the host's 15s liveness window would expire a few
     * seconds after a successful connection and the panel would report
     * "not connected".
     */
    function canvasEnvelopes(response) {
      const queued = (response && Array.isArray(response.canvasMessages)) ? response.canvasMessages : []
      const ping = response && response.canvasPing && typeof response.canvasPing === 'object' ? [response.canvasPing] : []
      return queued.concat(ping)
    }

    /**
     * What the card says about the canvas.
     *
     * Three different facts, three different sentences: an answering canvas, a
     * canvas that answered and then went quiet (reload, navigation, or a closed
     * 「画布」section — which is what a narrow panel shows by default), and one
     * that has never answered at all (usually "restart ComfyUI so it loads the
     * extension"). Collapsing them into one message is how a user ends up
     * restarting a backend that was fine.
     */
    function canvasStatusLine(canvas, nodes, canvasOnline) {
      if (canvasOnline) {
        return `画布已连接${nodes == null ? '' : `（${nodes} 个节点）`}：对话里每次运行都会把当次工作流`
          + '（真实提示词/种子/尺寸）载入画布，正在执行的节点会高亮。注意这会覆盖画布上未保存的改动。'
      }
      const ago = canvas && typeof canvas.lastPollSecondsAgo === 'number' ? canvas.lastPollSecondsAgo : null
      if (ago !== null) {
        return `扩展已安装，但画布已经 ${ago} 秒没应声了：多半是本页的「画布」没打开着`
          + '（面板窄时它默认折叠），或者画布被重载过。打开/重载「画布」即可。'
      }
      return '扩展已安装，但画布还没连上：重启 ComfyUI（它只在启动时读扩展），再打开本页的「画布」。'
    }

    function AgentHint(props) {
      const { lastCommand, panelOnline } = props
      return h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.5 } },
        lastCommand
          ? `代理最近一次操作：${lastCommand}`
          : (panelOnline ? '代理指令通道已连接。' : '代理指令通道未连接。'),
      )
    }

    // ────────────────────────── entry view ──────────────────────────

    function EntryView(props) {
      const { backends, busy, onStart, onStop, onOpenWorkbench, onRefresh, workflows, activeId, onPick, onRun } = props
      const comfy = (backends || []).find((b) => b.id === 'comfyui')
      const sd = (backends || []).find((b) => b.id === 'sdwebui')
      const backendRow = (label, b, port) => h('div', { style: s.row },
        h('span', { style: s.dot(!!(b && b.running)) }),
        h('span', { style: { fontWeight: 600 } }, label),
        h('span', { style: s.pill }, ':' + ((b && b.port) || port)),
        b && b.managed ? h('span', { style: s.pill }, '插件已启动') : null,
        h('span', { style: { flex: 1 } }),
        // A running backend shows 停止 — disabled unless THIS plugin spawned it,
        // because the plugin never terminates an instance it did not start. The
        // tooltip is the explanation, not a silently missing button.
        b && b.running
          ? h('button', {
              style: s.btnTiny,
              disabled: busy || !b.managed,
              title: b.managed ? '停止本插件启动的实例' : '非本插件启动，拒绝终止（用绘世启动器或控制台关闭）',
              onClick: () => onStop(b.id),
            }, '停止')
          : h('button', { style: s.btnTiny, disabled: busy, onClick: () => onStart(b ? b.id : label) }, '启动'),
      )
      return h('div', { style: s.root },
        h('div', { style: s.card },
          backendRow('ComfyUI', comfy, 8188),
          backendRow('SD WebUI', sd, 7860),
          h('button', { style: s.btnTiny, onClick: onRefresh }, '刷新状态'),
        ),
        h('div', { style: s.card },
          h('div', { style: s.title }, '打开工作台'),
          h('div', { style: { color: C.dim, fontSize: '11px', lineHeight: 1.5 } },
            '侧边栏太窄，放不下 ComfyUI 画布。',
            h('b', null, '右键点本 tab →「移动到自由窗口」'),
            '（英文界面 Move to Free Window）即可变成可缩放浮窗，浮出去之后这里会出现「全屏 / 回浮窗」按钮。',
          ),
          h('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.5 } },
            '把 tab 拖到主会话区是同一功能的另一种手势，但它在部分 DSH 版本上不生效（dsh-better-sidebar 0.18 找的是旧版槽位名），所以以右键菜单为准。',
          ),
          h('button', { style: Object.assign({}, s.btnPrimary, { width: '100%' }), onClick: onOpenWorkbench }, '在此展开完整工作台'),
        ),
        (workflows || []).length > 0
          ? h(Section, { title: '快速运行工作流' },
              h('select', { style: s.input, value: activeId || '', onChange: (e) => onPick(e.target.value) },
                h('option', { value: '' }, '— 选择工作流 —'),
                (workflows || []).map((w) => h('option', { key: w.id, value: w.id }, `${w.name}（${w.nodeCount} 节点）`)),
              ),
              h('button', {
                style: Object.assign({}, s.btn, { width: '100%' }),
                disabled: busy || !activeId || !(comfy && comfy.running),
                onClick: onRun,
              }, '运行'),
            )
          : null,
      )
    }

    // ────────────────────────── the main tab ──────────────────────────

    function ArtStudio(props) {
      const [state, setState] = useState(null)
      const [jobs, setJobs] = useState([])
      const [gallery, setGallery] = useState([])
      const [selected, setSelected] = useState(null)
      const [busy, setBusy] = useState(false)
      const [plannerProject, setPlannerProject] = useState('default')
      const [filter, setFilter] = useState('')
      const [toasts, setToasts] = useState([])
      const [workflows, setWorkflows] = useState([])
      const [activeWorkflowId, setActiveWorkflowId] = useState('')
      const [activeGraph, setActiveGraph] = useState(null)
      const [canvasReload, setCanvasReload] = useState(0)
      const [uiStatus, setUiStatus] = useState(null)
      // The ComfyUI run the host reported on its last heartbeat (null when idle).
      const [canvasRun, setCanvasRun] = useState(null)
      const [lastCommand, setLastCommand] = useState('')
      const [bridge, setBridge] = useState(null)
      const [forceWorkbench, setForceWorkbench] = useState(false)
      const [uiSection, setUiSection] = useState('form')
      const toastSeq = useRef(0)
      const ackRef = useRef([])
      const applyRef = useRef(() => {})
      const rootRef = useRef(null)
      // The iframe is the canvas; the panel is the only path into it (DSH refuses
      // any request whose frame origin is not the carrier origin, so the iframe
      // cannot talk to the host itself).
      const frameRef = useRef(null)
      const inboundRef = useRef([])
      const comfyPortRef = useRef(8188)
      const [form, setForm] = useState({
        presetId: '', category: 'character',
        prompt: '', negativePrompt: '',
        width: 832, height: 1216, steps: 30, cfgScale: 7,
        seed: -1, count: 1, backend: 'sdwebui', model: '',
        transparent: true, transparentMethod: 'auto', seamless: false,
        controlType: '', controlImage: '',
      })

      const placementInfo = usePlacement(props)
      const placement = placementInfo.placement
      const fullscreen = useFullscreen(props, placement)
      const width = useElementWidth(rootRef)

      const toast = useCallback((kind, text) => {
        const id = ++toastSeq.current
        setToasts((t) => t.concat([{ id, kind, text }]))
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
      }, [])

      const refreshState = useCallback(async () => {
        try {
          const next = await api('/gig/state')
          setState(next)
          setUiStatus(next.ui || null)
        } catch (err) { toast('error', '读取状态失败：' + err.message) }
      }, [toast])

      const refreshWorkflows = useCallback(async () => {
        try {
          const next = await api('/gig/workflows')
          setWorkflows(next.workflows || [])
        } catch { /* the library may not be readable yet */ }
      }, [])

      // The bridge state changes on its own schedule: ComfyUI restarts, a canvas
      // opens or closes. Polling it slowly keeps the card honest without
      // re-reading the installed files on every job tick.
      const refreshBridge = useCallback(async () => {
        try { setBridge(await api('/gig/extension')) } catch { /* host restarting */ }
      }, [])

      const refreshGallery = useCallback(async (category) => {
        try {
          const query = category ? '?category=' + encodeURIComponent(category) : ''
          const next = await api('/gig/gallery' + query)
          setGallery(next.images || [])
        } catch (err) { toast('error', '读取图库失败：' + err.message) }
      }, [toast])

      const pollJobs = useCallback(async () => {
        try {
          const next = await api('/gig/jobs')
          const list = next.jobs || []
          setJobs((prev) => {
            const runningBefore = prev.filter((j) => j.status === 'running').length
            const runningAfter = list.filter((j) => j.status === 'running').length
            if (runningBefore > 0 && runningAfter < runningBefore) {
              refreshGallery(filter)
              refreshState()
            }
            return list
          })
        } catch { /* transient */ }
      }, [filter, refreshGallery, refreshState])

      useEffect(() => { refreshState(); refreshGallery(); refreshWorkflows(); refreshBridge() }, [refreshState, refreshGallery, refreshWorkflows, refreshBridge])
      useEffect(() => { const t = setInterval(pollJobs, 1500); return () => clearInterval(t) }, [pollJobs])
      useEffect(() => { const t = setInterval(refreshBridge, 8000); return () => clearInterval(t) }, [refreshBridge])
      useEffect(() => {
        api('/gap/state').then((r) => { if (r && r.currentProject) setPlannerProject(r.currentProject) }).catch(() => undefined)
      }, [])

      const comfy = useMemo(() => ((state && state.backends) || []).find((b) => b.id === 'comfyui'), [state])
      const sdwebui = useMemo(() => ((state && state.backends) || []).find((b) => b.id === 'sdwebui'), [state])
      const models = useMemo(() => {
        const list = []
        ;((state && state.backends) || []).forEach((b) => { if (b.running && b.id === 'sdwebui') list.push.apply(list, b.models || []) })
        return list
      }, [state])

      // ── the agent's instructions ──

      const applyCommand = useCallback((command) => {
        if (!command || typeof command !== 'object') return
        try {
          const payload = command.payload || {}
          if (command.kind === 'form.fill' && payload.form) {
            setForm((f) => Object.assign({}, f, payload.form))
            setForceWorkbench(true)
            setUiSection('form')
          } else if (command.kind === 'workshop.focus') {
            setForceWorkbench(true)
            setUiSection(String(payload.section || 'form'))
          } else if (command.kind === 'gallery.select') {
            const wanted = String(payload.image || '')
            setGallery((current) => {
              const hit = current.find((g) => g.id === wanted || g.resPath === wanted || g.filePath === wanted
                || (wanted !== '' && basename(g.filePath) === basename(wanted)))
              if (hit) setSelected(hit)
              return current
            })
          } else if (command.kind === 'workflow.load') {
            setActiveWorkflowId(String(payload.id || ''))
            setActiveGraph(payload.graph || null)
            setForceWorkbench(true)
            setUiSection('canvas')
            setCanvasReload((n) => n + 1)
          } else if (command.kind === 'workflow.patch') {
            setActiveGraph(payload.graph || null)
            setCanvasReload((n) => n + 1)
          } else if (command.kind === 'toast') {
            const level = payload.level || 'info'
            toast(level === 'error' ? 'error' : level === 'ok' ? 'ok' : 'info', String(payload.text || ''))
          }
          if (command.label) setLastCommand(command.label)
        } catch (err) {
          toast('error', '代理指令执行失败：' + (err && err.message ? err.message : String(err)))
        }
      }, [toast])
      useEffect(() => { applyRef.current = applyCommand }, [applyCommand])

      // The single round-trip: report what this panel is doing, take instructions,
      // and carry the canvas's messages in both directions.
      useEffect(() => {
        let stopped = false
        const tick = async () => {
          try {
            const ack = ackRef.current
            ackRef.current = []
            const inbound = inboundRef.current
            inboundRef.current = []
            const res = await postJson('/gig/ui/poll', {
              ack,
              inbound,
              state: {
                section: uiSection,
                form: {
                  prompt: form.prompt, negativePrompt: form.negativePrompt, category: form.category,
                  width: form.width, height: form.height, steps: form.steps, cfgScale: form.cfgScale,
                  seed: form.seed, count: form.count, model: form.model, backend: form.backend,
                  transparent: form.transparent, seamless: form.seamless,
                },
                selectedImageId: selected ? selected.id : undefined,
                activeWorkflowId: activeWorkflowId || undefined,
                canvas: { workflowId: activeWorkflowId || undefined, nodeCount: activeGraph && activeGraph.nodes ? activeGraph.nodes.length : undefined },
                // The install bakes this origin into the extension, and the
                // extension can only reach the host it was told about — so the
                // page reports where it is actually served from rather than
                // letting the host guess a port.
                origin: dshOrigin() || undefined,
              },
            })
            if (stopped) return
            setUiStatus(res.status || null)
            const nextRun = (res.canvasPing && res.canvasPing.run) || null
            setCanvasRun((prev) => (runKey(prev) === runKey(nextRun) ? prev : nextRun))
            const commands = res.commands || []
            if (commands.length > 0) {
              for (const command of commands) applyRef.current(command)
              ackRef.current = ackRef.current.concat(commands.map((c) => c.id))
            }
            // Hand the agent's canvas instructions to the iframe, plus the
            // heartbeat. This happens on every tick, so a canvas that is still
            // booting receives them as soon as it is listening — and the heartbeat
            // is what keeps the host's liveness window from expiring on an idle
            // canvas (the extension only speaks when spoken to).
            const frame = frameRef.current ? frameRef.current.contentWindow : null
            if (frame) relayToCanvas(frame, `http://127.0.0.1:${comfyPortRef.current}`, canvasEnvelopes(res))
          } catch { /* the host may be restarting */ }
        }
        tick()
        const t = setInterval(tick, 1500)
        return () => { stopped = true; clearInterval(t) }
      }, [uiSection, form, selected, activeWorkflowId, activeGraph])

      // What the canvas tells us, buffered until the next poll carries it up. The
      // buffer is drained on every tick, so nothing can pile up if the host is
      // briefly unreachable.
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onMessage = (event) => {
          const frame = frameRef.current ? frameRef.current.contentWindow : null
          if (!isCanvasMessage(event, frame)) return
          const buffer = inboundRef.current
          buffer.push(event.data)
          // Bound it: a canvas that spams state must not grow this without limit.
          if (buffer.length > 40) inboundRef.current = buffer.slice(-40)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      // ── actions ──

      const doStart = useCallback(async (backend) => {
        setBusy(true)
        toast('ok', '正在启动 ' + backend + '（首次可能 1-3 分钟）…')
        try {
          const r = await postJson('/gig/backend/start', { backend })
          toast(r && r.ok ? 'ok' : 'error', (r && r.detail) || '')
          await refreshState()
          if (backend === 'comfyui') setCanvasReload((n) => n + 1)
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [refreshState, toast])

      const doStop = useCallback(async (backend) => {
        setBusy(true)
        try {
          const r = await postJson('/gig/backend/stop', { backend })
          toast(r && r.ok ? 'ok' : 'error', (r && r.detail) || '')
          await refreshState()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [refreshState, toast])

      const doSaveSettings = useCallback(async (patch) => {
        setBusy(true)
        try {
          await postJson('/gig/settings', patch)
          await refreshState()
          toast('ok', '设置已保存')
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [refreshState, toast])

      const doGenerate = useCallback(async () => {
        setBusy(true)
        try {
          await postJson('/gig/generate', {
            prompt: form.prompt,
            negativePrompt: trimText(form.negativePrompt),
            category: form.category,
            width: form.width, height: form.height,
            steps: form.steps, cfgScale: form.cfgScale,
            seed: form.seed, count: form.count,
            backend: 'sdwebui',
            model: trimText(form.model),
            transparent: form.transparent,
            transparentMethod: form.transparentMethod,
            seamless: form.seamless,
            projectId: plannerProject,
            controlType: trimText(form.controlType),
            controlImage: trimText(form.controlImage),
          })
          toast('ok', '已提交生成任务')
          pollJobs()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [form, plannerProject, toast, pollJobs])

      const doSavePreset = useCallback(async () => {
        setBusy(true)
        try {
          const responder = typeof window !== 'undefined' ? window.prompt : undefined
          const name = responder ? responder('预设名称', String(form.prompt).slice(0, 20) || '新预设') : null
          if (!name) return
          await postJson('/gig/presets', {
            name, category: form.category, prompt: form.prompt, negativePrompt: form.negativePrompt,
            width: form.width, height: form.height, steps: form.steps, cfgScale: form.cfgScale,
            transparent: form.transparent,
          })
          await refreshState()
          toast('ok', '预设已保存')
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [form, refreshState, toast])

      const doPickWorkflow = useCallback(async (id) => {
        setActiveWorkflowId(id)
        if (!id) { setActiveGraph(null); return }
        setBusy(true)
        try {
          const doc = await api('/gig/workflow?id=' + encodeURIComponent(id))
          setActiveGraph(doc.graph || null)
          toast('ok', `已载入工作流：${(doc.meta && doc.meta.name) || id}`)
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [toast])
      const doRunWorkflow = useCallback(async () => {
        if (!activeWorkflowId) return
        setBusy(true)
        try {
          const r = await postJson('/gig/workflow/run', { id: activeWorkflowId, category: form.category, projectId: plannerProject })
          toast('ok', (r && r.note) || '已提交工作流运行')
          pollJobs()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [activeWorkflowId, form.category, plannerProject, pollJobs, toast])

      const doSaveCanvas = useCallback(async () => {
        if (!activeWorkflowId || !activeGraph) return
        setBusy(true)
        try {
          await postJson('/gig/workflow/save', { id: activeWorkflowId, graph: activeGraph })
          await refreshWorkflows()
          toast('ok', '已存回工作流库')
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [activeWorkflowId, activeGraph, refreshWorkflows, toast])

      const doInstallBridge = useCallback(async () => {
        setBusy(true)
        try {
          const origin = dshOrigin()
          const r = await postJson('/gig/extension/install', origin ? { origin } : {})
          toast(r && r.ok ? 'ok' : 'error', (r && r.detail) || '')
        } catch (err) { toast('error', '安装失败：' + err.message) }
        finally { setBusy(false); refreshBridge() }
      }, [refreshBridge, toast])

      const doUninstallBridge = useCallback(async () => {
        const confirm = typeof window !== 'undefined' ? window.confirm : undefined
        if (confirm && !confirm('卸载画布桥接扩展？\n\n只会删除它自己写进 ComfyUI custom_nodes 的文件（写入前的备份会保留），重启 ComfyUI 后生效。')) return
        setBusy(true)
        try {
          const r = await postJson('/gig/extension/uninstall', {})
          toast(r && r.ok ? 'ok' : 'info', (r && r.detail) || '')
        } catch (err) { toast('error', '卸载失败：' + err.message) }
        finally { setBusy(false); refreshBridge() }
      }, [refreshBridge, toast])

      const doPushToCanvas = useCallback(async () => {
        if (!activeWorkflowId) { toast('error', '先在「ComfyUI 工作流」里选一个工作流'); return }
        setBusy(true)
        try {
          const r = await postJson('/gig/canvas/load', { id: activeWorkflowId })
          toast(r && r.delivered ? 'ok' : 'info', (r && r.note) || '')
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [activeWorkflowId, toast])

      const doSendCurrentPrompt = useCallback(() => {
        const parts = [`【美术工坊】${categoryLabel(form.category)} ${form.width}×${form.height} / ${form.steps} 步 / CFG ${form.cfgScale}`]
        if (form.prompt) parts.push(form.prompt)
        if (form.negativePrompt) parts.push('负向：' + form.negativePrompt)
        const result = sendToConversation(props && props.ctx, props && props.scope, parts.join('\n'))
        if (result.ok) toast('ok', '已发送到对话输入框')
        else toast('error', '发送失败：' + result.reason)
      }, [form, props, toast])

      const doAction = useCallback(async (kind, image) => {
        setBusy(true)
        try {
          if (kind === 'upscale') {
            await postJson('/gig/upscale', { image: image.id, scale: 2, category: image.category, projectId: plannerProject })
            toast('ok', '已提交放大任务')
          } else if (kind === 'cutout') {
            await postJson('/gig/cutout', { image: image.id, method: 'auto', category: image.category, projectId: plannerProject })
            toast('ok', '已提交抠图任务')
          } else if (kind === 'interrogate') {
            await postJson('/gig/interrogate', { image: image.id })
            toast('ok', '已提交反推任务（结果见任务区）')
          } else if (kind === 'to-conversation') {
            const ref = `@${image.name} ${image.resPath || image.filePath}`
            const result = sendToConversation(props && props.ctx, props && props.scope, ref)
            if (result.ok) toast('ok', '已发送到对话输入框')
            else toast('error', '发送失败：' + result.reason)
          } else if (kind === 'copy') {
            const text = image.resPath || image.filePath
            try {
              if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text)
              toast('ok', '已复制：' + text)
            } catch { toast('error', '复制失败，路径：' + text) }
          } else if (kind === 'delete') {
            const confirm = typeof window !== 'undefined' ? window.confirm : undefined
            if (confirm && !confirm('删除该图库记录与磁盘文件？')) return
            await postJson('/gig/gallery/delete', { id: image.id })
            setSelected(null)
            await refreshGallery(filter)
            await refreshState()
            toast('ok', '已删除')
          }
          pollJobs()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [filter, plannerProject, pollJobs, refreshGallery, refreshState, props, toast])

      const doRegister = useCallback(async (image, assetName, goal) => {
        setBusy(true)
        try {
          const body = {
            assetName: String(assetName == null ? '' : assetName).trim(),
            assetType: 'image',
            filePath: image.resPath || image.filePath,
            projectId: plannerProject,
          }
          // godot-asset-planner's optionalString rejects "", so a blank goal box
          // must omit the key entirely (same for a whitespace-only one).
          const linkedGoal = trimText(goal)
          if (linkedGoal !== undefined) body.linkedGoal = linkedGoal
          await postJson('/gap/assets', body)
          toast('ok', '已注册到 Godot 资产库：' + assetName)
        } catch (err) {
          toast('error', '注册失败：' + err.message)
        } finally { setBusy(false) }
      }, [plannerProject, toast])

      // ── render ──

      const filtered = filter ? gallery.filter((g) => g.category === filter) : gallery
      const panelOnline = !!(uiStatus && uiStatus.online)
      const comfyPort = (comfy && comfy.port) || 8188
      // The poll loop must not be torn down and rebuilt every time the backend
      // state refreshes, so it reads the port from a ref.
      comfyPortRef.current = comfyPort

      // Docked in the sidebar (and the user has not asked to expand) → the entry
      // view. An UNKNOWN placement never narrows: showing less by accident is
      // worse than showing more.
      const showEntry = placement.known && !placement.floating && !forceWorkbench
      if (showEntry) {
        return h('div', { ref: rootRef, style: { height: '100%', overflow: 'auto' } },
          h(EntryView, {
            backends: state && state.backends,
            busy,
            onStart: doStart,
            onStop: doStop,
            onRefresh: () => { refreshState(); refreshWorkflows() },
            onOpenWorkbench: () => setForceWorkbench(true),
            workflows,
            activeId: activeWorkflowId,
            onPick: doPickWorkflow,
            onRun: doRunWorkflow,
          }),
          h('div', { style: s.toastWrap }, toasts.map((t) => h('div', { key: t.id, style: s.toast(t.kind) }, t.text))),
        )
      }

      const wide = width >= 700
      const canvasPane = h(CanvasPane, {
        port: comfyPort,
        online: !!(comfy && comfy.running),
        busy,
        reloadKey: canvasReload,
        frameRef,
        onStart: () => doStart('comfyui'),
        onReload: () => setCanvasReload((n) => n + 1),
      })
      const galleryPane = h(GalleryPane, {
        images: filtered, filter, categories: state && state.categories,
        selectedId: selected ? selected.id : undefined,
        onFilter: (v) => { setFilter(v); refreshGallery(v) },
        onSelect: setSelected,
        onRefresh: () => refreshGallery(filter),
      })
      const formPane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } },
        // The backend card belongs here and nowhere else was it ever mounted: the
        // panel has to be able to stop what it started, and "restart ComfyUI so it
        // loads the bridge extension" is a thing the user does from this panel.
        h(BackendCard, {
          backends: state && state.backends,
          postProcessing: state && state.postProcessing,
          busy,
          onStart: doStart,
          onStop: doStop,
          onRefresh: refreshState,
        }),
        h(PromptForm, {
          form, setForm,
          presets: state && state.presets,
          categories: state && state.categories,
          defaults: state && state.defaults,
          controlTypes: state && state.controlTypes,
          models, busy,
          sdwebuiReady: !!(sdwebui && sdwebui.running),
          currentModel: sdwebui && sdwebui.currentModel,
          onGenerate: doGenerate,
          onSavePreset: doSavePreset,
        }),
        h(JobsStrip, {
          jobs,
          onCancel: async (id) => { try { await postJson('/gig/jobs/cancel', { id }); pollJobs() } catch (err) { toast('error', err.message) } },
        }),
        h(SettingsCard, { output: state && state.output, settings: state && state.settings, onSave: doSaveSettings }),
        h(BridgeCard, {
          bridge, busy,
          onInstall: doInstallBridge,
          onUninstall: doUninstallBridge,
          onPush: doPushToCanvas,
          onRefresh: refreshBridge,
          canPush: !!activeWorkflowId,
          run: canvasRun,
        }),
      )

      const header = h('div', { style: Object.assign({}, s.card, { gap: '6px' }) },
        h('div', { style: s.row },
          h('span', { style: { fontWeight: 600 } }, '美术工坊'),
          h('span', { style: s.pill }, placement.floating ? '浮窗' : '面板'),
          h('span', { style: s.pill }, 'ComfyUI :' + comfyPort),
          h('span', { style: s.dot(!!(comfy && comfy.running)) }),
          h('span', { style: { flex: 1 } }),
          placement.floating
            ? (fullscreen.isFull
                ? h('button', { style: s.btnTiny, onClick: () => { if (!fullscreen.exit()) toast('error', '无法调整窗口大小') } }, '⤡ 回浮窗')
                : h('button', { style: s.btnTiny, onClick: () => { if (!fullscreen.enter()) toast('error', '无法进入全屏') } }, '⛶ 全屏'))
            : h('button', {
                style: s.btnTiny,
                title: '右键点本 tab →「移动到自由窗口」',
                onClick: () => toast('ok', '右键点本 tab，选「移动到自由窗口」（英文 Move to Free Window）；浮出去之后这里会出现全屏按钮'),
              }, '如何浮窗？'),
          h('button', { style: s.btnTiny, onClick: doSendCurrentPrompt }, '发送到对话'),
          h('button', { style: s.btnTiny, onClick: () => { refreshState(); refreshGallery(filter); refreshWorkflows() } }, '刷新'),
        ),
        h(AgentHint, { lastCommand, panelOnline }),
      )

      return h('div', { ref: rootRef, style: s.root },
        header,
        h(WorkflowBar, {
          workflows, activeId: activeWorkflowId, activeGraph, busy,
          canvasOnline: !!(comfy && comfy.running),
          comfyPort,
          onPick: doPickWorkflow,
          onRun: doRunWorkflow,
          onReload: () => doPickWorkflow(activeWorkflowId),
          onSaveToLibrary: doSaveCanvas,
        }),
        wide
          ? h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(360px, 2fr) minmax(250px, 1.2fr)', gap: '10px', alignItems: 'start', minHeight: 0 } },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } }, galleryPane),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '520px', minWidth: 0 } }, canvasPane),
              formPane,
            )
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              formPane,
              // keepMounted: collapsing this must not reload ComfyUI (see Section).
              h(Section, { title: 'ComfyUI 画布', defaultOpen: false, keepMounted: true }, canvasPane),
              galleryPane,
            ),
        h(Lightbox, {
          image: selected,
          plannerProject,
          busy,
          onClose: () => setSelected(null),
          onAction: doAction,
          onRegister: doRegister,
        }),
        h('div', { style: s.toastWrap }, toasts.map((t) => h('div', { key: t.id, style: s.toast(t.kind) }, t.text))),
      )
    }

    return {
      name: 'godot-imagegen',
      inject: ['betterSidebar'],
      apply(ctx) {
        ctx.effect(() => ctx.betterSidebar.registerTab({
          id: 'godot-imagegen',
          title: '美术工坊',
          icon: (size) => IconBrush(size || 16),
          order: 63,
          single: true,
          component: ArtStudio,
        }), 'godot-imagegen: better-sidebar tab')
      },
      // Test-only handles: materialize + render without the slot machinery.
      ArtStudio,
      EntryView,
      BackendCard,
      SettingsCard,
      PromptForm,
      JobsStrip,
      Lightbox,
      WorkflowBar,
      CanvasPane,
      BridgeCard,
      AgentHint,
      Section,
      categoryLabel,
      humanSize,
      readPlacement,
      patchFloatGeometry,
      sendToConversation,
      relayToCanvas,
      isCanvasMessage,
      canvasEnvelopes,
      canvasStatusLine,
      runLine,
      runKey,
    }
  },
})
