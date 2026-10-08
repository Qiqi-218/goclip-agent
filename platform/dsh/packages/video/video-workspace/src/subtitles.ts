import { createHash, randomUUID } from 'node:crypto'

export type SubtitleSource = 'transcript' | 'screen-text'
export interface SubtitleCue { cue_id: string, start_us: number, end_us: number, text: string }
export interface SubtitleEdit {
  action: 'add' | 'update' | 'delete' | 'reset'
  cue_id?: string
  start_us?: number
  end_us?: number
  text?: string
}
export interface SubtitleTrack {
  source: SubtitleSource
  subtitle_revision: number
  stale: boolean
  edited: boolean
  cues: SubtitleCue[]
}

/** Only changes to film timing invalidate final-film subtitles. */
export function subtitleBasis(clips: Array<{ asset_id: string, start_us: number, end_us: number, speed: number }>): string {
  return createHash('sha256').update(JSON.stringify(clips.map(c => [c.asset_id, c.start_us, c.end_us, c.speed]))).digest('hex')
}

/** Stable identities for generated cues; reads never write a new subtitle track. */
export function identifyCues(cues: Array<{ start_us: number, end_us: number, text: string }>): SubtitleCue[] {
  return cues.map((cue, index) => ({ ...cue, cue_id: createHash('sha256').update(JSON.stringify([index, cue.start_us, cue.end_us, cue.text])).digest('hex').slice(0, 24) }))
}

/** Validate the entire batch before the caller commits it. */
export function editCues(current: SubtitleCue[], operations: SubtitleEdit[], durationUs: number): SubtitleCue[] {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('至少提供一个字幕操作。')
  const cues = current.map(cue => ({ ...cue }))
  for (const edit of operations) {
    if (edit === null || typeof edit !== 'object') throw new Error('字幕操作必须是对象。')
    if (edit.action === 'reset') throw new Error('重置必须单独执行。')
    const index = cues.findIndex(cue => cue.cue_id === edit.cue_id)
    if (edit.action === 'delete' || edit.action === 'update') {
      if (typeof edit.cue_id !== 'string' || index < 0) throw new Error(`找不到字幕 ${edit.cue_id ?? ''}`)
    }
    if (edit.action === 'delete') { cues.splice(index, 1); continue }
    if (edit.action !== 'add' && edit.action !== 'update') throw new Error('未知字幕操作。')
    const old = edit.action === 'update' ? cues[index] : undefined
    const cue = {
      cue_id: old?.cue_id ?? `cue-${randomUUID()}`,
      start_us: edit.start_us ?? old?.start_us,
      end_us: edit.end_us ?? old?.end_us,
      text: edit.text ?? old?.text,
    }
    if (typeof cue.text !== 'string' || cue.text.trim() === '') throw new Error('字幕文字不能为空。')
    if (!Number.isSafeInteger(cue.start_us) || !Number.isSafeInteger(cue.end_us)
      || cue.start_us === undefined || cue.end_us === undefined
      || cue.start_us < 0 || cue.end_us <= cue.start_us || cue.end_us > durationUs) throw new Error('字幕时间必须是成片范围内的整数微秒，且结束晚于开始。')
    const accepted = { cue_id: cue.cue_id, start_us: cue.start_us, end_us: cue.end_us, text: cue.text.trim() }
    if (old === undefined) cues.push(accepted)
    else cues[index] = accepted
  }
  return cues.sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us)
}
