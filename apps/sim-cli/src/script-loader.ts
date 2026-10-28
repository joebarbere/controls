import type { Game } from '@controls/scripting-api';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * Loading a TypeScript scenario script (ADR 0008). The script is bundled with esbuild at run time
 * (a dev tool, so esbuild is a devDependency loaded only when a module script runs) and imported
 * from a temp file. Bundling, rather than Node's own type stripping, resolves the `@controls/*`
 * path aliases and accepts all of TypeScript. This only ever happens in this Node process: the
 * renderer never evaluates scripts, so nothing here touches its CSP.
 *
 * Imports are limited to relative files, the `type:domain` libs and `zod`, the same boundary the
 * `scope:headless` lint rule puts on `sim-cli` itself.
 */

/** Extensions run as module scripts; any other file is read as console lines. */
export const MODULE_SCRIPT_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];

/** The repository root: this file is three levels down in the source tree and in the bundle. */
export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type ScriptFunction = (game: Game) => unknown;

export type LoadScriptResult =
  { readonly ok: true; readonly run: ScriptFunction } | { readonly ok: false; readonly message: string };

/** `@controls/*` aliases that point into `libs/domain/`, read from `tsconfig.base.json`. */
export async function domainAliases(root: string = WORKSPACE_ROOT): Promise<Set<string>> {
  const config = JSON.parse(await readFile(join(root, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const aliases = new Set<string>();
  for (const [alias, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    if (targets.every((target) => target.replace(/^\.\//, '').startsWith('libs/domain/'))) aliases.add(alias);
  }
  return aliases;
}

/** Whether a script may import `specifier`. */
export function isAllowedImport(specifier: string, aliases: ReadonlySet<string>): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    isAbsolute(specifier) ||
    aliases.has(specifier) ||
    specifier === 'zod' ||
    specifier.startsWith('zod/')
  );
}

const DOMAIN_LIBS_DIR = join(WORKSPACE_ROOT, 'libs', 'domain') + sep;

/**
 * Whether an import is made by a domain lib's production source or by a package, rather than by
 * the script. The boundary applies to the script's own files: a domain lib's dependencies (zod,
 * fflate) are already bounded by the `type:domain` lint, and a script still can't import them
 * directly (except zod). Test helpers (`src/testing/`) get no exemption, so their dev-only
 * dependencies (fast-check) stay out of scripts.
 */
export function isLibraryImporter(importer: string): boolean {
  const segments = importer.split(/[\\/]/);
  if (segments.includes('node_modules')) return true;
  return importer.startsWith(DOMAIN_LIBS_DIR) && !/[\\/]src[\\/]testing[\\/]/.test(importer);
}

/** Bundles and imports a module script, returning its default export. Never throws. */
export async function loadModuleScript(path: string, label = path): Promise<LoadScriptResult> {
  const { build } = await import('esbuild');
  const aliases = await domainAliases();
  let code: string;
  try {
    const result = await build({
      entryPoints: [path],
      absWorkingDir: WORKSPACE_ROOT,
      tsconfig: join(WORKSPACE_ROOT, 'tsconfig.base.json'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
      sourcemap: 'inline',
      logLevel: 'silent',
      plugins: [
        {
          name: 'sim-cli-import-boundary',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /.*/ }, (args) =>
              args.kind === 'entry-point' || isLibraryImporter(args.importer) || isAllowedImport(args.path, aliases)
                ? undefined
                : {
                    errors: [
                      {
                        text: `Scripts may import only relative files, type:domain libs (@controls/…) and zod, not "${args.path}"`,
                      },
                    ],
                  },
            );
          },
        },
      ],
    });
    code = result.outputFiles[0].text;
  } catch (error) {
    const errors = (error as { errors?: { text: string; location?: { line: number; column: number } | null }[] })
      .errors;
    const first = errors?.[0];
    const where = first?.location ? `:${first.location.line}:${first.location.column + 1}` : '';
    return { ok: false, message: `${label}${where}: ${first?.text ?? String(error)}` };
  }

  const dir = await mkdtemp(join(tmpdir(), 'controls-sim-'));
  try {
    const file = join(dir, 'script.mjs');
    await writeFile(file, code);
    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (error) {
      return { ok: false, message: `${label}: the script threw while loading: ${String(error)}` };
    }
    if (typeof module.default !== 'function') {
      return { ok: false, message: `${label}: the script must export a default function (game) => …` };
    }
    return { ok: true, run: module.default as ScriptFunction };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
