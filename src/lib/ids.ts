/**
 * Client-generated ids.
 *
 * Lives in its own module rather than in outbox.ts so that groups.ts (which
 * needs an action id for every write RPC) does not have to import the outbox,
 * which in turn imports groups.ts to replay queued actions. A require cycle
 * between those two would resolve at runtime but leave one of the bindings
 * undefined depending on which module Metro loads first.
 */

/**
 * uuid v4 without a native dependency.
 *
 * expo-crypto would be better, but Math.random is adequate here: these ids only
 * need to be unique across one device's pending queue, and they are never a
 * security boundary.
 */
export function makeActionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
