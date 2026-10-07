/**
 * The output column: every render attempt on this asset, newest first.
 *
 * Each finished film plays from the plugin's own route rather than from an object-store address,
 * which is what keeps the page free of credentials and lets a film longer than memory stream and
 * seek.
 *
 * **Failed attempts are listed too.** They used to be filtered out, on the reasoning that an
 * attempt with no output has nothing to play — which is true and is the wrong question. A render
 * that died during the burn is exactly what somebody needs to see, and a list that omits it reports
 * "no films" for a timeline that has been rendered three times. When one fails, the entry names the
 * step it died at and offers the steps that ran, because "which step" is the difference between
 * retrying and fixing something.
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Render } from './read.ts'
import styles from './OutputList.module.css'

/** What the output column reads. */
export type OutputListProps =
  & PropsLocale<'workbench'>
  & {
    /** The render attempts, in the order the host returned them. */
    readonly renders: readonly Render[]
    /** Cancelling is explicit: closing the workbench must not cancel a background export. */
    readonly onCancel?: (jobId: string) => void
    readonly cancellingJobId?: string | null
  }

/**
 * Render the attempts.
 * @param props - the attempts to list.
 * @returns the list, or an explanation when there is nothing at all.
 */
export function OutputList({ renders, t, onCancel, cancellingJobId = null }: OutputListProps): ReactNode {
  if (renders.length === 0) {
    return (
      <div className={styles.notice} data-output="none">
        <p className={styles.noticeTitle}>{t('output.none')}</p>
        <p className={styles.noticeHint}>{t('output.none.hint')}</p>
      </div>
    )
  }
  return (
    <div className={styles.list} data-output="list">
      {renders.map(render => {
        const failed = render.status === 'failed' || render.url === null
        return (
          <section
            key={render.job_id}
            className={styles.render}
            data-render={render.job_id}
            data-render-failed={failed ? '' : undefined}
          >
            {render.url === null
              ? (
                <div className={styles.failed} data-render-notice="">
                  <p className={styles.failedTitle}>
                    {render.status === 'failed' ? t('output.failed') : t('output.unfinished', { status: render.status })}
                  </p>
                  {/* 死在哪一步是这一栏唯一能据以行动的信息：下载失败与烧录失败要做的事完全不同。 */}
                  {render.failed_stage !== null && (
                    <p className={styles.failedStage} data-render-stage="">
                      {t('output.failedStage', { stage: render.failed_stage })}
                    </p>
                  )}
                  {render.note !== null && <p className={styles.failedNote}>{render.note}</p>}
                </div>
              )
              : <video className={styles.video} src={render.url} controls preload="metadata" />}
            <p className={styles.meta}>
              <span className={styles.name}>{render.timeline_name ?? render.timeline_id}</span>
              <span>{t('output.job', { job: render.job_id.slice(0, 8) })}</span>
              {/* 与版本列表同一处文案：`r` 是给人看的字，必须走字典。 */}
              {render.timeline_revision !== null && <span data-render-revision="">{t('revision.label', { revision: String(render.timeline_revision) })}</span>}
            </p>
            {render.stale && <p className={styles.stale} data-render-stale="">{t('output.stale', { revision: String(render.current_revision) })}</p>}
            {render.url !== null && <a className={styles.download} data-render-download={render.job_id} href={`${render.url}?download=1`}>{t('output.download')}</a>}
            {(render.status === 'queued' || render.status === 'running' || render.status === 'cancelling') && onCancel !== undefined && (
              <button type="button" className={styles.cancel} disabled={cancellingJobId === render.job_id || render.status === 'cancelling'} onClick={() => onCancel(render.job_id)}>
                {render.status === 'cancelling' || cancellingJobId === render.job_id ? t('output.cancelling') : t('output.cancel')}
              </button>
            )}
            {/*
             * 走过的步骤折在 details 里：成功时没人看它，失败时它是唯一的线索。
             * 成功的尝试不给折叠面板 —— 那会让一列成片各挂一串没人展开的时间。
             */}
            {failed && render.stages.length > 0 && (
              <details className={styles.stages} data-render-stages="">
                <summary className={styles.stagesSummary}>{t('output.stages', { count: String(render.stages.length) })}</summary>
                <ol className={styles.stageList}>
                  {render.stages.map(stage => (
                    <li
                      key={`${stage.stage}-${stage.ms}`}
                      className={stage.outcome === 'failed' ? styles.stageFailed : styles.stage}
                      data-render-stage-row={stage.stage}
                      data-render-stage-outcome={stage.outcome ?? 'unknown'}
                    >
                      <span className={styles.stageName}>{stage.stage}</span>
                      <span className={styles.stageMs}>
                        {stage.skipped === true ? t('output.stageSkipped') : t('output.stageMs', { ms: String(stage.ms) })}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
        )
      })}
    </div>
  )
}
