# Work Intelligence Engine (in the Hub)

Ported from the reference `goxl-work-intelligence-engine` zip into `team/index.html`:
- **Daily log** (`views.log`): tasks done, hours, blockers, summary. "Fill from timer" pre-fills from tracked time.
- **Founder dashboard** (`views.founder`): team summary, contributor view, dependency view, distribution, alerts.
- **Executive summary:** rule-based (`localSummary`). The reference called the Claude API from its server; to restore that, add a Supabase Edge Function holding the API key and call it from the dashboard button.
- Branding follows the GoXL guide: forest `#1B4332`, lime `#C8E600`, Montserrat + IBM Plex Mono.
