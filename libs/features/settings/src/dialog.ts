// The settings screen's components, a separate entry so the shell can `@defer` them (plan P4 D19):
// re-exporting them from the package index would put them back in the initial bundle.
export * from './lib/settings-dialog';
export * from './lib/settings-form';
export * from './lib/keybindings-dialog';
export * from './lib/keybindings-editor';
