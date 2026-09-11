/**
 * Design tokens.
 *
 * Every screen imports from here so that a spacing or colour change is one
 * edit, not twelve. The look: warm paper background, periwinkle + lime +
 * orange-red accents, Baloo 2 throughout.
 *
 * Constraints driving these choices:
 *   - Entry-level Android screens, often used in bright daylight, so contrast
 *     is generous rather than fashionable-grey. Body text is never white on
 *     lime or light periwinkle; ink (#23211A) carries text on bright fills.
 *   - Lime (accent) marks the one primary action per screen, white pills with
 *     sand borders for the rest. Orange-red (flame) is badges and danger.
 *   - Icons come from the bundled @expo/vector-icons font (Feather set).
 *     No emoji: glyphs are missing on exactly the older Android builds this
 *     app is aimed at.
 *   - Touch targets never below 44pt, since the availability grid is 28 small
 *     targets and mis-taps there are the fastest way to lose a student.
 */

export const colors = {
  /** Periwinkle: hero cards, filled surfaces, active tab. */
  primary: '#8B8BF5',
  /** Readable periwinkle for links and icons on paper. */
  primaryDark: '#5B55D6',
  primaryMuted: '#5B55D6',
  primarySoft: '#EFEFFE',
  /** Deep enough periwinkle to carry white body text (chat bubbles). */
  primaryStrong: '#6E6AE6',

  /** Lime: the primary action, selected states, done marks. */
  accent: '#C9F169',
  /** Lime-family text that stays readable on light tints. */
  accentDeep: '#567D1E',
  accentSoft: '#F3FBE2',

  /** Orange-red: badges, alerts, destructive actions. */
  flame: '#F2542D',
  flameSoft: '#FFE9E1',

  background: '#F8F4EA',
  surface: '#FFFFFF',
  surfaceAlt: '#F3EEE1',

  text: '#23211A',
  textMuted: '#8D8776',
  textInverse: '#FFFFFF',

  border: '#E8E1CE',
  borderStrong: '#D8CFB6',

  success: '#4C9A46',
  successSoft: '#E9F6DF',
  danger: '#F2542D',
  dangerSoft: '#FFE9E1',
  /** Darkened just enough that white banner text keeps AA contrast. */
  warning: '#9C6712',

  /** Offline banner: grey, noticeable without being alarming. */
  offline: '#5C574A',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 24,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 26,
  xxl: 32,
} as const;

/** Minimum tappable dimension. Do not go below this anywhere. */
export const MIN_TOUCH = 44;

/** Baloo 2, loaded once in app/_layout.tsx. Never use a raw family string. */
export const FONT = {
  regular: 'Baloo2_400Regular',
  medium: 'Baloo2_500Medium',
  semi: 'Baloo2_600SemiBold',
  bold: 'Baloo2_700Bold',
  extra: 'Baloo2_800ExtraBold',
} as const;

/** Soft card shadow: perceptible depth without GPU cost on low-end devices. */
export const shadowCard = {
  shadowColor: '#23211A',
  shadowOpacity: 0.05,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 1,
} as const;

export const typography = {
  display: {
    fontSize: 28,
    fontFamily: FONT.bold,
    color: colors.text,
  },
  title: {
    fontSize: fontSize.xl,
    fontFamily: FONT.bold,
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.md,
    fontFamily: FONT.regular,
    color: colors.textMuted,
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
    fontFamily: FONT.regular,
    color: colors.textMuted,
  },
} as const;
