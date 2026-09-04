-- ============================================================================
-- StudySync — table privilege grants (Stage 1 + Stage 2)
-- ----------------------------------------------------------------------------
-- Migrations 0001–0007 enable RLS and define policies (all `to authenticated`),
-- but define no table-level GRANTs. They relied on Supabase's default privileges
-- to supply the base SELECT/INSERT/UPDATE/DELETE that Postgres checks BEFORE RLS
-- runs. On this project those defaults granted only REFERENCES/TRIGGER/TRUNCATE,
-- so every role (anon, authenticated, service_role) was denied at the privilege
-- check before RLS ever applied — the app hit "permission denied for table ..."
-- on every query, even when signed in.
--
-- This migration restores the grants the schema assumed. RLS stays the security
-- gate: a table whose only policy is SELECT still rejects INSERT/UPDATE/DELETE,
-- because RLS default-denies any command without a permissive policy. So broad
-- DML grants here grant exactly the access the policies already define.
--
--   * authenticated — the app's signed-in users. Direct SELECT everywhere;
--     direct DML on the Stage 1 tables they own (user_courses, user_course_topics,
--     users). Stage 2 writes still flow through the SECURITY DEFINER RPCs, which
--     RLS forces because those tables carry only SELECT policies.
--   * service_role  — the Edge Functions (find-group, run-batch-matching) read
--     tables directly. BYPASSRLS skips RLS but NOT the table privilege check, so
--     service_role needs these grants too. The SECURITY DEFINER RPCs run as their
--     owner and are unaffected either way.
--
-- Idempotent: GRANT is a no-op when the privilege is already held. `in schema
-- public` covers only this project's tables — Supabase's own objects live in the
-- auth/storage/etc. schemas, not public.
-- ============================================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;

grant usage, select on all sequences in schema public
  to authenticated, service_role;

-- Future Stage 3–5 tables created in this schema inherit the same base grants,
-- so a later migration never reintroduces this gap. (No-op if a future migration
-- runs under a different creating role; such a migration should grant explicitly.)
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
