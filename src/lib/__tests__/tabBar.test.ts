import { focusedNestedScreen, showTabBarFor } from '../tabBar';

describe('focusedNestedScreen', () => {
  it('is null for a tab with no nested navigator', () => {
    expect(focusedNestedScreen({})).toBeNull();
  });

  it('reads the focused page of a mounted stack', () => {
    expect(
      focusedNestedScreen({
        state: { index: 1, routes: [{ name: 'index' }, { name: '[groupId]/chat' }] },
      })
    ).toBe('[groupId]/chat');
  });

  it('falls back to the last page when the stack has no index yet', () => {
    expect(
      focusedNestedScreen({ state: { routes: [{ name: 'index' }, { name: 'create' }] } })
    ).toBe('create');
  });

  it('reads the target page from params before the stack mounts', () => {
    expect(focusedNestedScreen({ params: { screen: '[groupId]/chat' } })).toBe('[groupId]/chat');
  });

  it('ignores a non-string screen param', () => {
    expect(focusedNestedScreen({ params: { screen: 3 } })).toBeNull();
  });
});

describe('showTabBarFor', () => {
  it('shows on a tab with no nested pages', () => {
    expect(showTabBarFor({})).toBe(true);
  });

  it('shows on the tab root', () => {
    expect(showTabBarFor({ state: { index: 0, routes: [{ name: 'index' }] } })).toBe(true);
  });

  it('hides on a page pushed over the root', () => {
    expect(
      showTabBarFor({ state: { index: 1, routes: [{ name: 'index' }, { name: 'create' }] } })
    ).toBe(false);
  });

  // The bug this module exists for: Home's "Open chat" mounts the chat as the
  // only page in the Groups stack, at index 0.
  it('hides on a deep page that is alone in the stack at index 0', () => {
    expect(
      showTabBarFor({ state: { index: 0, routes: [{ name: '[groupId]/chat' }] } })
    ).toBe(false);
  });

  it('hides on a deep page named only in params', () => {
    expect(showTabBarFor({ params: { screen: 'create' } })).toBe(false);
  });

  it('shows when params name the root', () => {
    expect(showTabBarFor({ params: { screen: 'index' } })).toBe(true);
  });
});
