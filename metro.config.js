// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro config — one line, and the app does not bundle without it.
 *
 * Metro has had `unstable_enablePackageExports` on by default since Expo
 * SDK 53, and still does on SDK 57.
 * With it on, Metro reads a package's `exports` map instead of `main`, and for
 * `@supabase/realtime-js` that resolves to the **Node** build — which does
 * `require('ws')`, and `ws` does `require('stream')`. React Native ships no
 * Node standard library, so bundling stops at:
 *
 *   Unable to resolve module stream from node_modules/ws/lib/stream.js
 *
 * Nothing in this app is at fault and no import of ours is wrong: the failure
 * is in how the resolver picks a build. `supabase-js` is pinned at `2.48.1`,
 * which shipped in the SDK 52 era, so restoring the SDK 52 resolver behaviour
 * is the change that matches the dependency rather than fighting it. Expo and
 * Supabase both point at this flag (supabase-js issue #1403).
 *
 * The alternative — bumping `supabase-js` to a release that steers Metro at a
 * browser build itself — swaps a resolver flag for a new version of the one
 * library every RPC in the project was verified against. That is the bigger
 * change of the two, and it can be made later on its own terms.
 *
 * Realtime matters here: the chat timeline subscribes to `postgres_changes`,
 * so the websocket client this pulls in is load-bearing, not dead weight that
 * could simply be excluded.
 *
 * Re-checked on the SDK 53 -> 57 upgrade by deleting the line and bundling:
 * still the same 500 out of `ws/lib/stream.js`. Do not drop it without running
 * that check again — `npm test` cannot see this, because jest-expo resolves
 * through its own preset and never reads this file.
 */
const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;

module.exports = config;
