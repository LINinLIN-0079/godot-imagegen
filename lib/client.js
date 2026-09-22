/**
 * godot-imagegen — browser half of the godot-imagegen plugin.
 *
 * Registers ONE tab into the dsh-better-sidebar service (`ctx.betterSidebar`):
 *
 *   「美术工坊」(Art Studio) — the whole local art pipeline in one panel:
 *
 *   1. 后端 — SD WebUI / ComfyUI liveness, checkpoints, capabilities, and a
 *      「启动后端」/「停止」button. Only instances THIS plugin started can be
 *      stopped; a backend the user launched from 绘世启动器 is adopted as-is.
 *   2. 设置 — the Godot project root (so output lands under
 *      <root>/assets/generated and gets a res:// path) and the effective
 *      output root, both persisted through the host's storage.
 *   3. 提示词 — a categorized preset library shipped by the host plugin plus
 *      user presets, the positive/negative prompt boxes, and the generation
 *      parameters (category, size, steps, CFG, sampler, seed, count, backend,
 *      transparent, seamless, optional ControlNet reference).
 *   4. 任务 — live progress (ratio, sampling step, ETA and the backend's own
 *      preview image) for every running/finished job.
 *   5. 图库 — thumbnails of everything generated, with a lightbox that can
 *      upscale, cut out the background, interrogate a prompt, register the
 *      image as a Godot asset (POST /gap/assets — one click into the
 *      godot-asset-planner library) and delete it.
 *
 * All host work goes through the plugin's own same-origin /gig REST routes;
 * asset registration deliberately reuses the NEIGHBOURING plugin's /gap/assets
 * route instead of touching its storage unit, because a KV unit allows exactly
 * one live handle per backend and that handle belongs to godot-asset-planner.
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
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    // ── theme tokens (DSH CSS variables) with neutral fallbacks ──
    const token = (name, fallback) => `var(${name}, ${fallback})`
    const C = {
      text: token('--dsh-text', '#e6e8ee'),
      dim: token('--dsh-text-dim', '#98a0b3'),
      border: token('--dsh-border', 'rgba(255,255,255,0.12)'),
      panel: token('--dsh-panel', 'rgba(255,255,255,0.035)'),
      panel2: token('--dsh-panel-strong', 'rgba(255,255,255,0.07)'),
      accent: token('--dsh-accent', '#4f8cff'),
      ok: '#3fb27f',
      warn: '#d98e3f',
      err: '#e05a5a',
      radius: '8px',
    }

    const s = {
      root: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', color: C.text, fontSize: '12px', height: '100%', overflow: 'auto', boxSizing: 'border-box' },
      card: { border: `1px solid ${C.border}`, borderRadius: C.radius, background: C.panel, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', cursor: 'pointer', userSelect: 'none' },
      title: { fontWeight: 600, fontSize: '12px', letterSpacing: '0.2px' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' },
      grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' },
      label: { color: C.dim, fontSize: '11px', minWidth: '52px' },
      input: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '5px 7px', fontSize: '12px', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },
      textarea: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '6px 7px', fontSize: '12px', width: '100%', boxSizing: 'border-box', minHeight: '62px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 },
      btn: { background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
      btnPrimary: { background: C.accent, color: '#fff', border: '1px solid transparent', borderRadius: '6px', padding: '7px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', width: '100%' },
      btnTiny: { background: 'transparent', color: C.dim, border: `1px solid ${C.border}`, borderRadius: '5px', padding: '2px 6px', fontSize: '11px', cursor: 'pointer' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: '4px', border: `1px solid ${C.border}`, borderRadius: '999px', padding: '1px 7px', fontSize: '10px', color: C.dim },
      dot: (on) => ({ width: '7px', height: '7px', borderRadius: '50%', background: on ? C.ok : C.err, flex: '0 0 auto' }),
      bar: { height: '5px', borderRadius: '3px', background: C.panel2, overflow: 'hidden' },
      barFill: { height: '100%', background: C.accent, transition: 'width .3s ease' },
      thumbGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '6px' },
      thumb: (active) => ({ border: `2px solid ${active ? C.accent : 'transparent'}`, borderRadius: '6px', overflow: 'hidden', cursor: 'pointer', background: C.panel2, aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center' }),
      img: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
      modal: { background: token('--dsh-bg', '#161a22'), border: `1px solid ${C.border}`, borderRadius: '10px', maxWidth: '92vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      modalBody: { display: 'flex', gap: '14px', padding: '14px', overflow: 'auto', flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: C.dim, wordBreak: 'break-all' },
      toastWrap: { position: 'fixed', right: '16px', bottom: '16px', zIndex: 4100, display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '360px' },
      toast: (kind) => ({ background: token('--dsh-bg', '#161a22'), border: `1px solid ${kind === 'error' ? C.err : kind === 'ok' ? C.ok : C.border}`, borderRadius: '8px', padding: '8px 10px', fontSize: '12px', color: C.text, boxShadow: '0 6px 22px rgba(0,0,0,.35)' }),
    }

    // ── icons (inline SVG, no icon dependency) ──
    const svg = (size, children) => React.createElement('svg', { width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }, children)
    const IconBrush = (size) => svg(size, [
      React.createElement('path', { key: 'a', d: 'M9.5 14.5 3 21' }),
      React.createElement('path', { key: 'b', d: 'M14 4.5a3.5 3.5 0 0 1 5 5L12 16.5l-5-5Z' }),
      React.createElement('path', { key: 'c', d: 'M7 18c0 1.5-1 2.5-2.5 3' }),
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
    const shortId = (id) => String(id || '').replace(/^img_/, '')

    const CATEGORY_LABELS = {
      character: '角色', item: '道具图标', ui: 'UI 素材', tile: '瓦片',
      background: '背景', texture: '3D 贴图', concept: '概念图',
    }
    const categoryLabel = (c) => CATEGORY_LABELS[c] || c

    // ── collapsible section ──
    function Section(props) {
      const [open, setOpen] = useState(props.defaultOpen !== false)
      return React.createElement('div', { style: s.card },
        React.createElement('div', { style: s.head, onClick: () => setOpen(!open) },
          React.createElement('span', { style: s.title }, (open ? '▾ ' : '▸ ') + props.title),
          props.right ? React.createElement('span', { style: s.row, onClick: (e) => e.stopPropagation() }, props.right) : null,
        ),
        open ? props.children : null,
      )
    }

    // ── backend card ──
    function BackendCard(props) {
      const { backends, postProcessing, busy, onStart, onStop, onRefresh } = props
      return React.createElement(Section, {
        title: '后端',
        right: React.createElement('button', { style: s.btnTiny, onClick: onRefresh, disabled: busy }, '刷新'),
      },
      (backends || []).map((b) => React.createElement('div', { key: b.id, style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        React.createElement('div', { style: s.row },
          React.createElement('span', { style: s.dot(b.running) }),
          React.createElement('span', { style: { fontWeight: 600 } }, b.label),
          React.createElement('span', { style: s.pill }, ':' + b.port),
          b.managed ? React.createElement('span', { style: s.pill }, '插件已启动') : null,
          React.createElement('span', { style: { flex: 1 } }),
          b.running
            ? React.createElement('button', { style: s.btnTiny, disabled: busy || !b.managed, title: b.managed ? '停止本插件启动的实例' : '非本插件启动，拒绝终止', onClick: () => onStop(b.id) }, '停止')
            : React.createElement('button', { style: s.btnTiny, disabled: busy, onClick: () => onStart(b.id) }, '启动'),
        ),
        React.createElement('div', { style: { color: C.dim, fontSize: '11px', lineHeight: 1.4 } }, b.detail || ''),
        b.running && b.models && b.models.length > 0
          ? React.createElement('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.4 } }, '模型：' + b.models.join('、'))
          : null,
      )),
      React.createElement('div', { style: { color: C.dim, fontSize: '11px', borderTop: `1px solid ${C.border}`, paddingTop: '6px' } },
        (postProcessing && postProcessing.ready ? '✓ ' : '✗ ') + ((postProcessing && postProcessing.detail) || '')),
      )
    }

    // ── settings card ──
    function SettingsCard(props) {
      const { output, settings, onSave } = props
      const [project, setProject] = useState((settings && settings.godotProject) || '')
      const [outDir, setOutDir] = useState((settings && settings.outDir) || '')
      useEffect(() => { setProject((settings && settings.godotProject) || '') }, [settings && settings.godotProject])
      useEffect(() => { setOutDir((settings && settings.outDir) || '') }, [settings && settings.outDir])
      const dirty = project !== ((settings && settings.godotProject) || '') || outDir !== ((settings && settings.outDir) || '')
      return React.createElement(Section, { title: '设置', defaultOpen: !(settings && settings.godotProject) },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement('span', { style: s.label }, 'Godot 项目根目录'),
          React.createElement('input', {
            style: s.input, value: project, placeholder: 'D:/my-game（留空则输出到 DSH_HOME）',
            onChange: (e) => setProject(e.target.value),
          }),
        ),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement('span', { style: s.label }, '输出根目录（覆盖）'),
          React.createElement('input', {
            style: s.input, value: outDir, placeholder: '默认 <项目>/assets/generated',
            onChange: (e) => setOutDir(e.target.value),
          }),
        ),
        React.createElement('div', { style: s.mono }, '当前输出：' + ((output && output.root) || '?')),
        output && output.godotProject
          ? React.createElement('div', { style: { color: C.ok, fontSize: '11px' } }, 'res:// 映射可用')
          : React.createElement('div', { style: { color: C.warn, fontSize: '11px' } }, '未配置 Godot 项目：不会产生 res:// 路径'),
        React.createElement('button', {
          style: Object.assign({}, s.btn, { width: '100%', opacity: dirty ? 1 : 0.5 }),
          disabled: !dirty,
          onClick: () => onSave({ godotProject: project, outDir: outDir }),
        }, dirty ? '保存设置' : '已保存'),
      )
    }

    // ── prompt + parameters form ──
    function PromptForm(props) {
      const { form, setForm, presets, categories, defaults, controlTypes, models, busy, onGenerate, onSavePreset } = props
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

      return React.createElement(Section, { title: '出图' },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement('span', { style: s.label }, '提示词预设'),
          React.createElement('select', { style: s.input, value: form.presetId || '', onChange: (e) => applyPreset(e.target.value) },
            React.createElement('option', { value: '' }, '— 选择预设 —'),
            Object.keys(byCategory).map((cat) => React.createElement('optgroup', { key: cat, label: categoryLabel(cat) },
              byCategory[cat].map((p) => React.createElement('option', { key: p.id, value: p.id }, p.name + (p.builtin ? '' : ' *'))),
            )),
          ),
        ),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement('span', { style: s.label }, '正向提示词'),
          React.createElement('textarea', { style: s.textarea, value: form.prompt || '', onChange: set('prompt'), placeholder: 'masterpiece, best quality, ...' }),
        ),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement('span', { style: s.label }, '负向提示词'),
          React.createElement('textarea', { style: Object.assign({}, s.textarea, { minHeight: '42px' }), value: form.negativePrompt || '', onChange: set('negativePrompt') }),
        ),
        React.createElement('div', { style: s.grid2 },
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '品类'),
            React.createElement('select', { style: s.input, value: form.category, onChange: (e) => {
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
              (categories || []).map((c) => React.createElement('option', { key: c, value: c }, categoryLabel(c))),
            ),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '后端'),
            React.createElement('select', { style: s.input, value: form.backend, onChange: set('backend') },
              React.createElement('option', { value: 'auto' }, 'auto'),
              React.createElement('option', { value: 'sdwebui' }, 'SD WebUI'),
              React.createElement('option', { value: 'comfyui' }, 'ComfyUI'),
            ),
          ),
        ),
        React.createElement('div', { style: s.grid3 },
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '宽'),
            React.createElement('input', { style: s.input, type: 'number', step: 64, value: form.width, onChange: setNum('width') }),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '高'),
            React.createElement('input', { style: s.input, type: 'number', step: 64, value: form.height, onChange: setNum('height') }),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '张数'),
            React.createElement('input', { style: s.input, type: 'number', min: 1, max: 8, value: form.count, onChange: setNum('count') }),
          ),
        ),
        React.createElement('div', { style: s.grid3 },
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '步数'),
            React.createElement('input', { style: s.input, type: 'number', value: form.steps, onChange: setNum('steps') }),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, 'CFG'),
            React.createElement('input', { style: s.input, type: 'number', step: 0.5, value: form.cfgScale, onChange: setNum('cfgScale') }),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '种子'),
            React.createElement('input', { style: s.input, type: 'number', value: form.seed, onChange: setNum('seed') }),
          ),
        ),
        React.createElement('div', { style: s.row },
          React.createElement('label', { style: s.row },
            React.createElement('input', { type: 'checkbox', checked: !!form.transparent, onChange: setBool('transparent') }),
            React.createElement('span', {}, '透明背景'),
          ),
          React.createElement('label', { style: s.row },
            React.createElement('input', { type: 'checkbox', checked: !!form.seamless, onChange: setBool('seamless') }),
            React.createElement('span', {}, '无缝平铺'),
          ),
        ),
        form.transparent
          ? React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              React.createElement('span', { style: s.label }, '透明方式'),
              React.createElement('select', { style: s.input, value: form.transparentMethod, onChange: set('transparentMethod') },
                React.createElement('option', { value: 'auto' }, 'auto（rembg，失败回落色键）'),
                React.createElement('option', { value: 'rembg' }, 'rembg（AI 抠图，首次下载模型）'),
                React.createElement('option', { value: 'chroma' }, 'chroma（纯色背景抠图）'),
                React.createElement('option', { value: 'generative' }, 'generative（ComfyUI layerdiffuse 直出）'),
              ),
            )
          : null,
        React.createElement('div', { style: s.grid2 },
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, 'ControlNet'),
            React.createElement('select', { style: s.input, value: form.controlType || '', onChange: (e) => setForm((f) => Object.assign({}, f, { controlType: e.target.value })) },
              React.createElement('option', { value: '' }, '— 不用 —'),
              (controlTypes || []).map((t) => React.createElement('option', { key: t, value: t }, t)),
            ),
          ),
          React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('span', { style: s.label }, '控制图路径'),
            React.createElement('input', { style: s.input, value: form.controlImage || '', placeholder: '绝对路径 / res://', onChange: set('controlImage') }),
          ),
        ),
        React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          React.createElement('span', { style: s.label }, '模型'),
          React.createElement('select', { style: s.input, value: form.model || '', onChange: set('model') },
            React.createElement('option', { value: '' }, '— 后端默认 —'),
            (models || []).map((m) => React.createElement('option', { key: m, value: m }, m)),
          ),
        ),
        React.createElement('div', { style: s.grid2 },
          React.createElement('button', { style: s.btnPrimary, disabled: busy || !form.prompt, onClick: onGenerate },
            busy ? '生成中…' : '生成'),
          React.createElement('button', { style: Object.assign({}, s.btn, { width: '100%' }), disabled: !form.prompt, onClick: onSavePreset }, '存为预设'),
        ),
        React.createElement('div', { style: { color: C.dim, fontSize: '10px', lineHeight: 1.4 } },
          (catDefaults.hint || '') + (form.category === 'tile' || form.category === 'texture' ? '（默认做无缝处理）' : '')),
      )
    }

    // ── jobs strip ──
    function JobsStrip(props) {
      const { jobs, onCancel } = props
      if (!jobs || jobs.length === 0) return null
      return React.createElement(Section, { title: '任务 (' + jobs.filter((j) => j.status === 'running').length + ' 运行中)' },
        jobs.slice(0, 6).map((j) => React.createElement('div', { key: j.id, style: { display: 'flex', flexDirection: 'column', gap: '4px', borderBottom: `1px solid ${C.border}`, paddingBottom: '6px' } },
          React.createElement('div', { style: s.row },
            React.createElement('span', { style: s.dot(j.status === 'done') }),
            React.createElement('span', { style: { fontWeight: 600 } }, j.label),
            React.createElement('span', { style: s.pill }, j.status),
            React.createElement('span', { style: { flex: 1 } }),
            j.status === 'running'
              ? React.createElement('button', { style: s.btnTiny, onClick: () => onCancel(j.id) }, '取消')
              : null,
          ),
          React.createElement('div', { style: s.bar },
            React.createElement('div', { style: Object.assign({}, s.barFill, { width: ((j.progress == null ? (j.status === 'done' ? 1 : 0.06) : j.progress) * 100).toFixed(1) + '%', background: j.status === 'error' ? C.err : j.status === 'done' ? C.ok : C.accent }) }),
          ),
          React.createElement('div', { style: { color: j.status === 'error' ? C.err : C.dim, fontSize: '11px', lineHeight: 1.4, wordBreak: 'break-word' } }, j.message || ''),
          j.preview ? React.createElement('img', { src: j.preview, style: { maxHeight: '120px', borderRadius: '6px', alignSelf: 'flex-start' } }) : null,
        )),
      )
    }

    // ── lightbox ──
    function Lightbox(props) {
      const { image, plannerProject, onClose, onAction, busy, onRegister } = props
      const [goal, setGoal] = useState('')
      const [assetName, setAssetName] = useState('')
      useEffect(() => { setAssetName(image ? image.name : '') }, [image && image.id])
      if (!image) return null
      const canRegister = !!(image.resPath || image.filePath)
      return React.createElement('div', { style: s.overlay, onClick: onClose },
        React.createElement('div', { style: s.modal, onClick: (e) => e.stopPropagation() },
          React.createElement('div', { style: s.modalBody },
            React.createElement('img', { src: '/gig/file?id=' + encodeURIComponent(image.id), style: { maxWidth: '44vw', maxHeight: '74vh', borderRadius: '8px', background: 'repeating-conic-gradient(#333 0% 25%, #3c3c3c 0% 50%) 50% / 18px 18px' } }),
            React.createElement('div', { style: { minWidth: '260px', maxWidth: '340px', display: 'flex', flexDirection: 'column', gap: '8px' } },
              React.createElement('div', { style: s.row },
                React.createElement('span', { style: s.pill }, categoryLabel(image.category)),
                React.createElement('span', { style: s.pill }, image.backend || '?'),
                image.method ? React.createElement('span', { style: s.pill }, image.method) : null,
              ),
              React.createElement('div', { style: s.mono }, image.resPath || image.filePath),
              React.createElement('div', { style: { color: C.dim, fontSize: '11px' } },
                (image.width || '?') + '×' + (image.height || '?') + ' · ' + humanSize(image.size) + ' · seed ' + (image.seed == null ? '?' : image.seed)),
              image.prompt ? React.createElement('div', { style: { color: C.dim, fontSize: '11px', maxHeight: '90px', overflow: 'auto', lineHeight: 1.45 } }, image.prompt) : null,
              React.createElement('div', { style: s.row },
                React.createElement('button', { style: s.btn, disabled: busy, onClick: () => onAction('upscale', image) }, '放大 2×'),
                React.createElement('button', { style: s.btn, disabled: busy, onClick: () => onAction('cutout', image) }, '抠透明'),
                React.createElement('button', { style: s.btn, disabled: busy, onClick: () => onAction('interrogate', image) }, '反推提示词'),
              ),
              React.createElement('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '5px' } },
                React.createElement('div', { style: { fontWeight: 600 } }, '注册为 Godot 资产'),
                React.createElement('div', { style: { color: C.dim, fontSize: '10px' } }, '项目：' + (plannerProject || 'default')),
                React.createElement('input', { style: s.input, value: assetName, onChange: (e) => setAssetName(e.target.value), placeholder: '资产名称' }),
                React.createElement('input', { style: s.input, value: goal, onChange: (e) => setGoal(e.target.value), placeholder: '关联目标（可选）' }),
                React.createElement('button', {
                  style: Object.assign({}, s.btnPrimary, { opacity: canRegister ? 1 : 0.5 }),
                  disabled: !canRegister || !assetName,
                  onClick: () => onRegister(image, assetName, goal),
                }, '一键注册'),
              ),
              React.createElement('div', { style: s.row },
                React.createElement('button', { style: s.btn, disabled: busy, onClick: () => onAction('copy', image) }, '复制路径'),
                React.createElement('button', { style: Object.assign({}, s.btn, { color: C.err }), disabled: busy, onClick: () => onAction('delete', image) }, '删除'),
                React.createElement('span', { style: { flex: 1 } }),
                React.createElement('button', { style: s.btn, onClick: onClose }, '关闭'),
              ),
            ),
          ),
        ),
      )
    }

    // ── main tab ──
    function ArtStudio(props) {
      const [state, setState] = useState(null)
      const [jobs, setJobs] = useState([])
      const [gallery, setGallery] = useState([])
      const [selected, setSelected] = useState(null)
      const [busy, setBusy] = useState(false)
      const [plannerProject, setPlannerProject] = useState('default')
      const [filter, setFilter] = useState('')
      const [toasts, setToasts] = useState([])
      const toastSeq = useRef(0)
      const [form, setForm] = useState({
        presetId: '', category: 'character',
        prompt: '', negativePrompt: '',
        width: 832, height: 1216, steps: 30, cfgScale: 7,
        seed: -1, count: 1, backend: 'auto', model: '',
        transparent: true, transparentMethod: 'auto', seamless: false,
        controlType: '', controlImage: '',
      })

      const toast = useCallback((kind, text) => {
        const id = ++toastSeq.current
        setToasts((t) => t.concat([{ id, kind, text }]))
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
      }, [])

      const refreshState = useCallback(async () => {
        try {
          const next = await api('/gig/state')
          setState(next)
          setForm((f) => (f.prompt ? f : Object.assign({}, f, { category: (next.settings && next.settings.lastCategory) || f.category })))
        } catch (err) { toast('error', '读取状态失败：' + err.message) }
      }, [toast])

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
            const finishedNow = prev.filter((j) => j.status === 'running').length > 0 && runningAfter < runningBefore
            if (finishedNow) {
              refreshGallery(filter)
              refreshState()
            }
            return list
          })
        } catch { /* transient */ }
      }, [filter, refreshGallery, refreshState])

      useEffect(() => { refreshState(); refreshGallery(); }, [refreshState, refreshGallery])
      useEffect(() => {
        const t = setInterval(pollJobs, 1500)
        return () => clearInterval(t)
      }, [pollJobs])
      useEffect(() => {
        api('/gap/state').then((r) => { if (r && r.currentProject) setPlannerProject(r.currentProject) }).catch(() => undefined)
      }, [])

      const models = useMemo(() => {
        const list = []
        ;((state && state.backends) || []).forEach((b) => { if (b.running) list.push.apply(list, b.models || []) })
        const unique = []
        list.forEach((m) => { if (unique.indexOf(m) === -1) unique.push(m) })
        return unique
      }, [state])

      const doGenerate = useCallback(async () => {
        setBusy(true)
        try {
          const payload = {
            prompt: form.prompt,
            negativePrompt: trimText(form.negativePrompt),
            category: form.category,
            width: form.width, height: form.height,
            steps: form.steps, cfgScale: form.cfgScale,
            seed: form.seed, count: form.count,
            backend: form.backend,
            model: trimText(form.model),
            transparent: form.transparent,
            transparentMethod: form.transparentMethod,
            seamless: form.seamless,
            projectId: plannerProject,
            controlType: trimText(form.controlType),
            controlImage: trimText(form.controlImage),
          }
          await postJson('/gig/generate', payload)
          toast('ok', '已提交生成任务')
          pollJobs()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [form, plannerProject, toast, pollJobs])

      const doSavePreset = useCallback(async () => {
        setBusy(true)
        try {
          const name = window.prompt('预设名称', form.prompt.slice(0, 20) || '新预设')
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

      const doStart = useCallback(async (backend) => {
        setBusy(true)
        toast('ok', '正在启动 ' + backend + '（首次可能 1-3 分钟）…')
        try {
          const r = await postJson('/gig/backend/start', { backend })
          toast(r && r.ok ? 'ok' : 'error', (r && r.detail) || '')
          await refreshState()
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

      const doCancel = useCallback(async (id) => {
        try { await postJson('/gig/jobs/cancel', { id }); pollJobs() } catch (err) { toast('error', err.message) }
      }, [pollJobs, toast])

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
          } else if (kind === 'delete') {
            if (!window.confirm('删除该图库记录与磁盘文件？')) return
            await postJson('/gig/gallery/delete', { id: image.id })
            setSelected(null)
            await refreshGallery(filter)
            await refreshState()
            toast('ok', '已删除')
          } else if (kind === 'copy') {
            const text = image.resPath || image.filePath
            try {
              await navigator.clipboard.writeText(text)
              toast('ok', '已复制：' + text)
            } catch {
              toast('error', '复制失败，路径：' + text)
            }
          }
          pollJobs()
        } catch (err) { toast('error', err.message) }
        finally { setBusy(false) }
      }, [filter, plannerProject, pollJobs, refreshGallery, refreshState, toast])

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

      const filtered = filter ? gallery.filter((g) => g.category === filter) : gallery

      return React.createElement('div', { style: s.root },
        React.createElement(BackendCard, {
          backends: state && state.backends,
          postProcessing: state && state.postProcessing,
          busy: busy,
          onStart: doStart, onStop: doStop, onRefresh: () => { refreshState(); refreshGallery(filter) },
        }),
        React.createElement(SettingsCard, { output: state && state.output, settings: state && state.settings, onSave: doSaveSettings }),
        React.createElement(PromptForm, {
          form, setForm,
          presets: state && state.presets,
          categories: state && state.categories,
          defaults: state && state.defaults,
          controlTypes: state && state.controlTypes,
          models, busy,
          onGenerate: doGenerate,
          onSavePreset: doSavePreset,
        }),
        React.createElement(JobsStrip, { jobs, onCancel: doCancel }),
        React.createElement(Section, { title: '图库 (' + filtered.length + ')' },
          React.createElement('div', { style: s.row },
            React.createElement('select', { style: Object.assign({}, s.input, { width: 'auto' }), value: filter, onChange: (e) => { setFilter(e.target.value); refreshGallery(e.target.value) } },
              React.createElement('option', { value: '' }, '全部品类'),
              ((state && state.categories) || []).map((c) => React.createElement('option', { key: c, value: c }, categoryLabel(c))),
            ),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { style: s.btnTiny, onClick: () => refreshGallery(filter) }, '刷新'),
          ),
          filtered.length === 0
            ? React.createElement('div', { style: { color: C.dim, fontSize: '11px' } }, '还没有生成的图片。')
            : React.createElement('div', { style: s.thumbGrid },
                filtered.map((image) => React.createElement('div', {
                  key: image.id,
                  style: s.thumb(selected && selected.id === image.id),
                  title: image.name + ' · ' + (image.resPath || image.filePath),
                  onClick: () => setSelected(image),
                },
                  React.createElement('img', { src: '/gig/file?id=' + encodeURIComponent(image.id), style: s.img, loading: 'lazy' }),
                )),
              ),
        ),
        React.createElement(Lightbox, {
          image: selected,
          plannerProject,
          busy,
          onClose: () => setSelected(null),
          onAction: doAction,
          onRegister: doRegister,
        }),
        React.createElement('div', { style: s.toastWrap },
          toasts.map((t) => React.createElement('div', { key: t.id, style: s.toast(t.kind) }, t.text)),
        ),
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
      BackendCard,
      SettingsCard,
      PromptForm,
      JobsStrip,
      Lightbox,
      categoryLabel,
      humanSize,
    }
  },
})
