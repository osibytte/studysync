-- ============================================================================
-- StudySync — Stage 2: Group Formation
-- Migration 0006: group lifecycle sweep + activity helper
-- ----------------------------------------------------------------------------
-- Run AFTER 0005.
--
-- The spec requires the five lifecycle states to be STORED and kept current by
-- a scheduled job, never computed on read. 0004 stores `status` and
-- `last_activity_at`; 0005's membership trigger already sets `disbanded` the
-- moment a group empties. This file adds the two remaining pieces:
--
--   * touch_group_activity(group_id) — the single chokepoint that records a
--     real interaction. Stage 3+ calls it from chat / material upload / session
--     scheduling. It bumps last_activity_at and revives a dormant group.
--   * sweep_group_lifecycle() — the daily job: forming/active -> dormant after
--     14 idle days, dormant -> archived after 30 idle days.
--
-- Thresholds live in the function as named intervals so the team can tune them
-- in one place.
--
-- WHY pg_cron rather than a scheduled Edge Function: the sweep is pure SQL over
-- our own tables. Running it in-database means nothing to deploy, no secrets to
-- manage, and no network hop. A scheduled Edge Function would be a second
-- deployable carrying the service-role key purely to issue an UPDATE we can run
-- right here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- touch_group_activity — mark a group as having just had a real interaction.
--
-- SECURITY DEFINER so Stage 3+ features can call it after checking their own
-- permissions, without a groups UPDATE policy existing for clients. It only
-- ever moves a group *forward* into life:
--   * always refreshes last_activity_at (resets the dormancy clock);
--   * flips forming/dormant -> active (the "first real interaction" transition
--     the spec describes, and the revival of a dormant group);
--   * never resurrects an archived or disbanded group — those are terminal
--     until an explicit action (a future un-archive) touches them.
-- ---------------------------------------------------------------------------
create or replace function public.touch_group_activity(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.groups
    set last_activity_at = now(),
        status = case
                   when status in ('forming', 'dormant') then 'active'
                   else status
                 end
    where group_id = p_group_id
      and status not in ('archived', 'disbanded');
end;
$$;

comment on function public.touch_group_activity(uuid) is
  'Records a real interaction: bumps last_activity_at and moves forming/dormant -> active. Wired up from Stage 3 (chat/materials/sessions).';

-- ---------------------------------------------------------------------------
-- sweep_group_lifecycle — the daily aging job.
--
-- Ordering matters: age into dormant first, then age dormant into archived,
-- both measured against last_activity_at. Because the dormant pass runs after
-- the forming/active pass, a group that crossed BOTH thresholds since the last
-- sweep (e.g. cron missed a day) still lands correctly in archived rather than
-- being stranded — the newly-dormant rows are re-evaluated by the second pass.
--
-- Returns a small record of how many rows moved, so a manual
-- `select * from sweep_group_lifecycle();` during testing shows what happened.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_group_lifecycle()
returns table (newly_dormant int, newly_archived int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dormant_after  interval := interval '14 days';
  v_archive_after  interval := interval '30 days';
  v_dormant  int;
  v_archived int;
begin
  with moved as (
    update public.groups
      set status = 'dormant'
      where status in ('forming', 'active')
        and last_activity_at < now() - v_dormant_after
      returning 1
  )
  select count(*)::int into v_dormant from moved;

  with moved as (
    update public.groups
      set status = 'archived'
      where status = 'dormant'
        and last_activity_at < now() - v_archive_after
      returning 1
  )
  select count(*)::int into v_archived from moved;

  return query select v_dormant, v_archived;
end;
$$;

comment on function public.sweep_group_lifecycle() is
  'Daily: forming/active -> dormant after 14 idle days, dormant -> archived after 30. disbanded is set at leave-time by a trigger, not here.';

-- Only the scheduler (and a developer running it by hand) should invoke these;
-- neither is something a client calls.
revoke all on function public.touch_group_activity(uuid) from public, anon, authenticated;
revoke all on function public.sweep_group_lifecycle() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule the sweep with pg_cron.
--
-- pg_cron must be enabled once per project (Supabase: Dashboard -> Database ->
-- Extensions -> enable "pg_cron", or the CREATE EXTENSION below if your role
-- may create it). The block is guarded so this migration still applies cleanly
-- on a project where pg_cron is not present — it just prints a notice and skips
-- scheduling, and you can run sweep_group_lifecycle() by hand or add the cron
-- entry later.
--
-- 02:00 UTC daily: off-peak for a Nigerian (WAT, UTC+1) user base, ~03:00 local.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Replace any previous definition so re-running this migration is safe.
    perform cron.unschedule('studysync-lifecycle-sweep')
      where exists (
        select 1 from cron.job where jobname = 'studysync-lifecycle-sweep'
      );
    perform cron.schedule(
      'studysync-lifecycle-sweep',
      '0 2 * * *',
      $sweep$ select public.sweep_group_lifecycle(); $sweep$
    );
    raise notice 'Scheduled daily group lifecycle sweep (studysync-lifecycle-sweep, 02:00 UTC).';
  else
    raise notice 'pg_cron not enabled — skipping schedule. Enable it and re-run this block, or run select public.sweep_group_lifecycle(); on your own schedule.';
  end if;
end;
$$;
