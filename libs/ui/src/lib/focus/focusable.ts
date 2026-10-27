const FOCUSABLE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

/**
 * Elements inside `root` that Tab can reach, in DOM order: not disabled, not `tabindex="-1"`,
 * not inside `[inert]` or `[hidden]`, and rendered (where the engine can tell; jsdom can't).
 * A named radio group is a single tab stop: its checked radio, or its first one if none is checked.
 */
export function focusableElements(root: ParentNode): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabbable);
  const radioStops = new Map<string, HTMLInputElement>();
  for (const el of candidates) {
    if (!isNamedRadio(el)) continue;
    const stop = radioStops.get(el.name);
    if (!stop || (el.checked && !stop.checked)) radioStops.set(el.name, el);
  }
  return candidates.filter((el) => !isNamedRadio(el) || radioStops.get(el.name) === el);
}

function isNamedRadio(el: HTMLElement): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '';
}

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[inert], [hidden]')) return false;
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
}

/** Focuses `el` if it is still in the document. Returns whether it did. */
export function restoreFocus(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  el.focus();
  return true;
}
