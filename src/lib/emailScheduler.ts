// Hourly drip-email scheduler. For each sequence step, finds recipients whose
// row is old enough, who haven't opted out, and who haven't received that step
// yet (email_sends unique constraint makes double-sends impossible even across
// concurrent API instances), then sends via Resend.

import { adminDb } from "./supabase";
import { sendEmail, unsubscribeUrl, emailConfigured } from "./email";
import { WAITLIST_SEQUENCE, USER_SEQUENCE, type SequenceStep } from "./sequences";

const TICK_MS = 60 * 60_000; // hourly
const BATCH_PER_STEP = 25; // cap sends per step per tick (Resend rate + safety)

function dueCutoff(afterDays: number): string {
  return new Date(Date.now() - afterDays * 86_400_000).toISOString();
}

/** Claim (recipient, step) in email_sends. Returns true if we won the row. */
async function claim(recipient: string, stepId: string, userId?: string): Promise<boolean> {
  const { data, error } = await adminDb
    .from("email_sends")
    .upsert(
      { recipient, step_id: stepId, user_id: userId ?? null },
      { onConflict: "recipient,step_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) {
    console.error("email_sends claim failed:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0; // empty array → already sent previously
}

/** Returns true when a new email actually went out (row claimed + sent). */
async function sendStep(step: SequenceStep, recipient: string, userId?: string): Promise<boolean> {
  if (!(await claim(recipient, step.id, userId))) return false;
  const unsub = unsubscribeUrl(recipient);
  await sendEmail({
    to: recipient,
    subject: step.subject,
    text: step.body.replaceAll("{{unsubscribe}}", unsub),
    unsubscribe: unsub,
  });
  return true;
}

async function processWaitlist() {
  for (const step of WAITLIST_SEQUENCE) {
    const { data, error } = await adminDb
      .from("wishlist")
      .select("email")
      .eq("unsubscribed", false)
      .lte("created_at", dueCutoff(step.afterDays))
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      console.error(`Waitlist step ${step.id} query failed:`, error.message);
      continue;
    }
    let sent = 0;
    for (const row of data ?? []) {
      if (sent >= BATCH_PER_STEP) break;
      if (await sendStep(step, row.email)) sent++;
    }
  }
}

async function processUsers() {
  for (const step of USER_SEQUENCE) {
    const { data, error } = await adminDb
      .from("profiles")
      .select("id, created_at")
      .eq("marketing_emails", true)
      .lte("created_at", dueCutoff(step.afterDays))
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      console.error(`User step ${step.id} query failed:`, error.message);
      continue;
    }

    let sent = 0;
    for (const row of data ?? []) {
      if (sent >= BATCH_PER_STEP) break;
      // Skip cheaply if this step was already sent to this user.
      const { data: existing } = await adminDb
        .from("email_sends")
        .select("id")
        .eq("user_id", row.id)
        .eq("step_id", step.id)
        .limit(1);
      if (existing?.length) continue;

      // Email lives in auth.users, not profiles — fetch it per candidate.
      const { data: userData, error: userError } = await adminDb.auth.admin.getUserById(row.id);
      const email = userData?.user?.email;
      if (userError || !email) continue;

      await sendStep(step, email, row.id);
      sent++;
    }
  }
}

async function tick() {
  try {
    await processWaitlist();
    await processUsers();
  } catch (err) {
    console.error("Email scheduler tick failed:", err);
  }
}

export function startEmailScheduler() {
  if (!emailConfigured()) {
    console.log("Email scheduler disabled (RESEND_API_KEY not set)");
    return;
  }
  // First run shortly after boot, then hourly.
  setTimeout(tick, 60_000).unref();
  setInterval(tick, TICK_MS).unref();
  console.log("Email scheduler started (hourly)");
}
