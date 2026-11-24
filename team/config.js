// GoXL Team Hub connection settings.
//
// Both values empty: the page runs as the demo with sample data (nothing is saved).
// Both values filled in: the page asks people to sign in and reads and writes the real database.
//
//   supabaseUrl  Project URL, for example https://abcd1234.supabase.co
//   supabaseKey  The project's PUBLISHABLE (anon) key. It is safe in the browser: Row Level
//                Security decides what each signed-in person can do.
//                NEVER put the service-role (secret) key here.
//   realtime     true = live updates over a websocket; false = refresh every 20 seconds.
window.GOXL_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
  realtime: true
};
