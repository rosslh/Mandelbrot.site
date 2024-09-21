import { createClient } from "@supabase/supabase-js";

export const client =
  process.env.SUPABASE_PROJECT_ID && process.env.SUPABASE_ANON_KEY
    ? createClient(
        `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`,
        process.env.SUPABASE_ANON_KEY,
      )
    : null;

export let sessionId = `${Math.random()}|${Date.now()}`;
try {
  sessionId = self.crypto.randomUUID() || sessionId;
} catch (e) {
  console.warn("crypto.randomUUID() not available");
}
