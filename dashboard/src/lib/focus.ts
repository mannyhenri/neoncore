/**
 * Focus `el` only if the user isn't already typing somewhere else.
 *
 * Use this for any focus that fires WITHOUT a user gesture — a card mounting because an
 * agent came online, a question arriving from a busy cartridge. Agents generate that
 * traffic constantly, and an unconditional focus() yanks the caret out of whatever field
 * the user is mid-sentence in. Focus that follows a click (opening a modal, an editor,
 * a reply box) can keep using plain autoFocus.
 */
export function focusIfIdle(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== el && active !== document.body && isEditable(active)) return;
  el.focus();
}

function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
}
