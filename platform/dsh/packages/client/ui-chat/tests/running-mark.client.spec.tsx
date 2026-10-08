// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningMark } from '../src/client/chat/RunningMark.tsx'

afterEach(cleanup)

describe('RunningMark', () => {
  it('renders the decorative cut-frame mark as one inline SVG', () => {
    const view = render(<RunningMark />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(1)
    const svg = icon.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32')
    expect(svg.querySelectorAll('path')).toHaveLength(4)
    expect(view.container.querySelector('[style]')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('draws the ring twice so the stylesheet can sweep one copy', () => {
    const view = render(<RunningMark />)
    const [ring, sweep, frame, play] = [...view.container.querySelectorAll('path')]
    expect(view.container.querySelector('svg')?.getAttribute('fill')).toBe('none')
    expect(ring?.getAttribute('d')).toBe(sweep?.getAttribute('d'))
    expect(sweep?.getAttribute('pathLength')).toBe('100')
    expect(frame?.getAttribute('stroke-linejoin')).toBe('round')
    expect(play?.getAttribute('fill')).toBe('currentColor')
  })
})
