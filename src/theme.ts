/**
 * Design tokens.
 *
 * Deliberately small and flat. Every screen imports from here so that a
 * spacing or colour change is one edit, not twelve.
 *
 * Constraints driving these choices:
 *   - Entry-level Android screens, often used in bright daylight, so contrast
 *     is generous rather than fashionable-grey.
 *   - No images, gradients, or shadows-heavy styling: the data-usage rule bans
 *     decorative media, and heavy shadows cost frames on low-end GPUs.
 *   - Touch targets never below 44pt, since the availability grid is 28 small
 *     targets and mis-taps there are the fastest way to lose a student.
 */

export const colors = {
  /** Deep navy — headers, primary buttons. Reads as "study", not "social". */
  primary: '#12263A',
  primaryMuted: '#2E4A66',
  /** Warm amber accent for selected states. High contrast on both bg + navy. */
  accent: '#E8A33D',
  accentSoft: '#FDF1DC',

  background: '#FFFFFF',
  surface: '#F6F7F9',
  surfaceAlt: '#EDEFF3',

  text: '#12263A',
  textMuted: '#5B6B7C',
  textInverse: '#FFFFFF',

  border: '#D5DBE2',
  borderStrong: '#9FAAB7',

  success: '#1E7A44',
  danger: '#C0392B',
  warning: '#B7791F',

  /** Offline banner — noticeable without being alarming. */
  offline: '#5B6B7C',
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
  sm: 6,
  md: 10,
  lg: 16,
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

export const typography = {
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700' as const,
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.md,
    fontWeight: '400' as const,
    color: colors.textMuted,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '600' as const,
    color: colors.text,
  },
  body: {
    fontSize: fontSize.md,
    fontWeight: '400' as const,
    color: colors.text,
  },
  caption: {
    fontSize: fontSize.xs,
    fontWeight: '400' as const,
    color: colors.textMuted,
  },
} as const;
