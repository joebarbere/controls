import baseConfig, { zodImportSyntax } from '../../../eslint.config.mjs';

/** Message shared by the pure-module rules below. */
const pureHint =
  'Pure renderer maths (cameras/camera-math, input/input-actions, picking/selection, stats/frame-timer, sim/display-curve, sim/lamp-display) must stay GPU-, DOM- and clock-free so it is unit-testable and deterministic. Snap and placement maths live in @controls/world-model (snap/).';

/** The same rule for the overlay display modules (F2.6). */
const overlayHint =
  'The overlay scales and display steps (sim/overlay-scale, sim/overlay-steps) must stay GPU-, DOM- and clock-free so they are unit-testable and deterministic; the GPU side is overlays/sim-overlays.';

/** The same rule for the wire renderer's pure modules (F3.2 part 2). */
const wireHint =
  'The wire looks, segment maths and preview rope (wires/wire-looks, wires/wire-segments, wires/rope) must stay GPU-, DOM- and clock-free so they are unit-testable and deterministic; the GPU side is wires/wire-renderer. Route shapes come from the domain bake (@controls/world-model routing), never from here.';

/** ADR 0010's three r186 gotcha, as a rule (F3.2 part 2 review). */
const noUpdateRange = {
  selector: "CallExpression[callee.property.name='addUpdateRange']",
  message:
    'Never addUpdateRange on instanced attributes: in three r186 a partial upload of a large InstancedMesh attribute made every later frame cost 40-250 ms of CPU (ADR 0010). Re-upload the whole buffer (needsUpdate = true).',
};

export default [
  ...baseConfig,
  // Every renderer source file (specs too): the zod import rule the base config sets, plus no partial uploads.
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...zodImportSyntax, noUpdateRange] },
  },
  // Pure modules: no Three.js, no three-mesh-bvh, no wall clock or randomness. Specs are included.
  {
    files: [
      'src/lib/cameras/camera-math*.ts',
      'src/lib/input/input-actions*.ts',
      'src/lib/picking/selection*.ts',
      'src/lib/stats/frame-timer*.ts',
      'src/lib/sim/display-curve*.ts',
      'src/lib/sim/lamp-display*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*', 'three-mesh-bvh', 'three-mesh-bvh/*'], message: pureHint },
            { group: ['../*viewport*', '../picking/picker', '../overlays/*'], message: pureHint },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: pureHint },
        { object: 'Date', property: 'now', message: pureHint },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: pureHint },
        { name: 'window', message: pureHint },
        { name: 'document', message: pureHint },
      ],
    },
  },
  // F2.6: the overlay scales and display steps (ADR 0011 §9.2 "Display modules"), fenced like the
  // modules above. A separate block so each sim display module can be listed without touching another's.
  {
    files: ['src/lib/sim/overlay-scale*.ts', 'src/lib/sim/overlay-steps*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*', 'three-mesh-bvh', 'three-mesh-bvh/*'], message: overlayHint },
            { group: ['../*viewport*', '../picking/picker', '../overlays/*'], message: overlayHint },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: overlayHint },
        { object: 'Date', property: 'now', message: overlayHint },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: overlayHint },
        { name: 'window', message: overlayHint },
        { name: 'document', message: overlayHint },
      ],
    },
  },
  // F3.2 part 2: the wire renderer's pure modules, fenced like the ones above.
  {
    files: ['src/lib/wires/rope*.ts', 'src/lib/wires/wire-looks*.ts', 'src/lib/wires/wire-segments*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*', 'three-mesh-bvh', 'three-mesh-bvh/*'], message: wireHint },
            { group: ['../*viewport*', '../picking/picker', '../overlays/*', './wire-renderer'], message: wireHint },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: wireHint },
        { object: 'Date', property: 'now', message: wireHint },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: wireHint },
        { name: 'window', message: wireHint },
        { name: 'document', message: wireHint },
      ],
    },
  },
];
