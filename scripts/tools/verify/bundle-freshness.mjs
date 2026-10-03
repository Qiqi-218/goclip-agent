/**
 * 产物新鲜度检查。
 *
 * DSH 加载的是 tsdown 打包出来的 `lib/index.js`，而单元探测跑的是 tsc 产出的
 * `lib/types/runtime.js`。两者同源，但打包是**单独一步** —— 只跑 tsc 会让线上继续
 * 跑旧代码，测试却全绿。这个检查专门拦住那种情况。
 *
 * 用 file URL 拼路径，避免在 Windows 上被反斜杠问题绊住。
 */
import { existsSync, statSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param runtimeUrl 探测脚本收到的 lib/types/runtime.js 的 file URL */
export function checkBundleFreshness(runtimeUrl) {
  const pkgDir = fileURLToPath(new URL('../..', runtimeUrl))
  const bundle = `${pkgDir}/lib/index.js`
  const source = `${pkgDir}/src/runtime.ts`
  const indexPath = `${pkgDir}/src/index.ts`

  if (!existsSync(bundle)) return { ok: false, name: '打包产物 lib/index.js 存在', detail: `找不到 ${bundle}` }
  if (!existsSync(source)) return { ok: false, name: '源文件存在', detail: `找不到 ${source}` }

  const newestSource = Math.max(statSync(source).mtimeMs, statSync(indexPath).mtimeMs)
  const bundleTime = statSync(bundle).mtimeMs
  if (bundleTime < newestSource) {
    return {
      ok: false,
      name: '打包产物不旧于源码',
      detail: `bundle 比源码旧 ${Math.round((newestSource - bundleTime) / 1000)} 秒 —— 线上跑的是旧代码，重跑 tsdown`,
    }
  }

  // 源码里有的关键实现，打包产物里也该有
  const src = readFileSync(source, 'utf8')
  const bundled = readFileSync(bundle, 'utf8')
  const markers = ['assertAssetInProject', 'firstJsonObject', 'segmentText', 'maxImportBytes']
  const missing = markers.filter(m => src.includes(m) && !bundled.includes(m))
  if (missing.length > 0) {
    return { ok: false, name: '打包产物含源码里的关键实现', detail: `打包产物缺少 ${missing.join(' / ')}` }
  }
  return { ok: true, name: '打包产物是新的一版', detail: `已包含 ${markers.join(' / ')}` }
}
