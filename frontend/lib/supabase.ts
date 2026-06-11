import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Supabase is optional. With no env configured (e.g. no admin consent yet) the
// app falls back to the manual Graph-token paste flow, so we expose `null` rather
// than calling createClient("", "") (which throws).
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const supabaseEnabled = supabase !== null;
