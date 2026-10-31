import baseConfig from '../../../eslint.config.mjs';

/** Message shared by the pure-module rules below. */
const pureHint =
  'Pure renderer maths (cameras/camera-math, input/input-actions, picking/selection, stats/frame-timer, sim/display-curve, sim/lamp-display) must stay GPU-, DOM- and clock-free so it is unit-testable and deterministic. Snap and placement maths live in @controls/world-model (snap/).';

/** The same rule for the overlay display modules (F2.6). */
const overlayHint =
  'The overlay scales and display steps (sim/overlay-scale, sim/overlay-steps) must stay GPU-, DOM- and clock-free so they are unit-testable and deterministic; the GPU side is overlays/sim-overlays.';

export default [
  ...baseConfig,
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
];
