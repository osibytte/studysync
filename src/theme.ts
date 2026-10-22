/**
 * Design tokens.
 *
 * Every screen imports from here so that a spacing or colour change is one
 * edit, not twelve. The look ("Green & Ink", see design-preview/): a deep
 * green brand band at the top of the tab screens, content on a soft canvas in
 * separate white cards, near-black pill buttons, a floating tab bar, League
 * Spartan headings over Montserrat text.
 *
 * Constraints driving these choices:
 *   - Entry-level Android screens, often used in bright daylight, so contrast
 *     is generous rather than fashionable-grey. Every text colour here is at
 *     least 4.5:1 on white; white text sits only on ink or green-700 and
 *     darker.
 *   - Ink (accent) marks actions and selected states. Green (primary) is the
 *     brand: header bands, switches, availability, active status. Red (flame)
 *     is badges and danger.
 *   - Icons come from the bundled @expo/vector-icons font (Feather set).
 *     No emoji: glyphs are missing on exactly the older Android builds this
 *     app is aimed at.
 *   - Touch targets never below 44pt, since the availability grid is 28 small
 *     targets and mis-taps there are the fastest way to lose a student.
 *
 * The key names predate this palette and are kept so screens did not all have
 * to change at once: `accent` is now ink, `primary` is now green.
 */

export const colors = {
  /** Green: the brand. Header bands, switches, availability, step bars. */
  primary: '#1C6440',
  /** Green readable as text and icons on white (6.9:1). */
  primaryDark: '#1C6440',
  primaryMuted: '#23794E',
  /** Pale green for selected rows and soft fills. */
  primarySoft: '#E2F0E7',
  /** My own chat bubbles: ink, white text. */
  primaryStrong: '#17191A',

  /** The band behind tab-screen headers, top and bottom of its gradient. */
  bandTop: '#1C6440',
  bandBottom: '#0F3B26',
  /** Text and controls that sit on the band. */
  onBand: '#FFFFFF',
  onBandMuted: 'rgba(255,255,255,0.78)',
  bandGlass: 'rgba(255,255,255,0.14)',
  /** Light green that reads on the band: free slots, small highlights. */
  bandHighlight: '#A6E3B8',

  /** Ink: primary buttons, selected chips, the tab bar. Text on it is white. */
  accent: '#17191A',
  accentDeep: '#1C6440',
  accentSoft: '#F5F6F4',

  /** Red: badges, alerts, destructive actions. */
  flame: '#D93A3F',
  flameSoft: '#FDECEC',

  background: '#EEF0ED',
  surface: '#FFFFFF',
  surfaceAlt: '#F5F6F4',

  text: '#17191A',
  /** Secondary lines: hints, timestamps, captions (5.0:1 on white). */
  textMuted: '#6C716C',
  /** Body copy a step below the title (8.3:1 on white). */
  textSecondary: '#4B504C',
  textInverse: '#FFFFFF',

  border: '#E3E6E1',
  borderStrong: '#CDD2CB',

  /** Status fills; each carries white text. */
  success: '#1E7A4C',
  successSoft: '#E2F0E7',
  info: '#2457D6',
  danger: '#D93A3F',
  dangerSoft: '#FDECEC',
  warning: '#B45309',

  /** Offline banner: grey, noticeable without being alarming. */
  offline: '#4B504C',
} as const;

/**
 * Soft tile and avatar fills, one per group or person. Pick with
 * `tintFor(id)` so the same group always gets the same colour.
 */
export const tints = [
  { bg: '#DCEFE3', fg: '#145232' },
  { bg: '#FDE8D7', fg: '#8A3A0B' },
  { bg: '#DDE8FB', fg: '#1B44A8' },
  { bg: '#F6E0EC', fg: '#8B1F55' },
  { bg: '#EDE6D6', fg: '#5F4614' },
  { bg: '#E6E3F7', fg: '#4A31A6' },
] as const;

export function tintFor(key: string | null | undefined) {
  const s = key ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return tints[Math.abs(h) % tints.length];
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 15,
  lg: 19,
  xl: 26,
  xxl: 30,
} as const;

/** Minimum tappable dimension. Do not go below this anywhere. */
export const MIN_TOUCH = 44;

/**
 * Two faces, loaded once in app/_layout.tsx. Never use a raw family string.
 *
 * Montserrat carries everything you read: body, labels, buttons, hints
 * (regular, medium, semi). The heavy weights (bold, extra) are the heading
 * face, League Spartan: titles, names, section heads, the big numbers. A
 * geometric face in Nexa's tradition (round O, flat terminals), compact enough
 * that a group name fits on a small screen, and uncommon enough not to read as
 * a template. Nexa itself is licensed and not in the repo; if it is ever
 * bought, it replaces this block (see HANDOFF.md §13).
 */
const HEADING = {
  bold: 'LeagueSpartan_700Bold',
  extra: 'LeagueSpartan_800ExtraBold',
} as const;

export const FONT = {
  regular: 'Montserrat_400Regular',
  medium: 'Montserrat_500Medium',
  semi: 'Montserrat_600SemiBold',
  bold: HEADING.bold,
  extra: HEADING.extra,
} as const;

/** Soft card shadow: perceptible depth without GPU cost on low-end devices. */
export const shadowCard = {
  shadowColor: '#17191A',
  shadowOpacity: 0.06,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 1,
} as const;

/** Lifted elements: the floating tab bar, pinned actions, feature cards. */
export const shadowFloat = {
  shadowColor: '#17191A',
  shadowOpacity: 0.22,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 10 },
  elevation: 8,
} as const;

/** Room to leave under scrolling content so the floating tab bar never covers it. */
export const TAB_BAR_CLEARANCE = 112;

export const typography = {
  display: {
    fontSize: 32,
    fontFamily: FONT.extra,
    color: colors.text,
    letterSpacing: -0.4,
  },
  title: {
    fontSize: fontSize.xl + 1,
    fontFamily: FONT.bold,
    color: colors.text,
    letterSpacing: -0.2,
  },
  section: {
    fontSize: fontSize.lg + 1,
    fontFamily: FONT.bold,
    color: colors.text,
    letterSpacing: 0,
  },
  subtitle: {
    fontSize: fontSize.md,
    fontFamily: FONT.regular,
    color: colors.textSecondary,
  },
  label: {
    fontSize: fontSize.sm,
    fontFamily: FONT.semi,
    color: colors.text,
  },
  body: {
    fontSize: fontSize.md,
    fontFamily: FONT.regular,
    color: colors.text,
  },
  caption: {
    fontSize: fontSize.xs,
    fontFamily: FONT.medium,
    color: colors.textMuted,
  },
} as const;
