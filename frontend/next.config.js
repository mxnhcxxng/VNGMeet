/** @type {import('next').NextConfig} */
const fs = require("fs");
const path = require("path");

// The project keeps a single root-level `.env` (shared with the backend). Next.js
// only auto-loads env files from the frontend/ dir, so read the root one here and
// expose the Supabase creds to the browser under their NEXT_PUBLIC_ names. Anything
// already set in the frontend env (real NEXT_PUBLIC_* or a frontend/.env.local) wins.
function readRootEnv(...keys) {
  const out = {};
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      if (!keys.includes(key)) continue;
      // Strip surrounding single/double quotes if present.
      out[key] = rawVal.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no root .env — fall back to whatever is already in process.env */
  }
  return out;
}

const root = readRootEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || root.SUPABASE_URL || "";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || root.SUPABASE_ANON_KEY || "";

const nextConfig = {
  reactStrictMode: true,
  // Hide the Next.js dev-tools badge in the corner (dev-only; never shipped to prod).
  devIndicators: false,
  env: {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  },
};

module.exports = nextConfig;
