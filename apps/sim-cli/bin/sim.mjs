#!/usr/bin/env node
// `pnpm sim …`: rebuilds the sim-cli bundle (esbuild, well under a second) and runs it, so the CLI
// always matches the source without Nx output on stdout. stdout stays data-only (hashes).
import { pathToFileURL } from 'node:url';
import { buildSimCli, SIM_CLI_BUNDLE } from '../build.mjs';

await buildSimCli();
await import(pathToFileURL(SIM_CLI_BUNDLE).href);
