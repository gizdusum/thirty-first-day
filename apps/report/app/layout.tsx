import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './globals.css'

const TITLE = 'The Thirty-First Day'
const DESCRIPTION =
  'An independent study of what happens to The Standard Reserve when its first wave of dormant genesis bankers is revoked.'

const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://thirty-first-day.vercel.app'

/**
 * The social card comes from `app/opengraph-image.tsx`, Next's metadata-file
 * convention, which takes precedence over anything set here — so the og:image
 * tags are deliberately left for it to fill in. `scripts/postbuild.mjs` also
 * copies the generated file to `out/og.png`, because the convention exports it
 * without a file extension and a host that guesses content types from one
 * would serve it as an octet-stream.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  authors: [{ name: 'Independent' }],
  openGraph: {
    type: 'article',
    title: TITLE,
    description: DESCRIPTION,
    siteName: TITLE,
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f7' },
    { media: '(prefers-color-scheme: dark)', color: '#121210' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
