#!/usr/bin/env node
// Prints the `sim bench` report that `pnpm verify`'s bench target wrote (Nx hides a passing task's
// output): first one line per gated case with its gated ratio, then the full JSON. CI's `sim bench
// report` step runs it on every OS. It only prints and always exits 0, so `verify` stays == CI.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist/apps/sim-cli/bench-report.json');
if (!existsSync(file)) {
  console.log('no bench report (the bench target did not run)');
} else {
  const text = readFileSync(file, 'utf8');
  try {
    const report = JSON.parse(text);
    for (const c of report.cases ?? []) {
      if (c.budgetMs === null || c.budgetMs === undefined) continue;
      const calibration = c.calibration
        ? `, ${c.gatedMs.toFixed(3)} ms on the reference machine; calibration ${c.calibration.medianMs.toFixed(3)} ms, scale ${c.calibration.scale.toFixed(3)}`
        : '';
      console.log(
        `GATE ${c.ok ? 'pass' : 'FAIL'} ${c.name}: ratio ${c.ratio.toFixed(3)} (≤ 1 passes; budget ${c.budgetMs} ms, raw median ${c.medianMs.toFixed(3)} ms${calibration})`,
      );
    }
  } catch (error) {
    console.log(`bench report unreadable: ${error}`);
  }
  console.log(text);
}
