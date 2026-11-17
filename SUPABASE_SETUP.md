# Supabase setup for GitHub Pages

The site uses Supabase Auth for email/password accounts and stores each user's learning state in a row protected by row-level security.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase-schema.sql`](./supabase-schema.sql).
3. In **Project Settings → API**, copy the project URL and the publishable key. Put them in [`supabase-config.js`](./supabase-config.js).
   - The publishable/anon key is intended for browser use. Never put a `service_role` or secret key in this site.
4. In **Authentication → URL Configuration**, set the Site URL to the deployed GitHub Pages URL and add it as a redirect URL. Add your local development URL too if you test locally.
5. Keep email confirmation enabled for production. Users must confirm their email before their first sign-in if confirmation is enabled.
6. Publish the site and test registration, confirmation, sign-in, and progress sync.

Progress is cached in the current browser and synced to Supabase while online. Existing local profiles are matched by email at sign-in; their learning progress is offered to the signed-in Supabase account when no cloud progress exists. Any legacy local password hashes are removed from the browser's profile cache on load. The site does not upload or use those old passwords.

Supabase's free tier may pause projects after inactivity. If the project is paused, users can sign in again after it resumes; the site also keeps a local cache and offers JSON backup/restore.

See the [Supabase JavaScript installation guide](https://supabase.com/docs/reference/javascript/installing), [password authentication guide](https://supabase.com/docs/guides/auth/passwords), and [row-level security guide](https://supabase.com/docs/guides/database/postgres/row-level-security).
