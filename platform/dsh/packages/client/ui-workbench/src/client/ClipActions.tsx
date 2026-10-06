/**
 * What can be done to the clip that is selected.
 *
 * The plan calls for splitting, merging, dropping, renaming and re-timing a clip from the surface,
 * and for the interface to be usable by someone who has not memorised the tool names. A selected
 * clip turns those into buttons.
 *
 * Every button produces a tool call and reports it upward; none of them writes anything. That is
 * the same channel a drag uses, and for the same reason: the tool layer is the only writer, and it
 * carries the revision check that keeps two editors from overwriting each other. A control that
 * wrote directly would be faster and would make the revision mechanism decorative.
 *
 * **Which actions are offered follows what the host will actually accept**, not what would look
 * complete: splitting needs room inside the clip, and merging needs a *next* clip that draws from
 * the same recording at the same rate and continues where this one stops. Offering a button that
 * can only fail teaches the wrong thing about the tool.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { EditIntent } from './editor-model.ts'
import { canMergeWithNext } from './editor-model.ts'
import type { EditableClip } from './editor-model.ts'
import styles from './ClipActions.module.css'

/** Playback rates the speed buttons step through. */
export const SPEED_STEPS: readonly number[] = [0.5, 1, 1.5, 2, 3]

/** What the bar draws and reports. */
export type ClipActionsProps =
  & PropsLocale<'workbench'>
  & {
    /** The selected clip, or null when nothing is selected. */
    readonly clip: EditableClip | null
    /** Every clip, so the bar can tell whether a neighbouring one can be merged. */
    readonly clips: readonly EditableClip[]
    /** Called with the call a button implies. */
    readonly onIntent: (intent: EditIntent | null) => void
    /** The timeline being edited, or null while none is loaded. */
    readonly timelineId: string | null
    /** Revision the caller last read. */
    readonly baseRevision: number
    /** Current source-media playhead; splitting happens at this moment. */
    readonly playheadUs?: number
    /** True while an edit is being persisted. */
    readonly saving?: boolean
  }

/**
 * Render the actions for the selected clip.
 *
 * @param props - the clip, its neighbours, and the channel that reports intents.
 * @returns The bar, or a hint when nothing is selected.
 */
export function ClipActions({ clip, clips, onIntent, timelineId, baseRevision, playheadUs, saving = false, t }: ClipActionsProps): ReactNode {
  // 草稿跟着选中的片段走：换一段时要是还留着上一段的名字，按回车就会把它写到这一段上。
  const [draft, setDraft] = useState(clip?.name ?? '')
  useEffect(() => { setDraft(clip?.name ?? '') }, [clip?.ordinal, clip?.name])
  if (clip === null || timelineId === null) {
    return (
      <div className={styles.bar} data-clip-actions="">
        <span className={styles.hint} data-clip-actions-hint="">{t('clip.selectHint')}</span>
      </div>
    )
  }

  const index = clips.findIndex(candidate => candidate.ordinal === clip.ordinal)
  const next = clips[index + 1] ?? null
  const mergeable = next !== null && canMergeWithNext(clip, next)
  const splittable = clip.end_us - clip.start_us > 1_000_000
  // `playheadUs` was added after this component became independently reusable in tests and
  // extensions. Its absence keeps the old, deterministic midpoint behaviour; the workbench
  // always supplies the actual playhead.
  const splitAtUs = playheadUs ?? Math.round((clip.start_us + clip.end_us) / 2)
  // 删除最后一段会留下可撤销的空时间线；源素材从不随这个操作删除。
  const removable = clips.length > 0
  // 时间线名字不在片段上；改名按钮把它放在这里，因为它是这张卡上唯一能改名字的地方。
  const send = (intent: EditIntent | null): void => { onIntent(intent) }

  return (
    <div className={styles.bar} data-clip-actions="">
      <span className={styles.which} data-clip-actions-for="">{t('timeline.clip', { ordinal: String(clip.ordinal + 1) })}</span>

      <button
        type="button" className={styles.action} data-clip-action="split"
        disabled={!splittable || saving || splitAtUs <= clip.start_us || splitAtUs >= clip.end_us}
        title={splittable ? undefined : t('clip.splitTooShort')}
        onClick={() => {
          send({
            tool: 'video_timeline_split',
            args: {
              timeline_id: timelineId,
              base_revision: baseRevision,
              ordinal: clip.ordinal,
              asset_time_us: Math.round(splitAtUs),
            },
          })
        }}
      >{t('clip.split')}</button>

      <button
        type="button" className={styles.action} data-clip-action="merge"
        disabled={!mergeable || saving}
        title={mergeable ? undefined : t('clip.mergeNeedsNext')}
        onClick={() => send({
          tool: 'video_timeline_merge',
          args: { timeline_id: timelineId, base_revision: baseRevision, ordinal: clip.ordinal },
        })}
      >{t('clip.merge')}</button>

      <button
        type="button" className={styles.action} data-clip-action="remove"
        disabled={!removable || saving}
        title={removable ? undefined : t('clip.lastOne')}
        onClick={() => send({
          tool: 'video_timeline_remove',
          args: { timeline_id: timelineId, base_revision: baseRevision, ordinal: clip.ordinal },
        })}
      >{t('clip.remove')}</button>

      {/*
       * 顺序用两个按钮而不是拖放。文档要的是「调整片段顺序」这件事本身；库提供的行拖拽
       * 会把整条轨道搬走，而这里要动的是同一轨道内的一段 —— 用按钮表达既没有歧义，
       * 也不必再为「拖到哪个像素算第几位」定一套规则。
       */}
      <button
        type="button" className={styles.action} data-clip-action="earlier"
        disabled={index <= 0 || saving}
        onClick={() => send({
          tool: 'video_timeline_reorder',
          args: { timeline_id: timelineId, base_revision: baseRevision, from: clip.ordinal, to: clip.ordinal - 1 },
        })}
      >{t('clip.moveEarlier')}</button>

      <button
        type="button" className={styles.action} data-clip-action="later"
        disabled={index < 0 || index >= clips.length - 1 || saving}
        onClick={() => send({
          tool: 'video_timeline_reorder',
          args: { timeline_id: timelineId, base_revision: baseRevision, from: clip.ordinal, to: clip.ordinal + 1 },
        })}
      >{t('clip.moveLater')}</button>

      <span className={styles.divider} />

      <span className={styles.label}>{t('clip.speed')}</span>
      {SPEED_STEPS.map(speed => (
        <button
          key={speed}
          type="button"
          className={clip.speed === speed ? styles.speedOn : styles.speed}
          data-clip-speed={speed}
          aria-pressed={clip.speed === speed}
          disabled={saving}
          onClick={() => send({
            tool: 'video_timeline_adjust',
            args: { timeline_id: timelineId, base_revision: baseRevision, ordinal: clip.ordinal, speed },
          })}
        >{speed}×</button>
      ))}

      <button
        type="button"
        className={clip.muted ? styles.mutedOn : styles.action}
        data-clip-action="mute"
        aria-pressed={clip.muted}
        disabled={saving}
        onClick={() => send({
          tool: 'video_timeline_adjust',
          args: { timeline_id: timelineId, base_revision: baseRevision, ordinal: clip.ordinal, muted: !clip.muted },
        })}
      >{clip.muted ? t('clip.unmute') : t('clip.mute')}</button>

      {/*
       * 名字用输入框而不是 prompt()：prompt 是阻塞的浏览器对话框，在这个界面里样式失控，
       * 而且测试里没法断言。回车提交 —— 每一次按键都发一条编辑会让版本号被敲字推着走。
       */}
      <form
        className={styles.rename}
        data-clip-rename-form=""
        onSubmit={event => {
          event.preventDefault()
          send({
            tool: 'video_timeline_name_segment',
            args: { timeline_id: timelineId, base_revision: baseRevision, ordinal: clip.ordinal, name: draft },
          })
        }}
      >
        <input
          className={styles.renameInput}
          data-clip-rename=""
          placeholder={t('clip.namePlaceholder')}
          value={draft}
          disabled={saving}
          onChange={event => setDraft(event.target.value)}
        />
        <button type="submit" disabled={saving} className={styles.action} data-clip-action="rename">{t('clip.rename')}</button>
      </form>
    </div>
  )
}
