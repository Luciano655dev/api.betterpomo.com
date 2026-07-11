import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Singleton service-role client used for all DB operations.
// Bypasses RLS — authorization is enforced at the application layer
// (authenticate middleware verifies the JWT; route handlers check roles).
export const adminDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Creates an anon client scoped to the user's token — used ONLY for auth.getUser(). */
export function createAuthClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

/** Creates a bare anon client — used to verify a password via signInWithPassword
 *  without touching the request's session. Never persists the resulting session. */
export function createAnonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
