/**
 * Live test for the ComfyUI canvas bridge, against the REAL 秋叶 ComfyUI install.
 *
 * The offline suite proves the manager's logic; only this script proves the two
 * things that depend on the machine:
 *
 *   1. the extension really installs into the user's ComfyUI, and a one-click
 *      uninstall really leaves ZERO residue behind (the acceptance criterion);
 *   2. optionally (--serve), ComfyUI really loads and SERVES the extension at
 *      `/extensions/<pkg>/<file>.js` — i.e. the browser inside 美术工坊 will
 *      actually run it. This is checked over HTTP, not assumed from the file
 *      layout, because ComfyUI discovers web extensions at boot.
 *
 * Every write into the ComfyUI tree is preceded by a timestamped backup, which
 * this script asserts exists. Backups are deliberately NOT deleted afterwards:
 * they are the audit trail.
 *
 * Safety rules this script follows, because it touches a directory the plugin
 * does not own:
 *   - it ABORTS if the target directory exists without an install record
 *     (something else put it there; not ours to overwrite);
 *   - it only ever starts/stops a ComfyUI instance that IT started itself;
 *   - it uninstalls at the end even when an assertion fails, so a failed run
 *     never leaves the extension behind.
 *
 * Run with:  node tests/test-extension-live.mjs            (install/uninstall only)
 *            node tests/test-extension-live.mjs --serve    (also boot ComfyUI and fetch the file)
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const COMFY_ROOT = process.env.GIG_COMFY_ROOT || 'D:/AKI open/ComfyUI-aki-v2'
const COMFY_APP = join(COMFY_ROOT, 'ComfyUI').replace(/\\/g, '/')
const COMFY_PYTHON = join(COMFY_ROOT, 'python', 'python.exe')
const COMFY_PORT = Number(process.env.GIG_COMFY_PORT || 8188)
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything under a directory, as relative slash-separated paths. */
function walk(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

async function comfyAnswers() {
  try {
    const res = await fetch(`http://127.0.0.1:${COMFY_PORT}/system_stats`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch { return false }
}

async function main() {
  const serve = process.argv.includes('--serve')

  if (!existsSync(COMFY_APP)) {
    console.log(`SKIP  ComfyUI 不在 ${COMFY_APP} —— 用 GIG_COMFY_ROOT 指定秋叶整合包根目录后重跑`)
    process.exit(0)
  }

  // A throwaway data root keeps the live run out of the user's real plugin data
  // (their workflow library, settings and existing installed-files.json).
  const dataRoot = await mkdtemp(join(tmpdir(), 'gig-ext-live-'))
  const manager = plugin.createExtensionManager({
    unitName: 'godot_imagegen_live_ext',
    comfyRoot: COMFY_ROOT.replace(/\\/g, '/'),
    dataRoot,
  })
  const targetDir = manager.targetDir
  const manifestPath = join(dataRoot, 'installed-files.json')

  console.log(`INFO  ComfyUI 应用目录：${COMFY_APP}`)
  console.log(`INFO  扩展目标目录：${targetDir}`)
  console.log(`INFO  备份与清单写在临时目录：${dataRoot}`)

  const status = await manager.status()
  console.log(`INFO  ${status.detail}`)
  assert(status.sourcePresent === true, '扩展源码在本仓库里可读')
  if (existsSync(targetDir) && !existsSync(manifestPath)) {
    console.error(`ABORT 目标目录已存在且没有安装记录：${targetDir}`)
    console.error('       那不是本插件写的，拒绝覆盖。目录内容：')
    for (const rel of walk(targetDir)) console.error(`         ${rel}`)
    console.error('       确认过之后自行删除该目录再重跑（若只有 __pycache__，那是某次旧版本卸载残留的字节码）。')
    process.exit(1)
  }

  let startedByUs = false
  let comfy = null
  let uninstalled = false
  try {
    const install = await manager.install('http://127.0.0.1:43120')
    assert(install.ok === true, `安装成功（${install.detail}）`)
    assert(existsSync(join(targetDir, '__init__.py')), '__init__.py 已写入真实 ComfyUI custom_nodes')
    assert(existsSync(join(targetDir, 'web', 'godot-imagegen-bridge.js')), 'web 扩展文件已写入')
    assert(typeof install.backupDir === 'string' && existsSync(install.backupDir), `写入前已备份：${install.backupDir}`)
    assert(existsSync(join(install.backupDir, 'BEFORE.json')), '备份带 BEFORE.json 审计记录')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(manifest.files.length === 2, '清单记录了 2 个文件')
    const installedJs = await readFile(join(targetDir, 'web', 'godot-imagegen-bridge.js'), 'utf8')
    assert(!installedJs.includes('__TOKEN__') && installedJs.includes(manifest.token), '安装副本里的令牌占位符已被真实令牌替换')

    if (serve) {
      const alreadyUp = await comfyAnswers()
      if (alreadyUp) {
        console.log('INFO  ComfyUI 已在运行（不是本脚本启动的，结束时不关它）')
      } else {
        assert(existsSync(COMFY_PYTHON), `秋叶内嵌 Python 存在：${COMFY_PYTHON}`)
        comfy = spawn(COMFY_PYTHON, ['-s', 'main.py', '--port', String(COMFY_PORT), '--listen', '127.0.0.1'], {
          cwd: COMFY_APP,
          env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
          stdio: 'ignore',
        })
        startedByUs = true
        const deadline = Date.now() + 4 * 60 * 1000
        let up = false
        while (Date.now() < deadline) {
          if (await comfyAnswers()) { up = true; break }
          await sleep(2000)
        }
        assert(up, `ComfyUI 启动并在 :${COMFY_PORT} 应答（由本脚本启动，结束时会关闭）`)
      }
      if (await comfyAnswers()) {
        // ComfyUI discovers web extensions at boot and serves them under
        // /extensions/<dirname>/ — if this URL answers, the browser inside
        // 美术工坊 will load the bridge for real.
        const url = `http://127.0.0.1:${COMFY_PORT}/extensions/godot-imagegen-bridge/godot-imagegen-bridge.js`
        let served = null
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
          served = res.ok ? await res.text() : null
        } catch { /* reported below */ }
        assert(served !== null, `ComfyUI 正在提供扩展文件：${url}`)
        if (served !== null) {
          const manifest2 = JSON.parse(await readFile(manifestPath, 'utf8'))
          assert(served.includes(manifest2.token), 'ComfyUI 送出的就是本次安装的副本（含本次令牌）')
          assert(served.includes('/gig/bridge/poll'), '送出的副本会回连宿主的 /gig/bridge/poll')
        }
        const list = await fetch(`http://127.0.0.1:${COMFY_PORT}/extensions`, { signal: AbortSignal.timeout(10000) })
          .then((r) => r.json()).catch(() => null)
        assert(Array.isArray(list) && list.some((f) => String(f).includes('godot-imagegen-bridge')), '扩展出现在 ComfyUI 的 /extensions 列表里')
      }
    }

    // ── the one-click uninstall ──
    const uninstall = await manager.uninstall()
    uninstalled = true
    assert(uninstall.reason === 'ok', `卸载干净（${uninstall.detail}）`)
    assert(uninstall.removed.length === 2, '删除了 2 个已登记文件')
    assert(uninstall.pruned.length >= 2, '并回收了它自己创建的目录')
    if (serve) {
      // ComfyUI imports the package at boot, so Python leaves byte code behind
      // unless the uninstall takes it too.
      assert(uninstall.derived.length === 1, `ComfyUI 生成的 __pycache__ 字节码也一并清掉（${uninstall.derived.length} 个）`)
    }
    assert(!existsSync(targetDir), '目标目录已消失，没有残留')
    assert(existsSync(join(COMFY_APP, 'custom_nodes')), 'custom_nodes 本身没有被误删')
    const siblings = readdirSync(join(COMFY_APP, 'custom_nodes'))
    assert(siblings.every((name) => name !== 'godot-imagegen-bridge'), '同级的其它自定义节点一个都没动')
    assert(!existsSync(manifestPath), '安装清单已随卸载删除')
    assert((await manager.status()).installed === false, '状态确认：未安装')
    const residue = walk(join(COMFY_APP, 'custom_nodes')).filter((p) => p.toLowerCase().includes('godot-imagegen-bridge'))
    assert(residue.length === 0, `custom_nodes 全树扫描：找不到任何 godot-imagegen-bridge 残片${residue.length === 0 ? '' : `（${residue.join(', ')}）`}`)
  } finally {
    if (!uninstalled) {
      console.error('CLEANUP  本次运行中途失败，正在卸载以免留下扩展…')
      await manager.uninstall().catch((error) => console.error('CLEANUP  卸载也失败了：' + error.message))
    }
    if (startedByUs && comfy !== null) {
      console.log('INFO  关闭本脚本启动的 ComfyUI')
      comfy.kill()
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && await comfyAnswers()) await sleep(1000)
    }
    await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  console.log(`INFO  生产环境的备份会落在 ${join(DSH_HOME, 'godot-imagegen', 'backups')}/<时间戳>/comfyui/`)
  console.log('       本脚本故意用一个一次性目录当数据根，免得动到你真实的清单与备份；它已在结束时删除。')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
