/**
 * Form validation.
 *
 * Pure functions returning either null (valid) or a student-facing message.
 * Kept out of the screens so they can be unit tested without rendering, and
 * so the same rule is not written slightly differently on signup and profile.
 *
 * These are convenience checks, not a security boundary. Postgres constraints
 * and RLS are what actually protect the data; this only saves a round trip and
 * gives a better error than the database would.
 */

/**
 * Deliberately permissive email check: something before an @, something after,
 * and a dot in the domain.
 *
 * Strict RFC-compliant regexes reject valid addresses and are a classic way to
 * lock real users out. Supabase sends a confirmation email anyway, which is
 * the only check that actually proves an address works.
 */
export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Enter a valid email address';
  }
  return null;
}

/**
 * Six characters, matching Supabase Auth's own default minimum.
 *
 * No complexity rules (uppercase, symbols, etc.) on purpose: they push people
 * toward one predictable pattern or toward writing the password down, and the
 * threat model here is a student study app, not a bank.
 */
export function validatePassword(password: string): string | null {
  if (!password) return 'Password is required';
  if (password.length < 6) return 'Password must be at least 6 characters';
  return null;
}

export function validatePasswordConfirm(
  password: string,
  confirm: string
): string | null {
  if (!confirm) return 'Please confirm your password';
  if (password !== confirm) return 'Passwords do not match';
  return null;
}

export function validateFullName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Your name is required';
  if (trimmed.length < 2) return 'Enter your full name';
  if (trimmed.length > 80) return 'Name is too long';
  return null;
}

export function validateDepartment(department: string): string | null {
  const trimmed = department.trim();
  if (!trimmed) return 'Department is required';
  if (trimmed.length > 80) return 'Department name is too long';
  return null;
}

/** Profile is complete enough to leave onboarding. */
export interface ProfileCompleteness {
  hasName: boolean;
  hasDepartment: boolean;
  hasCourse: boolean;
  hasAvailability: boolean;
  complete: boolean;
  /** What's still missing, for the onboarding progress hint. */
  missing: string[];
}

/**
 * Completeness gate for leaving onboarding: name, department, at least one
 * course, and some availability. Matching is by course + availability, and both
 * are required here so a new profile is actually matchable the moment it lands.
 */
export function checkProfileCompleteness(input: {
  fullName: string | null;
  department: string | null;
  courseCount: number;
  availabilitySlots: number;
}): ProfileCompleteness {
  const hasName = !!input.fullName && input.fullName.trim().length >= 2;
  const hasDepartment = !!input.department && input.department.trim().length > 0;
  const hasCourse = input.courseCount > 0;
  const hasAvailability = input.availabilitySlots > 0;

  const missing: string[] = [];
  if (!hasName) missing.push('your name');
  if (!hasDepartment) missing.push('your department');
  if (!hasCourse) missing.push('at least one course');
  if (!hasAvailability) missing.push('your weekly availability');

  return {
    hasName,
    hasDepartment,
    hasCourse,
    hasAvailability,
    complete: hasName && hasDepartment && hasCourse && hasAvailability,
    missing,
  };
}
