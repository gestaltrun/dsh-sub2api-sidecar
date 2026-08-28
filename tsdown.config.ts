/**
 * tsdown build for the browser half: one self-contained lazy-CJS bundle at
 * `lib/client.js`, shaped for the harness module loader — the bundle calls
 * `window.__ModuleLoader__.load({id, factory})` and resolves its externals
 * (the two react specifiers) through the injected `require`. CSS Modules are
 * compiled by lightningcss inside the bundle: importing a `*.module.css`
 * yields the hashed class map, and the css text auto-injects one
 * `<style data-plugin>` tag at factory execution. The node half stays on
 * `tsc -p tsconfig.build.json` (see package.json scripts); `pnpm bundle`
 * emits only this artifact.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id stamped into the loader handoff and onto the injected style tags. */
const PLUGIN_ID = 'dsh-sub2api-sidecar'

/** Loader module-table entries the bundle resolves through `require` instead of inlining. */
const PLATFORM_MODULES = ['react', 'react/jsx-runtime'] as const

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches
 * ids ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical source onto a browser URL mirroring the repository tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split('\\').join('/')
  return repositoryPath.startsWith('src/') ? `../../${repositoryPath}` : source
}

const cssModulesInline = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined): string | null {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    const absolute = resolvePath(dirname(importer), source)
    if (!existsSync(absolute)) return null
    return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string): Promise<string | null> {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
    ;(this as unknown as { addWatchFile(id: string): void }).addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: Buffer.from(source),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

export default defineConfig((): UserConfig => ({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half; clean must stay off so the
  // tsc-emitted node-half artifacts survive.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  noExternal: (id: string) => (PLATFORM_MODULES.includes(id as (typeof PLATFORM_MODULES)[number]) ? false : true),
  // Bundled react probes NODE_ENV / import.meta.env; both keys honor the
  // build's NODE_ENV so a dev build keeps dev-branch semantics.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulesInline],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapPathTransform: browserSourcePath,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}))
