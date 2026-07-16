// Day-5 trial reminder: users on a 7-day Pro trial get an email + in-app
// notification ~2 days before the trial converts, as promised on the trial
// timeline screen shown before checkout. Runs alongside startEmailScheduler().
//
// Multi-instance safe: the UPDATE … RETURNING claims rows by flipping
// trial_reminder_sent first, so two instances can never send twice.
import { adminDb } from "./supabase";
import { renderBrandedEmail, sendEmail } from "./email";
import { BILLING_ENABLED } from "./plans";
import { notifySystem } from "./notify";

const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly
const REMINDER_WINDOW_MS = 48 * 60 * 60_000; // notify when ≤ 2 days remain

function reminderEmail(displayName: string, trialEndsAt: string): { subject: string; text: string; html: string } {
  const endDate = new Date(trialEndsAt).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const subject = "Your BetterPomo Pro trial ends in 2 days";
  const text = `Hey ${displayName},

Your 7-day Pro trial wraps up on ${endDate} — and here's the good news: nothing changes. Your full history, private sessions, custom timers, and everything else you've been using stays exactly as it is. Your Pro subscription simply starts that day.

You've already built momentum this week. Keeping Pro means keeping every minute of it:

  • Your complete focus history and stats — nothing gets locked away
  • Private and password-protected sessions
  • Up to 25 people in a session, 10 custom timers
  • The full ambient sound library and your own uploads
  • Session templates and CSV exports

Pro is $4.99/month or $29.99/year (that's about $2.50/month). It's the best way to keep everything you've set up working for you.

Prefer not to continue? No hard feelings — you can cancel anytime before ${endDate} from Settings → Plan & billing, and you won't be charged.

Keep focusing,
The BetterPomo team`;
  return {
    subject,
    text,
    html: renderBrandedEmail({
      preview: `Your Pro trial wraps up on ${endDate}.`,
      eyebrow: "BetterPomo Pro",
      heading: "Your trial ends in two days",
      paragraphs: [
        `Hey ${displayName}, your seven-day Pro trial wraps up on ${endDate}. Your Pro subscription will begin that day, and everything you’ve set up will keep working exactly as it does now.`,
        "You’ve already built momentum this week. Keeping Pro means keeping every minute of it:",
      ],
      bullets: [
        "Your complete focus history and stats—nothing gets locked away.",
        "Private and password-protected sessions.",
        "Up to 25 people in a session and 10 custom timers.",
        "The full ambient sound library, uploads, session templates, and CSV exports.",
      ],
      notice: `Prefer not to continue? Cancel before ${endDate} from Settings → Plan & billing and you won’t be charged.`,
      action: { label: "Manage your plan", url: "https://app.betterpomo.com/settings" },
      signoff: "Keep focusing,\nThe BetterPomo team",
    }),
  };
}

async function sweep(): Promise<void> {
  const now = Date.now();
  // Claim-then-send: flipping the flag in the same statement that selects the
  // rows means a concurrent instance's sweep claims nothing.
  const { data, error } = await adminDb
    .from("profiles")
    .update({ trial_reminder_sent: true })
    .eq("plan_status", "trialing")
    .eq("trial_reminder_sent", false)
    .gte("trial_ends_at", new Date(now).toISOString())
    .lte("trial_ends_at", new Date(now + REMINDER_WINDOW_MS).toISOString())
    .select("id, username, display_name, trial_ends_at");

  if (error) {
    console.error("Trial reminder sweep failed:", error.message);
    return;
  }

  for (const row of (data ?? []) as { id: string; username: string; display_name: string; trial_ends_at: string }[]) {
    await notifySystem(row.id, {
      type: "trial_ending",
      entityId: null,
      metadata: { trial_ends_at: row.trial_ends_at },
    });

    const { data: authUser } = await adminDb.auth.admin.getUserById(row.id);
    const email = authUser?.user?.email;
    if (email) {
      const { subject, text, html } = reminderEmail(row.display_name ?? row.username, row.trial_ends_at);
      await sendEmail({ to: email, subject, text, html });
    }
  }

  if (data?.length) console.log(`Trial reminders sent: ${data.length}`);
}

export function startTrialReminderSweep(): void {
  // Inert while billing is disabled — the sweep queries plan columns that may
  // not exist before migration_billing.sql runs.
  if (!BILLING_ENABLED) return;
  // First pass shortly after boot (don't block startup), then hourly.
  setTimeout(() => { void sweep(); }, 30_000).unref();
  setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS).unref();
}
