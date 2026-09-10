-- Removes the send-push verification fixture and proves nothing is left.
-- The group first (messages, sessions, invitations cascade from it), then the
-- users (notifications, tokens, memberships cascade from those).
delete from public.groups where group_name = 'TT Sender Group';
delete from auth.users where email in ('tt.snd.a@example.com', 'tt.snd.b@example.com');

select 'leftover test users' as check, count(*)::text as count
  from public.users where email like 'tt.snd.%'
union all
select 'leftover groups', count(*)::text from public.groups where group_name = 'TT Sender Group'
union all
select 'leftover messages', count(*)::text from public.messages where body like 'hello from %'
union all
select 'leftover notifications', count(*)::text from public.notifications
 where title like '%TT Sender Group%' or title like '%Snd %';
