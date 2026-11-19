/*
 * A Vitest setup file for every Angular test target (`setupFiles` in each project's `test` options),
 * run before each spec file, outside any test's timeout. It pays a one-off jsdom cost that otherwise
 * lands on whichever test runs first: jsdom parses its built-in user-agent stylesheet on the first
 * `getComputedStyle` (about 0.7 s on a CPU-squeezed run, more on a slow macOS runner), and every
 * role query with a name calls it (ui caveats, "The first test in a jsdom process").
 */
window.getComputedStyle(document.body);
