import { api } from "./api";
import { supabase } from "./supabase";

// Persisting the Microsoft refresh token to /api/auth/link is what makes the
// backend able to mint Graph tokens on its own (auth.get_graph_token). Miss it and
// the account silently behaves as "not linked" forever: bookings 401, and the
// availability job has nothing to refresh the room cache with.
//
// Supabase hands us `provider_refresh_token` on the session ONCE, right after
// OAuth, and keeps it in the stored session only until the first background token
// refresh (~1h) drops it. So a single best-effort POST is too fragile — a cold
// backend or a flaky network loses the token until the user signs in again. Two
// layers cover that:
//
//   1. `linkMicrosoft` retries with backoff right after OAuth.
//   2. `relinkFromStoredSession` re-sends it on later app loads while the backend
//      still reports graphLinked=false and Supabase still has the token.
//
// Deliberately NOT stashing the refresh token anywhere ourselves: it grants
// long-lived delegated Graph access, and an extra copy in localStorage would widen
// the XSS blast radius. Layer 2 only re-reads what Supabase already persists.

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// De-dupes concurrent attempts (the auth listener and the graphLinked effect can
// both fire for the same sign-in).
let inFlight: Promise<boolean> | null = null;

/** POST the Microsoft refresh token to the backend, retrying transient failures.
 *  Resolves true once stored. Never throws. */
export function linkMicrosoft(
  refreshToken: string,
  accessToken?: string | null,
): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await api.link(refreshToken, accessToken);
        return true;
      } catch (e: any) {
        // 400 = empty token, 401 = our own bearer was rejected. Neither gets
        // better by retrying with the same inputs.
        const fatal =
          e?.message === "UNAUTHENTICATED" || /rỗng|empty/i.test(String(e?.message));
        if (fatal || attempt === MAX_ATTEMPTS) {
          console.warn(
            `[linkMicrosoft] giving up after ${attempt} attempt(s):`,
            e?.message ?? e,
          );
          return false;
        }
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1)); // 0.8s, 1.6s, 3.2s
      }
    }
    return false;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Safety net for a link that never landed: re-send the refresh token straight
 *  from the stored Supabase session. Resolves true only when it just succeeded,
 *  so the caller knows to re-fetch /api/auth/me. Call this OUTSIDE the
 *  `onAuthStateChange` callback — it touches the Supabase auth client. */
export async function relinkFromStoredSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  const refreshToken = data.session?.provider_refresh_token;
  if (!refreshToken) return false; // already dropped by a session refresh
  return linkMicrosoft(refreshToken, data.session?.provider_token);
}
