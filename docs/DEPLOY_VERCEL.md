# Deploy to Vercel at www.goxl.in/team

1. Push this repo to GitHub (private).
2. Vercel -> Add New Project -> import the repo. Framework: Other. No build command. Output directory: `.` (root).
3. Open `https://<project>.vercel.app/team` and confirm it loads.
4. Domain: Settings -> Domains -> add `www.goxl.in`. At the DNS provider add the CNAME Vercel shows.
5. **If www.goxl.in already serves the main website** from somewhere else, `/team` must be routed to this project. Options: (a) put this app on the same Vercel project as the main site under `/team`, (b) add a rewrite on the main site, `/team/:path*` -> this project's URL, or (c) use `team.goxl.in` instead.
6. Supabase -> Authentication -> URL configuration: set Site URL to `https://www.goxl.in/team` and add it to redirect URLs.
7. Auth -> disable "Confirm email" only if you want instant access; otherwise keep it on.

Netlify: same folder, publish directory `.`, and a redirect `/team /team/index.html 200`.
