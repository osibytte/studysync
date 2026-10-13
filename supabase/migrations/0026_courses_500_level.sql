-- ============================================================================
-- StudySync — 500-level courses: Computer Science and Agricultural Engineering
-- ----------------------------------------------------------------------------
-- Five courses per department. These are PLACEHOLDERS: plausible codes and
-- titles, not checked against the University of Ibadan catalogue. Matching only
-- compares students on the same course, so correct any code that differs from
-- what students see on their registration forms before the pilot.
--
-- Replaces the Stage 1 placeholder courses, which only ever held test data
-- (decision 2026-10-13). Deleting them takes their groups first, since
-- groups.course_id is on delete restrict; every group child (members, messages,
-- sessions, materials, invitations, join requests, notifications) cascades.
-- Enrolments cascade from the course.
--
-- Two triggers are paused for the cleanup and restored before commit:
--   user_courses_block_applied_delete  would refuse the applied test enrolments
--   group_members_on_removed           would reshuffle creators of groups being
--                                      deleted anyway
--
-- Safe to re-run: the delete keys off "not one of the new codes" and the
-- insert is `on conflict do nothing`.
-- ============================================================================

alter table public.user_courses  disable trigger user_courses_block_applied_delete;
alter table public.group_members disable trigger group_members_on_removed;

delete from public.groups g
 using public.courses c
 where g.course_id = c.course_id
   and c.course_code not in ('CSC 501','CSC 503','CSC 505','CSC 507','CSC 509',
                             'AGE 501','AGE 503','AGE 505','AGE 507','AGE 509');

delete from public.courses
 where course_code not in ('CSC 501','CSC 503','CSC 505','CSC 507','CSC 509',
                           'AGE 501','AGE 503','AGE 505','AGE 507','AGE 509');

alter table public.user_courses  enable trigger user_courses_block_applied_delete;
alter table public.group_members enable trigger group_members_on_removed;

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
