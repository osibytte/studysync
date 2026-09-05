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
  ('CSC 201', 'Computer Programming I',        'Computer Science'),
  ('CSC 203', 'Discrete Structures',           'Computer Science'),
  ('CSC 301', 'Data Structures and Algorithms','Computer Science'),
  ('MTH 201', 'Mathematical Methods I',        'Mathematics'),
  ('MTH 241', 'Linear Algebra',                'Mathematics'),
  ('ECO 201', 'Microeconomic Theory I',        'Economics'),
  ('ECO 203', 'Macroeconomic Theory I',        'Economics'),
  ('PHY 201', 'Classical Mechanics',           'Physics'),
  ('CHM 201', 'Physical Chemistry I',          'Chemistry'),
  ('BIO 201', 'General Physiology',            'Biology')
on conflict (course_code) do nothing;

-- ---------------------------------------------------------------------------
-- Sanity check — expect 10 courses.
-- ---------------------------------------------------------------------------
-- select course_code, course_title, department
-- from public.courses
-- order by course_code;
