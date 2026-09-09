/**
 * What the visitor asked for on their way into the configurator.
 *
 * Today that is which plan they clicked and whether they were looking at
 * yearly or monthly prices. It used to be nothing: all six "build" CTAs
 * on the storefront called one argument-less handler, so pressing
 * "Configure this" on the One Room card and pressing it on Whole
 * Building were indistinguishable by the time the wizard rendered. The
 * wizard then hardcoded Whole Building, and the two surfaces agreed only
 * by the coincidence of two independent useState(true) calls.
 *
 * That mattered more than a preselected radio button: `quotedAmount` is
 * frozen onto the Order as the record of what this customer was offered,
 * so a buyer who chose the cheapest plan could place an order priced at
 * three times it without either side noticing.
 *
 * sessionStorage rather than a prop, for the same reason
 * pendingConfiguration uses it: the choice has to survive a trip through
 * sign-in and a page refresh, but must not still be sitting there
 * tomorrow deciding a different configuration's price.
 */
const KEY = "silla_entry_intent";

export function saveIntent(value) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    // Storage blocked. Losing a preselected plan is a small annoyance;
    // refusing to open the configurator over it would not be.
    return false;
  }
}

export function peekIntent() {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Reads it and clears it.
 *
 * Cleared on read so a plan chosen on Tuesday cannot reappear over an
 * unrelated configuration on Wednesday — the same rule the pending
 * configuration follows, and for the same reason.
 */
export function takeIntent() {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
