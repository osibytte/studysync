-- ---------------------------------------------------------------------------
-- 0024 — the sender's read RPCs, executable by service_role.
--
-- The send-push Edge Function runs as service_role and composes three kinds
-- from RPCs rather than re-deriving their answers: `group_sessions` (the tally
-- and threshold behind session_needs_one_yes — the same numbers the card
-- renders, which neither the client nor the sender may recompute),
-- `session_attendees` (which members have not answered) and
-- `group_common_availability` (the shared slot behind group_free_slot).
--
-- The live run found the gap: those RPCs follow the since-0005 ritual —
-- `revoke execute … from public, anon`, then grant to `authenticated` — and the
-- revoke took away the PUBLIC default that had been carrying service_role all
-- along. Bypassing RLS is not the same as holding EXECUTE, so the sender's
-- calls failed with 42501 and its error list said so.
--
-- Grants only; nothing the student side sees changes. Same forward-only,
-- idempotent shape as 0023.
-- ---------------------------------------------------------------------------
grant execute on function public.group_sessions(uuid, boolean) to service_role;
grant execute on function public.session_attendees(uuid) to service_role;
grant execute on function public.group_common_availability(uuid) to service_role;
