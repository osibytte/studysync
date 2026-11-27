# Security policy

Please do not report security issues in a public issue or discussion.

Use GitHub's private vulnerability reporting instead:

https://github.com/osibytte/studysync/security/advisories/new

Include the affected surface (Expo client, Supabase schema/RLS, or an Edge Function), reproduction steps, and the impact you believe it has. You can expect an initial response within a few days.

## Scope

- The Expo client in `app/` and `src/`
- The Supabase schema, RLS policies, and SQL functions in `supabase/migrations/`
- The Edge Functions in `supabase/functions/`

The Supabase publishable (anon) key and project URL are client-side identifiers, not secrets; they are expected to ship in the app bundle. Anything that bypasses RLS, forges another student's session, or reads data a user should not see is in scope. The `service_role` key is never part of the client and must never be committed.
