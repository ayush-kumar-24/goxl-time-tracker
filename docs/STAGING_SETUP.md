# Staging setup (when GoXL's Supabase organisation exists)

Nothing here has been run on a hosted project yet. See `docs/PHASE0_RESULTS.md` for what was tested locally.

## 1. Create the project

- In the GoXL organisation, create a project named `goxl-team-hub-staging`. Region `ap-south-1` (Mumbai) is closest to the team.
- Note the Project URL and the **publishable** key. Keep the service-role key out of the repo and out of the browser.

## 2. Apply the database, in this order

1. `supabase/schema.sql`
2. every file in `supabase/migrations/`, in name order

Run them in the SQL editor, or with `psql` against the project's connection string. Do not run `supabase/tests/stubs.sql` or `supabase/local/bootstrap.sql`; those are for plain PostgreSQL only.

## 3. Sign up the Super Admin immediately

The first account to sign up becomes Super Admin, then that door closes. Do this before sharing the address with anyone.

## 4. Auth settings

- Site URL and redirect URLs: the staging address of the app.
- Keep "Confirm email" on.
- Minimum password length: 8 (the sign-up form asks for 8).
- Add a real SMTP sender before inviting the whole team; the built-in one is rate-limited.

## 5. Point the front-end at staging

Fill in `team/config.js` for the staging deployment:

```js
window.GOXL_CONFIG = { supabaseUrl: 'https://<ref>.supabase.co', supabaseKey: '<publishable key>', realtime: true };
```

Leave both values empty anywhere the demo should keep running.

## 6. Check on staging

These are the items the local run could not cover, plus a short repeat of the role checks.

- [ ] Sign-up sends a confirmation email; after confirming, the person sees "Waiting for approval".
- [ ] Super Admin approves the account; the person gets in and sees only their projects.
- [ ] Two browsers, two people, same project: a chat message and a task change appear in the other browser within a second or two (live updates).
- [ ] A member cannot see Admin or Founder dashboard, and cannot add tasks.
- [ ] Upload a PDF to a project; Open file works for a member of that project and not for someone outside it.
- [ ] Supabase dashboard, Advisors: review security and performance findings.
- [ ] Deactivate a test account; it is locked out on its next page load.

## 7. Before production

- Add a Content-Security-Policy header in `vercel.json` that allows only the app's own files and the Supabase address.
- Decide on backups and who holds the service-role key.
- Production gets its own project. Do not reuse staging.
