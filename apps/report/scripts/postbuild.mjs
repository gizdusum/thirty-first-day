/**
 * Give the generated social card a file extension.
 *
 * Next's metadata-image route exports to `out/opengraph-image` with no
 * extension. Vercel's Next.js integration knows its content type; a plain
 * static host does not, and would serve it as an octet-stream — which renders
 * as no card at all, silently. Copying it to `og.png` makes the export work
 * anywhere, and the page references that path directly.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const out = join(process.cwd(), 'out')
const from = join(out, 'opengraph-image')
const to = join(out, 'og.png')

if (!existsSync(from)) {
  console.error('postbuild: out/opengraph-image is missing; was the build run?')
  process.exit(1)
}
copyFileSync(from, to)
console.log('postbuild: wrote out/og.png')
