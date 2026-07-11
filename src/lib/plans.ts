// Single source of truth for paid-plan entitlements (Free / Pro / Lifetime).
//
// The profiles row carries the billing state (written only by billing webhooks);
// everything else derives from getEntitlements(). Route handlers never read
// plan columns directly — they call getUserEntitlements() and compare against
// the limits here, so a pricing change is a one-file edit.
import type { Response } from "express";
import { cache, TTL } from "./cache";
import { adminDb } from "./supabase";

/** Master kill switch for the paid-plans system. Off (default) = pre-billing
 *  behavior: every gate passes with the legacy limits below, no badges, no
 *  plan columns are read (so the API runs against a DB without the billing
 *  migration), and the billing routes answer 503. Set BILLING_ENABLED=true
 *  (plus the frontend NEXT_PUBLIC_/EXPO_PUBLIC_ equivalents) to activate. */
export const BILLING_ENABLED = process.env.BILLING_ENABLED === "true";

export type Plan = "free" | "pro" | "lifetime";
export type PlanStatus = "none" | "trialing" | "active" | "past_due" | "canceled";

/** The billing columns entitlement checks need. */
export interface PlanRow {
  plan: Plan;
  plan_status: PlanStatus;
  plan_period_end: string | null;
  trial_ends_at: string | null;
}

export const PLAN_COLUMNS =
  "plan, plan_status, plan_provider, plan_period_end, cancel_at_period_end, trial_ends_at, trial_used";

export interface Entitlements {
  isPro: boolean;
  badge: "pro" | "lifetime" | null;
  maxTimers: number;
  maxParticipants: number;
  maxGroupMembers: number; // including the actor
  maxTasks: number;
  historyDays: number | null; // null = unlimited
  privateSessions: boolean;
  customSounds: boolean;
  templates: boolean;
  analytics: boolean; // custom date ranges + CSV export
}

/** Absolute ceiling enforced in SQL (join_pomo_session / accept_session_invite)
 *  as a race-safety backstop; per-plan caps below must never exceed it. */
export const PARTICIPANTS_HARD_CAP = 25;
/** Absolute per-session timer ceiling (kept from the pre-plans era). */
export const TIMERS_HARD_CAP = 10;

// maxTimers counts ALL timers in a session. New sessions start with 6 defaults
// (create_pomo_session RPC), so free users customize by replacing defaults;
// Pro adds headroom for extra cycles.
const FREE: Omit<Entitlements, "isPro" | "badge"> = {
  maxTimers: 6,
  maxParticipants: 5,
  maxGroupMembers: 3,
  maxTasks: 10,
  historyDays: 30,
  privateSessions: false,
  customSounds: false,
  templates: false,
  analytics: false,
};

const PRO: Omit<Entitlements, "isPro" | "badge"> = {
  maxTimers: TIMERS_HARD_CAP,
  maxParticipants: PARTICIPANTS_HARD_CAP,
  maxGroupMembers: 25,
  maxTasks: 50,
  historyDays: null,
  privateSessions: true,
  customSounds: true,
  templates: true,
  analytics: true,
};

/** Entitlements when billing is DISABLED — the app as it was before paid
 *  plans: old hard caps (10 timers, 10 participants via the legacy RPC, 50
 *  tasks), everything else unrestricted, no badges. Templates stay off (they
 *  shipped with the paid tier and shouldn't appear until it launches);
 *  analytics stays on so no stats tab ever shows a lock. */
const LEGACY_UNLOCKED: Entitlements = {
  isPro: false,
  badge: null,
  maxTimers: TIMERS_HARD_CAP,
  maxParticipants: 10,
  maxGroupMembers: 1000,
  maxTasks: 50,
  historyDays: null,
  privateSessions: true,
  customSounds: true,
  templates: false,
  analytics: true,
};

/** Pure derivation of entitlements from billing columns.
 *  - lifetime is permanent and never downgraded by subscription state
 *  - pro requires an active or trialing subscription
 *  - past_due keeps entitlements until plan_period_end (Stripe retry grace) */
export function getEntitlements(row: Partial<PlanRow> | null | undefined): Entitlements {
  if (!BILLING_ENABLED) return LEGACY_UNLOCKED;
  const plan = row?.plan ?? "free";
  const status = row?.plan_status ?? "none";
  const periodEnd = row?.plan_period_end ? Date.parse(row.plan_period_end) : null;

  const entitled =
    plan === "lifetime" ||
    (plan === "pro" &&
      (status === "trialing" ||
        status === "active" ||
        (status === "past_due" && periodEnd !== null && periodEnd > Date.now())));

  if (!entitled) return { isPro: false, badge: null, ...FREE };
  return { isPro: true, badge: plan === "lifetime" ? "lifetime" : "pro", ...PRO };
}

/** Cached lookup of a user's entitlements. Cheap enough for every gated request:
 *  one cache hit in the common case, one 4-column select on miss. Invalidate
 *  `plan:{userId}` on every plan change (see applyPlanChange in routes/billing.ts). */
export async function getUserEntitlements(userId: string): Promise<Entitlements> {
  if (!BILLING_ENABLED) return LEGACY_UNLOCKED; // no DB read — plan columns may not exist yet
  const cacheKey = `plan:${userId}`;
  const hit = cache.get<PlanRow>(cacheKey);
  if (hit) return getEntitlements(hit);

  const { data } = await adminDb
    .from("profiles")
    .select("plan, plan_status, plan_period_end, trial_ends_at")
    .eq("id", userId)
    .maybeSingle();

  const row = (data ?? {
    plan: "free",
    plan_status: "none",
    plan_period_end: null,
    trial_ends_at: null,
  }) as PlanRow;
  cache.set(cacheKey, row, TTL.PLAN);
  return getEntitlements(row);
}

/** Standard machine-readable "you need to upgrade" response. Frontends key
 *  their paywall modals off `error === "upgrade_required"`. */
export function upgradeRequired(res: Response, feature: string): void {
  res.status(403).json({ error: "upgrade_required", feature, plan_needed: "pro" });
}
