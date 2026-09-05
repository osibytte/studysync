import {
  checkProfileCompleteness,
  validateDepartment,
  validateEmail,
  validateFullName,
  validatePassword,
  validatePasswordConfirm,
} from '../validation';

describe('validateEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(validateEmail('student@ui.edu.ng')).toBeNull();
    expect(validateEmail('a.b+tag@example.co.uk')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    // Mobile keyboards add a trailing space more often than not.
    expect(validateEmail('  student@ui.edu.ng  ')).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(validateEmail('')).toBe('Email is required');
    expect(validateEmail('   ')).toBe('Email is required');
    expect(validateEmail('nope')).toMatch(/valid email/);
    expect(validateEmail('no@domain')).toMatch(/valid email/);
    expect(validateEmail('@example.com')).toMatch(/valid email/);
    expect(validateEmail('two@@example.com')).toMatch(/valid email/);
  });
});

describe('validatePassword', () => {
  it('accepts six characters or more', () => {
    expect(validatePassword('abcdef')).toBeNull();
    expect(validatePassword('a longer passphrase')).toBeNull();
  });

  it('rejects short or missing passwords', () => {
    expect(validatePassword('')).toBe('Password is required');
    expect(validatePassword('abc')).toMatch(/at least 6/);
  });

  it('does not impose complexity rules', () => {
    // Deliberate: complexity rules push people toward predictable patterns or
    // writing passwords down, and this is a study app, not a bank.
    expect(validatePassword('aaaaaa')).toBeNull();
    expect(validatePassword('123456')).toBeNull();
  });
});

describe('validatePasswordConfirm', () => {
  it('accepts a match', () => {
    expect(validatePasswordConfirm('abcdef', 'abcdef')).toBeNull();
  });

  it('rejects a mismatch or a blank confirmation', () => {
    expect(validatePasswordConfirm('abcdef', '')).toMatch(/confirm/);
    expect(validatePasswordConfirm('abcdef', 'abcdeg')).toMatch(/do not match/);
  });

  it('is case sensitive', () => {
    expect(validatePasswordConfirm('Abcdef', 'abcdef')).toMatch(/do not match/);
  });
});

describe('validateFullName', () => {
  it('accepts real names', () => {
    expect(validateFullName('Adebayo Okonkwo')).toBeNull();
    expect(validateFullName('Ng')).toBeNull(); // two characters is legitimate
  });

  it('rejects blank or single-character input', () => {
    expect(validateFullName('')).toBe('Your name is required');
    expect(validateFullName('   ')).toBe('Your name is required');
    expect(validateFullName('A')).toMatch(/full name/);
  });

  it('rejects absurdly long input', () => {
    expect(validateFullName('a'.repeat(81))).toMatch(/too long/);
  });
});

describe('validateDepartment', () => {
  it('accepts a department name', () => {
    expect(validateDepartment('Computer Science')).toBeNull();
  });

  it('rejects blank input', () => {
    expect(validateDepartment('')).toBe('Department is required');
    expect(validateDepartment('  ')).toBe('Department is required');
  });

  it('rejects over-long input', () => {
    expect(validateDepartment('x'.repeat(81))).toMatch(/too long/);
  });
});

describe('checkProfileCompleteness', () => {
  const complete = {
    fullName: 'Adebayo Okonkwo',
    department: 'Computer Science',
    courseCount: 2,
    availabilitySlots: 6,
  };

  it('passes a fully filled profile', () => {
    const result = checkProfileCompleteness(complete);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('flags each missing piece by name', () => {
    const result = checkProfileCompleteness({
      fullName: null,
      department: null,
      courseCount: 0,
      availabilitySlots: 0,
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([
      'your name',
      'your department',
      'at least one course',
      'your weekly availability',
    ]);
  });

  it('treats whitespace-only values as missing', () => {
    const result = checkProfileCompleteness({ ...complete, fullName: '   ', department: '  ' });
    expect(result.hasName).toBe(false);
    expect(result.hasDepartment).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('requires at least one course', () => {
    // Course is the hard filter in matching — with none, nothing can match.
    const result = checkProfileCompleteness({ ...complete, courseCount: 0 });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('at least one course');
  });

  it('requires at least one availability slot', () => {
    const result = checkProfileCompleteness({ ...complete, availabilitySlots: 0 });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('your weekly availability');
  });
});
