/**
 * Whether the floating tab bar may show for the focused tab.
 *
 * The bar belongs on a tab's root screen only. Anything deeper (a group, its
 * chat, its files, the new-group form) has its own pinned bottom action or the
 * composer, and a bar floating over those hides the one control the screen is
 * for.
 *
 * "Deeper" is decided by the NAME of the page focused inside the tab, not by
 * its position in the tab's stack. A page reached across tabs (Home's "Open
 * chat") or from a link is mounted as the only entry in the stack, at index 0,
 * so an index check reads it as the tab's root and leaves the bar on top of
 * the chat composer. Before the nested navigator has mounted, the target page
 * is still named in the route's params, so that is read too.
 */

/** The file-based route name of every tab's root screen. */
export const TAB_ROOT_SCREEN = 'index';

/** The slice of a navigation route this rule reads. */
export interface TabRouteLike {
  state?: { index?: number; routes?: { name: string }[] };
  params?: object;
}

/** Name of the page focused inside a tab, or null when it is the tab itself. */
export function focusedNestedScreen(route: TabRouteLike): string | null {
  const nested = route.state;
  if (nested?.routes && nested.routes.length > 0) {
    const i = nested.index ?? nested.routes.length - 1;
    return nested.routes[i]?.name ?? null;
  }
  const screen = (route.params as { screen?: unknown } | undefined)?.screen;
  return typeof screen === 'string' ? screen : null;
}

/** True when the tab bar may float over the focused tab. */
export function showTabBarFor(route: TabRouteLike): boolean {
  const screen = focusedNestedScreen(route);
  return screen === null || screen === TAB_ROOT_SCREEN;
}
