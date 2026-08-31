import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installLocalSub2api } from '../scripts/build-runtime-pack.mjs'

describe('runtime pack local Sub2API source', () => {
  it('copies the exact built binary and records its source commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-pack-source-'))
    const binary = join(root, 'built-sub2api')
    const packBin = join(root, 'pack', 'bin')
    await writeFile(binary, 'native-sub2api')

    const source = await installLocalSub2api(binary, 'BeiKeJieDeLiuLangMao/sub2api@300b18628', '0.1.183-dsh.445.1', packBin)

    expect(await readFile(join(packBin, 'sub2api'), 'utf8')).toBe('native-sub2api')
    expect((await stat(join(packBin, 'sub2api'))).mode & 0o111).not.toBe(0)
    expect(source).toMatchObject({
      version: '0.1.183-dsh.445.1',
      sourceRef: 'BeiKeJieDeLiuLangMao/sub2api@300b18628',
    })
    expect(source.binarySha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
