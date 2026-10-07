// @vitest-environment node
/**
 * One upload per destination key.
 *
 * Proxy encoding has always been cached by source bytes, so an unchanged asset is transcoded once.
 * The upload that followed was not: `askChunks` built its object key from `randomUUID()`, so a retry
 * after a model error — or any second question about the same asset — streamed the same bytes to the
 * bucket again. The key is now derived from the proxy's content, and `uploadFile` memoizes by key.
 *
 * These cases pin the two halves of that: the same bytes must reach OSS once, and a *failed* attempt
 * must not be remembered, because a cache that keeps a rejection would turn one transient 5xx into a
 * permanently broken asset.
 *
 * The memo is not observable through `understand` in an end-to-end probe: the per-chunk cache row
 * short-circuits the second call before it reaches the upload, so an assertion there passes whichever
 * key is built. Testing the seam directly is what makes the behaviour actually covered.
 */
import { mkdtempSync, rmSync, writeFileSync as writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import { VideoWorkspace } from '../src/runtime.ts'

/** The private seam under test; the class keeps it off its public face deliberately. */
interface UploadSeam {
  uploadFile: (path: string, key: string, contentType: string, label?: string) => Promise<string>
  prepare: (path: string, signal: AbortSignal) => Promise<{ file: string, digest: string }>
}

const puts: string[] = []
const refused: string[] = []
let alwaysFailPut = false
let fixture = ''

beforeEach(() => {
  puts.length = 0
  refused.length = 0
  alwaysFailPut = false
  const dir = mkdtempSync(join(tmpdir(), 'goclip-upload-memo-'))
  fixture = join(dir, 'body.bin')
  writeSync(fixture, 'proxy bytes')
  vi.stubGlobal('fetch', async (url: string | URL, init: { method?: string } = {}) => {
    const target = String(url)
    if ((init.method ?? 'GET') === 'PUT') {
      if (alwaysFailPut) {
        refused.push(target.split('?')[0] ?? target)
        return new Response('upstream said no', { status: 500 })
      }
      puts.push(target.split('?')[0] ?? target)
      return new Response('', { status: 200 })
    }
    return new Response('', { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(join(fixture, '..'), { recursive: true, force: true })
})

/**
 * A workspace whose OSS credentials and endpoint are stubs.
 * @returns the workspace plus its private upload seam.
 */
function workspace(): UploadSeam {
  const config = {
    dataDir: '/tmp/goclip-upload-memo-unused',
    ossEndpoint: 'oss-cn-beijing.aliyuncs.com',
    ossBucket: 'stub',
    ossAccessKeyIdEnv: 'STUB_ID',
    ossAccessKeySecretEnv: 'STUB_SECRET',
    ossPrefix: 'goclip-temporary',
    signedUrlSeconds: 900,
  } as unknown as Config
  process.env.STUB_ID = 'x'
  process.env.STUB_SECRET = 'y'
  return new VideoWorkspace(config) as unknown as UploadSeam
}

describe('upload memoization', () => {
  it('streams the same destination key once, however many callers ask', async () => {
    const seam = workspace()
    const key = 'goclip-temporary/proxy-deadbeef.mp4'
    const [a, b] = await Promise.all([
      seam.uploadFile(fixture, key, 'video/mp4'),
      seam.uploadFile(fixture, key, 'video/mp4'),
    ])
    expect(puts).toHaveLength(1)
    // Both callers get the same answer, so joining the upload is invisible to them.
    expect(a).toBe(b)
  })

  it('uploads again for a different key, because the key is what identifies the bytes', async () => {
    const seam = workspace()
    await seam.uploadFile(fixture, 'goclip-temporary/one.mp4', 'video/mp4')
    await seam.uploadFile(fixture, 'goclip-temporary/two.mp4', 'video/mp4')
    expect(puts).toHaveLength(2)
  })

  it('forgets a failed upload so the retry really retries', async () => {
    const seam = workspace()
    const key = 'goclip-temporary/proxy-failed.mp4'
    /*
     * 桩件必须拒绝**每一次**尝试，而不是一次：`uploadFile` 经 `fetchWithRetry` 重试，
     * 单次 500 会被吸收掉、调用照样 resolve —— 那看起来像「记忆被清掉了」，其实根本没有失败可记。
     */
    alwaysFailPut = true
    await expect(seam.uploadFile(fixture, key, 'video/mp4')).rejects.toThrow()
    const attemptsWhileFailing = refused.length
    alwaysFailPut = false
    // 若失败被记住，这里会直接重抛同一个 rejection、不再碰网络；没记住才会真的再传一次。
    await expect(seam.uploadFile(fixture, key, 'video/mp4')).resolves.toBeTypeOf('string')
    expect(attemptsWhileFailing).toBeGreaterThanOrEqual(2)
    expect(puts).toHaveLength(1)
  })
})
