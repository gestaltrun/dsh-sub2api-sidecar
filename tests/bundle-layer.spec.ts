/** Published bundle defaults that must boot with the published runtime pack. */

import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('installable bundle layer', () => {
  it('skips the darwin runtime pack Redis placeholder by default', async () => {
    const patch = await fs.readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(patch).toMatch(/redis:\n\s+skip: true/u)
  })
})
