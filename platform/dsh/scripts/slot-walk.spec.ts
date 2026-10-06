// @vitest-environment node
/**
 * The slot scan reads the repository's tracked files, not every file its glob finds.
 *
 * `tsc` writes declaration output beside the sources (`declaration: true`), a `.d.ts` name ends in
 * `.ts`, and the scan's globs ask for every `.ts` under a package's `src` — so a built tree hands the
 * scan two declarations of every slot and two declarations of every exported type. The symptom is not a crash: the duplicate slot
 * fails `validateSlotContracts`, and the duplicate type is dropped as ambiguous, which then fails
 * every slot naming it as owner props. Both were observed only after a type-check had run, so the same
 * command passed on a fresh clone and failed on a built one.
 *
 * These cases pin the boundary with a real repository fixture rather than a synthetic one: an emitted
 * declaration is only distinguishable from a hand-written one by whether the index lists it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanSlotFiles } from './slot-walk.ts'

const roots: string[] = []

/** A slot contract merge, which is what makes a file interesting to the scan. */
const CONTRACT = 'declare module \'@deepseek-ai/dsh-client-ui-slots\' {\n'
  + '  interface SlotMap { \'sample.seat\': { kind: \'single\'; scope: \'root\' } }\n'
  + '}\n'

/**
 * Build a throwaway repository holding one tracked contract and the declaration emitted beside it.
 *
 * The emitted file carries the contract too. That is the real shape: `tsc` copies a declaration merge
 * into the `.d.ts` it writes, so the prefilter that keeps the scan cheap does not drop it and the scan
 * reads the same slot twice. A `.d.ts` without a contract would be filtered out by that prefilter
 * anyway, and the case would pass whatever the source set was.
 *
 * @returns the fixture's root, tracked so it is removed afterwards.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'slot-walk-tracked-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const src = join(root, 'packages', 'sample', 'sample', 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'contract.ts'), CONTRACT)
  writeFileSync(join(src, 'contract.d.ts'), CONTRACT)
  execFileSync('git', ['add', 'packages/sample/sample/src/contract.ts'], { cwd: root })
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('slot scan source set', () => {
  it('scans the tracked contract and skips the declaration emitted beside it', () => {
    const root = fixture()
    const found = scanSlotFiles(root, ['packages/*/*/src/**/*.ts']).map(file => file.rel)
    expect(found).toContain('packages/sample/sample/src/contract.ts')
    expect(found).not.toContain('packages/sample/sample/src/contract.d.ts')
  })

  it('falls back to the glob when git cannot answer', () => {
    // A `sources` tarball or a sandbox without the git binary has no index; the scan must still work.
    const root = fixture()
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const found = scanSlotFiles(root, ['packages/*/*/src/**/*.ts']).map(file => file.rel)
    expect(found).toContain('packages/sample/sample/src/contract.ts')
  })
})
