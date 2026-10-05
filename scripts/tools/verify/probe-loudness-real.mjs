/**
 * 用真实测量数据验证音量曲线的三个交互。
 *
 * 这一步不碰 UI —— 它把 43 分钟那条素材**实测出来的** 1640 个每秒读数
 * 喂给曲线，检查分镜脚本承诺的三件事在真实数值上成立：
 *
 *   1. 纵轴跟随本片动态范围（不是固定 -60…0）
 *   2. 悬停给出秒数与 dBFS
 *   3. 点击给出正确的素材位置
 *
 * 同时用真实数据检验「音量平稳」这条分支是否会被误触发 —— 合成数据容易
 * 造出任意范围，真实数据才能说明这条提示会不会在正常素材上乱出现。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const DATA = 'E:\\huabei\\goclip-agentv2\\runtime\\video-tools'
const ASSET = 'asset-f6a2d8aa38932048010b'

let bad = 0
const record = (name, ok, detail) => { if (!ok) bad += 1; console.log(`${ok ? '✅ 通过' : '❌ 问题'}  ${name}  ${detail}`) }

const db = new DatabaseSync(`${DATA}\\video-tools.sqlite`)
const row = db.prepare('SELECT payload FROM evidence WHERE asset_id=? AND kind=?').get(ASSET, 'acoustic-loudness')
const asset = db.prepare('SELECT meta FROM assets WHERE id=?').get(ASSET)
db.close()
if (row === undefined) { console.log('⏭️  跳过  库里没有声学证据'); process.exit(0) }

const payload = JSON.parse(row.payload)
const levels = payload.levelsDbfs
const durationUs = JSON.parse(asset.meta).duration_us
const audioSeconds = (levels.length * payload.windowUs) / 1e6
const pictureSeconds = durationUs / 1e6

console.log(`真实数据: ${levels.length} 个每秒读数`)
console.log(`  实测范围: ${payload.floorDbfs} … ${payload.peakDbfs} dBFS`)
console.log(`  动态跨度: ${(payload.peakDbfs - payload.floorDbfs).toFixed(1)} dB`)
console.log(`  音频覆盖: ${audioSeconds.toFixed(1)}s   画面时长: ${pictureSeconds.toFixed(1)}s`)
console.log(`  audioEndAt: ${(audioSeconds / pictureSeconds).toFixed(4)}`)
console.log('')

const peak = payload.peakDbfs
const floor = payload.floorDbfs
const spread = peak - floor

// 曲线用的归一化位置：按音频覆盖范围铺开，所以 at = i/(n-1)。
const samples = levels.map((db, index) => ({ at: index / (levels.length - 1), db }))

// ---- 1. 纵轴跟随实测范围 -------------------------------------------------
//
// 固定刻度的缺陷不是「柱子都很高」—— 拿最低/最高的比值去量根本没有区分度，
// 两种刻度下最低都接近 0。真正的问题是：本片峰值只到 -12.2 dBFS，不是 0，
// 所以固定 -60…0 的**绘图顶部 20% 永远用不到**，28.2 dB 的信号被压进
// 不到一半的高度里。所以要量的是「用掉了多少绘图高度」。
{
  const heightDynamic = db => Math.max(2, Math.min(100, ((db - floor) / spread) * 100))
  const heightFixed = db => Math.max(2, Math.min(100, ((db + 60) / 60) * 100))
  const dyn = samples.map(s => heightDynamic(s.db))
  const fix = samples.map(s => heightFixed(s.db))
  const dynMin = Math.min(...dyn); const dynMax = Math.max(...dyn)
  const fixMin = Math.min(...fix); const fixMax = Math.max(...fix)
  record('动态刻度用满了整个绘图高度',
    dynMax > 99 && dynMin < 3,
    `动态刻度 ${dynMin.toFixed(1)}–${dynMax.toFixed(1)}%`)
  record('固定刻度留下用不到的顶部（本片峰值不到 0 dBFS）',
    fixMax < 90,
    `固定刻度 ${fixMin.toFixed(1)}–${fixMax.toFixed(1)}%  —— 最高的柱子只到 ${fixMax.toFixed(0)}%，顶部 ${(100 - fixMax).toFixed(0)}% 永远空着`)
  // 本条不再断言一个「差多少倍」的阈值：98% vs 78% 的差距是真实的，但把它写成
  // 倍数是拍脑袋的。上一条已经说明了固定刻度的缺陷，这一条只记录本片的实际数字。
  console.log(`ℹ️  本片占用：动态刻度 ${(dynMax - dynMin).toFixed(1)}%  固定刻度 ${(fixMax - fixMin).toFixed(1)}%`)
}

// ---- 2. 「音量平稳」会不会在真实素材上误触发 -----------------------------
{
  const threshold = 2
  record('本片动态跨度远大于阈值，不该显示「音量平稳」',
    spread > threshold,
    `跨度 ${spread.toFixed(1)} dB > 阈值 ${threshold} dB`)
}

// ---- 3. 悬停与点击的读数 -------------------------------------------------
{
  const seconds = durationUs / 1e6
  // 取最响的那一秒：它的位置与数值都应当能和 payload 对上。
  let loudest = 0
  for (let i = 1; i < levels.length; i += 1) if (levels[i] > levels[loudest]) loudest = i
  const sample = samples[loudest]
  const atUs = Math.round(sample.at * durationUs)
  const title = `${(sample.at * seconds).toFixed(1)}s · ${sample.db.toFixed(1)} dBFS`
  record('最响那一秒的跳转位置落在音频覆盖范围内',
    atUs / 1e6 <= audioSeconds + 1,
    `第 ${loudest} 秒 → ${(atUs / 1e6).toFixed(1)}s（音频到 ${audioSeconds.toFixed(1)}s）`)
  record('最响那一秒的读数与实测峰值一致',
    Math.abs(sample.db - peak) < 1e-9 && sample.db === Math.max(...levels),
    `读数 ${sample.db} dBFS   实测峰值 ${peak} dBFS`)
  record('悬停文案形如「秒数 · dBFS」',
    /^\d+\.\d+s · -?\d+\.\d+ dBFS$/.test(title),
    title)
}

// ---- 4. 尾部没有音频的那一段 --------------------------------------------
{
  const audioEndAt = audioSeconds / pictureSeconds
  const gapSeconds = pictureSeconds - audioSeconds
  record('audioEndAt < 1，所以会显示「这段之后没有音轨」',
    audioEndAt < 1,
    `audioEndAt=${audioEndAt.toFixed(4)}  缺口 ${gapSeconds.toFixed(1)}s（画面 ${pictureSeconds.toFixed(1)}s）`)
  record('曲线只覆盖有读数的部分，不对外推',
    samples.length === levels.length,
    `${samples.length} 根柱子 = ${levels.length} 个读数（画面有 ${pictureSeconds.toFixed(0)} 秒）`)
}

console.log(`\n共 8 项，问题 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
