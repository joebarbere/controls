import { toolBeltBindingDecls } from '../builtin';
import { extraBindingDecls } from '../view';
import type { CommandRegistry } from '../registry';
import { type BindingDecl, commandBindingDecls, inputActionDecls } from './keymap';

/**
 * Every default binding for a registry: commands with a `keybinding`, the tool-belt keys (when
 * `toolbelt.select` is registered), the commands' extra `bindings` (fixed or context arguments:
 * `view.mode.walk`, `view.focus.selection`, `entity.delete.selection`) and the input actions. The keybinding service and the rebinding
 * UI start from this list; a spec checks the defaults are conflict-free.
 */
export function defaultBindingDecls<S>(registry: CommandRegistry<S>): BindingDecl[] {
  const fixedArgs = toolBeltBindingDecls().filter((d) => d.target.kind === 'command' && registry.has(d.target.command));
  const defs = registry.list();
  return [...commandBindingDecls(defs), ...fixedArgs, ...extraBindingDecls(defs), ...inputActionDecls()];
}
