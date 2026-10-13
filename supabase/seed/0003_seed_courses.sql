-- ============================================================================
-- StudySync — Stage 1 seed data: courses
-- ----------------------------------------------------------------------------
-- Run AFTER 0001 and 0002.
--
-- >>> READ THIS BEFORE RUNNING <<<
--
-- These courses are PLACEHOLDERS. The course codes follow the general Nigerian
-- university convention (three-letter dept prefix + level digit), but I have
-- not seen the University of Ibadan syllabus and cannot verify any of it.
--
-- Check every row against the real course catalogue before your pilot. Matching
-- only ever compares students enrolled in the same course, so a wrong or missing
-- course code silently keeps compatible students apart.
--
-- Safe to re-run: `on conflict do nothing` throughout.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
insert into public.courses (course_code, course_title, department) values
  ('CSC 501', 'Compiler Construction',                          'Computer Science'),
  ('CSC 503', 'Artificial Intelligence',                        'Computer Science'),
  ('CSC 505', 'Computer Networks and Communications',           'Computer Science'),
  ('CSC 507', 'Advanced Database Systems',                      'Computer Science'),
  ('CSC 509', 'Computer Security',                              'Computer Science'),
  ('AGE 501', 'Farm Power and Machinery',                       'Agricultural Engineering'),
  ('AGE 503', 'Soil and Water Conservation Engineering',        'Agricultural Engineering'),
  ('AGE 505', 'Irrigation and Drainage Engineering',            'Agricultural Engineering'),
  ('AGE 507', 'Processing and Storage of Agricultural Products','Agricultural Engineering'),
  ('AGE 509', 'Agricultural Structures and Environment Control','Agricultural Engineering')
on conflict (course_code) do nothing;

-- ---------------------------------------------------------------------------
-- Sanity check — expect 10 courses (500 level, see migration 0026).
-- ---------------------------------------------------------------------------
-- select course_code, course_title, department
-- from public.courses
-- order by course_code;
