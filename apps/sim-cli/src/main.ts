import { runCli } from './cli';

// `pnpm sim` runs from the repository root; INIT_CWD is the directory the user typed it in.
const cwd = process.env['INIT_CWD'] ?? process.cwd();

process.exitCode = await runCli(process.argv.slice(2), {
  cwd,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
