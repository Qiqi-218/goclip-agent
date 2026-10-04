/**
 * 启动 goclip：把 DSH 基座按 `video` profile 起成 Web 服务。
 *
 * 这个文件原本**不在仓库里** —— README 与 start.ps1 都引用 `runtime/start-dsh.mjs`，
 * 但 `runtime/` 整个被 .gitignore 忽略，setup.ps1 也不生成它，于是 clone 下来跑不起来。
 * 这里补上，作为 `runtime/` 第一次使用时创建的那一份。
 *
 * 它做三件事：
 *   1. 设定 DSH_HOME 到本包的 runtime/home（profiles 与 sessions 全落在包里，不碰 ~/.dsh）
 *   2. 检查 profile 已安装、密钥文件存在，缺什么就明确报出来
 *   3. 用 tsx 启动基座源码并把参数透传给 web app
 *
 * 用法：node runtime/start-dsh.mjs [web 的参数…]
 * 例如：node runtime/start-dsh.mjs --host 127.0.0.1 --port 8099 --no-open
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(runtimeDir, '..')
const platformDsh = join(root, 'platform', 'dsh')
const profileDir = join(runtimeDir, 'home', 'profiles', 'video')

/** Print a message and stop, so a missing prerequisite never looks like a crash. */
function fail(message, hint) {
  console.error(`\n启动失败：${message}`)
  if (hint !== undefined) console.error(`  ${hint}`)
  process.exit(1)
}

if (!existsSync(join(platformDsh, 'package.json'))) {
  fail('找不到基座源码 platform/dsh', '仓库不完整？')
}
if (!existsSync(join(platformDsh, 'node_modules', 'tsx'))) {
  fail('基座依赖还没装', '先运行 setup.ps1，或：pnpm --dir platform/dsh install')
}
if (!existsSync(join(profileDir, 'package.json'))) {
  fail('profile 还没安装', '先运行 setup.ps1，它会复制 config/profile 并安装依赖')
}
if (!existsSync(join(profileDir, 'node_modules', 'dsh-video-workspace'))) {
  fail(
    'profile 里没有装上剪辑插件',
    `检查 ${join(profileDir, 'package.json')} 里 dsh-video-workspace 的 link 路径能否解析`,
  )
}

// 每次启动把仓库里的 profile 配置同步过去。
//
// `setup.ps1` 只在安装时复制一次 `config/profile` 到 `runtime/home/profiles/video`，
// 之后 **`config/profile/cordis.patch.yml` 的改动不会生效** —— 而它里面装着系统提示词
// 与插件配置。这个漂移很隐蔽：改了源、重启服务、看起来一切正常，实际跑的还是旧提示词。
// 实测踩过一次：系统提示词里的检索规则改了两轮，运行的那份仍是两天前的
// 「五条不许违反」，模型因此一直按旧规则行事。
//
// 只同步 `cordis.patch.yml`：它由仓库拥有。同目录下的 `package.json`、
// `pnpm-workspace.yaml`、`node_modules` 是 setup 生成或安装的，覆盖会破坏安装。
const profileConfigSource = join(root, 'config', 'profile', 'cordis.patch.yml')
const profileConfigTarget = join(profileDir, 'cordis.patch.yml')
try {
  if (existsSync(profileConfigSource)) {
    const wanted = readFileSync(profileConfigSource)
    const current = existsSync(profileConfigTarget) ? readFileSync(profileConfigTarget) : null
    if (current === null || !current.equals(wanted)) {
      writeFileSync(profileConfigTarget, wanted)
      console.log('profile 配置已同步：config/profile/cordis.patch.yml → runtime/home/profiles/video/')
    }
  }
} catch (error) {
  fail(
    `无法把 profile 配置同步到 ${profileConfigTarget}`,
    `${error instanceof Error ? error.message : String(error)} —— 没有它，插件配置与系统提示词会停留在旧版本`,
  )
}

// 凭据文件按平台命名：Windows 上是 `.env.ps1`（由 start.ps1 点源加载），
// Linux/macOS 上是 `.env`（由 start.sh 点源加载）。两个都必须认。
//
// 原来这里只认 `.env.ps1`，于是 **Linux 上永远启动不了**：start.sh 明明读的是
// `.env`，启动器却因为找不到 `.env.ps1` 直接退出 —— 而 setup.sh 的提示还在教人
// 「配置 runtime/.env」。这条只在真机 Linux 上跑才会暴露。
const envFiles = ['.env', '.env.ps1'].filter(name => existsSync(join(runtimeDir, name)))
if (envFiles.length === 0) {
  fail(
    '缺少凭据文件 runtime/.env（Linux/macOS）或 runtime/.env.ps1（Windows）',
    '按部署手册的「配置环境」一节填写模型与 OSS 凭据',
  )
}

// DSH_HOME 决定 profiles 与 sessions 的位置。指向包内，避免和机器上其它 DSH 混在一起。
process.env.DSH_HOME ??= join(runtimeDir, 'home')
process.env.GOCLIP_RUNTIME ??= runtimeDir

// DSH_PROFILE 会让基座自己选 profile，与命令行上的 --profile 冲突
// （报错原文：select a profile only once），且它会改变 app 参数的解析：
// 父进程若设过它，这里必须清掉，否则启动参数会被判成「多余的参数」。
delete process.env.DSH_PROFILE

const args = [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
  '--profile', 'video',
  ...process.argv.slice(2),
]

console.log(`goclip : ${root}`)
console.log(`home   : ${process.env.DSH_HOME}`)
console.log(`dsh    : ${platformDsh}`)

const child = spawn(process.execPath, args, { cwd: platformDsh, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
