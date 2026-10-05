/**
 * The revisions a timeline has been through, and the way back to one of them.
 *
 * An edit you cannot take back is an edit nobody makes. The mechanism was already here — every
 * accepted edit records a snapshot before it changes anything — so this is the surface that makes
 * it usable: which states exist, what each one did, and a way to go back.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not restore anything itself.** Picking a revision produces the tool call that would
 *   restore it and hands it up, exactly as a drag does. The call carries the revision the person
 *   was looking at, so a restore that raced another edit is refused instead of quietly discarding
 *   it.
 * - **It does not show the clips of each revision.** Ten revisions each carrying its whole clip
 *   list is a large answer to the question "which one was it"; the note and the clip count are what
 *   someone actually picks by.
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Read, RevisionEntry } from './read.ts'
import styles from './RevisionList.module.css'

/** What the list draws and reports. */
export type RevisionListProps =
  & PropsLocale<'workbench'>
  & {
    /** The revisions as they were read. */
    readonly history: Read<{ readonly entries: readonly RevisionEntry[] }> | { readonly status: 'loading' }
    /** The revision the timeline is on now, so it can be marked as the present. */
    readonly currentRevision: number
    /** Called with the revision to restore, or null when nothing should change. */
    readonly onRestore: (targetRevision: number | null) => void
    /** The revision a restore has already been proposed for, if any. */
    readonly proposed: number | null
  }

/**
 * Format a revision's time for reading.
 *
 * Seconds-resolution rather than "3 minutes ago": a relative time would need re-rendering to stay
 * true, and this list is not worth a timer. The full stamp is on the title.
 *
 * @param at - milliseconds since the epoch.
 * @returns A short local time.
 */
function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Render the revision list.
 * @param props - the revisions, the current one, and the restore channel.
 * @returns the list, or the reason there is none.
 */
export function RevisionList({ history, currentRevision, onRestore, proposed, t }: RevisionListProps): ReactNode {
  if (history.status === 'loading') {
    return <p className={styles.note} data-history-loading="">{t('revision.loading')}</p>
  }
  if (history.status === 'absent') {
    // 没有历史与「读不到历史」是两件事：前者说明这是一条刚建的时间线，
    // 后者说明读取出了问题。合成一句话会把故障说成正常。
    return <p className={styles.note} data-history-absent="">{t('revision.none')}</p>
  }
  if (history.status === 'failed') {
    return <p className={styles.note} data-history-failed="">{t('revision.failed')}</p>
  }
  // 形状不对（例如路由返回了另一个维度的载荷）时不炸整个界面：这个面板读的是网络应答，
  // 而网络应答是边界；一个读不懂的应答应当让这张卡片说「读不出来」，而不是把整页带走。
  const entries = Array.isArray(history.value.entries) ? history.value.entries : []
  if (entries.length === 0) {
    return <p className={styles.note} data-history-empty="">{t('revision.none')}</p>
  }

  return (
    <ol className={styles.list} data-history="">
      {entries.map(entry => {
        const isPresent = entry.revision === currentRevision
        const isProposed = entry.revision === proposed
        return (
          <li key={entry.revision} className={styles.item}>
            <button
              type="button"
              className={isProposed ? styles.rowProposed : styles.row}
              data-revision={entry.revision}
              data-revision-current={isPresent ? '' : undefined}
              data-revision-proposed={isProposed ? '' : undefined}
              // 已经是当前版本就没有「回到它」这回事，按下去只会发出一次原地不动的编辑。
              disabled={isPresent}
              onClick={() => onRestore(entry.revision)}
            >
              <span className={styles.number}>{t('revision.label', { revision: String(entry.revision) })}</span>
              <span className={styles.detail}>
                <span className={styles.note_}>{entry.note ?? t('revision.unnamed')}</span>
                <span className={styles.meta}>
                  {t('revision.clips', { count: String(entry.segment_count) })} · {clock(entry.at)}
                </span>
              </span>
              {isPresent && <span className={styles.badge} data-revision-badge="">{t('revision.current')}</span>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
