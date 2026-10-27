import baseConfig from '../../../eslint.config.mjs';

/** Message shared by the pure-module rules below. */
const pureHint =
  'Pure renderer maths (snap/, cameras/camera-math, input/input-actions, picking/selection, stats/frame-timer) must stay GPU-, DOM- and clock-free so it is unit-testable and deterministic; snap/ moves to @controls/world-model in F1.2.';

export default [
  ...baseConfig,
  // Pure modules: no Three.js, no three-mesh-bvh, no wall clock or randomness. Specs are included.
  {
    files: [
      'src/lib/snap/**/*.ts',
      'src/lib/cameras/camera-math*.ts',
      'src/lib/input/input-actions*.ts',
      'src/lib/picking/selection*.ts',
      'src/lib/stats/frame-timer*.ts',
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
];
