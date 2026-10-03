/** `evidence` namespace dictionaries: every string the evidence panel renders. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '证据总览',
  'panel.empty': '这次调用没有带回可画的证据数据。',
  'panel.missing': '缺少证据',
  'panel.missing.none': '六维齐全',
  'panel.axis.start': '开头',
  'panel.axis.end': '结尾',

  'track.loudness': '响度',
  'track.shots': '镜头',
  'track.silences': '停顿',
  'track.transcript': '转写',
  'track.screen_text': '屏文字',
  'track.scenes': '画面',
  'track.chapters': '章节',

  'dimension.acoustic-loudness': '响度',
  'dimension.shot-boundaries': '镜头',
  'dimension.silence-timing': '停顿',
  'dimension.transcript': '语音转写',
  'dimension.screen-text': '屏幕文字',
  'dimension.scene-description': '画面描述',

  'unit.db': 'dBFS',
  'unit.count': '条',

  'timeline.title': '时间线',
  'timeline.muted': '静音',
  'timeline.speed': '倍速',
  'timeline.revision': '版本',
} satisfies Record<string, string>

/** The evidence namespace key union. */
export type EvidenceKey = keyof typeof zh

/**
 * Dictionary namespace this package owns.
 *
 * The panel registers into the keyed `tool.call.toolview` seat, whose locale
 * binding resolves through the `conversation` namespace — the seat ui-tool
 * declares. The `evidence` namespace is registered here and read through the
 * seat's binding, so the component's `t` is typed by the seat, not by this
 * dictionary.
 */
export const NS = 'evidence'

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.title': 'Evidence Overview',
  'panel.empty': 'This call returned no drawable evidence data.',
  'panel.missing': 'Missing evidence',
  'panel.missing.none': 'All six dimensions',
  'panel.axis.start': 'Start',
  'panel.axis.end': 'End',

  'track.loudness': 'Loudness',
  'track.shots': 'Shots',
  'track.silences': 'Silences',
  'track.transcript': 'Transcript',
  'track.screen_text': 'Screen text',
  'track.scenes': 'Scenes',
  'track.chapters': 'Chapters',

  'dimension.acoustic-loudness': 'Loudness',
  'dimension.shot-boundaries': 'Shots',
  'dimension.silence-timing': 'Silences',
  'dimension.transcript': 'Transcript',
  'dimension.screen-text': 'Screen text',
  'dimension.scene-description': 'Scene description',

  'unit.db': 'dBFS',
  'unit.count': 'items',

  'timeline.title': 'Timeline',
  'timeline.muted': 'Muted',
  'timeline.speed': 'Speed',
  'timeline.revision': 'rev',
} satisfies Record<EvidenceKey, string>
