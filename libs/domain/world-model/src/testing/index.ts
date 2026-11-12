/*
 * TEST-ONLY helpers (`@controls/world-model/testing`): a wiring catalogue and a wired world v3 document
 * for specs in world-model and the libraries above it. Never imported by production code, with one exception: the `sim-cli` bench case `cable-add-worst-command` uses it until a real cable assembly ships (F3.1 part 2).
 */
export * from './wiring-catalog';
export * from './wired-world';
export * from './wiring-bench';
