/**
 * The social card.
 *
 * Same restraint as the page: grayscale, serif title, one monospace number.
 * The number is the one finding that is not a statistical result — the
 * multiplier delta on day 31 is exactly zero in all 200 seeds, with zero
 * variance, because the policy signal is still reading pre-wave flow.
 *
 * Rendered at build time into a static PNG. The two fonts are OFL-licensed and
 * are used only here; the page itself uses system font stacks.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ImageResponse } from 'next/og'

/** Static export: the image is generated once, at build time. */
export const dynamic = 'force-static'

export const alt =
  'The Thirty-First Day — an independent study of The Standard Reserve. On day 31 the multiplier delta is exactly 0.0000, in all 200 seeds.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const PAPER = '#faf9f7'
const INK = '#14130f'
const MUTED = '#4a4844'
const FAINT = '#7c7a74'
const RULE = '#cdcac3'

export default async function Image() {
  const assets = join(process.cwd(), 'assets')
  const serif = readFileSync(join(assets, 'EBGaramond-Regular.ttf'))
  const mono = readFileSync(join(assets, 'JetBrainsMono-Regular.ttf'))

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: PAPER,
          color: INK,
          padding: '64px 72px',
          fontFamily: 'Garamond',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontFamily: 'Mono',
            fontSize: 19,
            letterSpacing: 4,
            color: FAINT,
            textTransform: 'uppercase',
          }}
        >
          An independent study
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 92,
            lineHeight: 1.02,
            letterSpacing: 1,
            marginTop: 26,
            textTransform: 'uppercase',
          }}
        >
          The Thirty-First Day
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 30,
            lineHeight: 1.35,
            color: MUTED,
            marginTop: 22,
            maxWidth: 900,
          }}
        >
          What happens to The Standard Reserve when its first wave of dormant genesis bankers is
          revoked.
        </div>

        <div style={{ display: 'flex', flexGrow: 1 }} />

        <div style={{ display: 'flex', width: '100%', height: 1, background: RULE }} />

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginTop: 30,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 104, letterSpacing: -2 }}>
              0.0000
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 27,
                color: MUTED,
                marginTop: 12,
                maxWidth: 720,
                lineHeight: 1.3,
              }}
            >
              The change in the issuance multiplier on day 31. Exactly zero, in all 200 seeds, with
              zero variance — the bank cannot yet see the wave.
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Garamond', data: serif, style: 'normal', weight: 400 },
        { name: 'Mono', data: mono, style: 'normal', weight: 400 },
      ],
    },
  )
}
