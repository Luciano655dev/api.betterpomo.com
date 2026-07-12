// Billing: Stripe (web) + RevenueCat (mobile IAP). The profiles row is the
// single source of truth for plan state; only the webhook handlers here write
// it. Clients read GET /api/billing (or /api/profile) and start purchases via
// /checkout (web) or the native store (mobile) — never by writing plan state.
import { Router, type Request, type Response } from "express";
import type Stripe from "stripe";
import { authenticate } from "../middleware/auth";
import { perUserLimiter } from "../middleware/rateLimit";
import { cache, TTL } from "../lib/cache";
import { adminDb } from "../lib/supabase";
import { serverError } from "../lib/http";
import {
  BILLING_ENABLED,
  getEntitlements,
  PLAN_COLUMNS,
  type Plan,
  type PlanStatus,
} from "../lib/plans";
import {
  stripe,
  PRICE_IDS,
  isCheckoutPlan,
  priceToPlan,
  subscriptionPeriodEnd,
} from "../lib/stripe";

const router = Router();

// Stripe checkout success/cancel redirects land back in the web app. Default to
// production (app.betterpomo.com) so a missing env var never redirects a real
// customer to localhost; override with WEBAPP_URL=http://localhost:3000 in dev.
const WEBAPP_URL = process.env.WEBAPP_URL ?? "https://app.betterpomo.com";
const TRIAL_DAYS = 7;

interface BillingRow {
  plan: Plan;
  plan_status: PlanStatus;
  plan_provider: "stripe" | "apple" | "google" | null;
  plan_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
  trial_used: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  revenuecat_app_user_id: string | null;
}

const BILLING_COLUMNS = `${PLAN_COLUMNS}, stripe_customer_id, stripe_subscription_id, revenuecat_app_user_id`;

async function getBillingRow(userId: string): Promise<BillingRow | null> {
  const { data } = await adminDb
    .from("profiles")
    .select(BILLING_COLUMNS)
    .eq("id", userId)
    .maybeSingle();
  return (data as BillingRow | null) ?? null;
}

/** Every plan write goes through here so cache invalidation can't be forgotten.
 *  Drops the caches whose contents depend on the user's plan: their profile
 *  (carries entitlements), the entitlement row itself, their history (30-day
 *  free window), and public views of them (badge, public history window). */
async function applyPlanChange(userId: string, patch: Partial<BillingRow>): Promise<void> {
  const { error } = await adminDb.from("profiles").update(patch).eq("id", userId);
  if (error) {
    console.error(`Plan update failed for ${userId}:`, error.message);
    return;
  }
  cache.del(`profile:${userId}`);
  cache.del(`plan:${userId}`);
  cache.del(`billing:${userId}`);
  cache.delByPrefix(`history:${userId}:`);
  cache.del(`history-summary:${userId}`);
  cache.delByPrefix("user:");
  cache.delByPrefix("user-hist:");
}

/** Webhook idempotency: record the provider event id; returns false when the
 *  event was already processed (duplicate delivery → skip). */
async function recordBillingEvent(
  provider: "stripe" | "revenuecat",
  eventId: string,
  eventType: string,
  userId: string | null,
  payload: unknown,
): Promise<boolean> {
  const { error } = await adminDb.from("billing_events").insert({
    event_id: eventId,
    provider,
    event_type: eventType,
    user_id: userId,
    payload,
  });
  if (error?.code === "23505") return false; // duplicate delivery
  if (error) console.error("billing_events insert failed:", error.message);
  return true;
}

async function findUserByStripeCustomer(customerId: string): Promise<string | null> {
  const { data } = await adminDb
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** GET /api/billing — current plan + entitlements for the signed-in user. */
router.get("/", authenticate, async (req, res) => {
  const { user } = req;

  // Billing disabled: static everything-unlocked payload with no DB read
  // (the plan columns may not exist yet). Frontends see no locks, no badges.
  if (!BILLING_ENABLED) {
    res.json({
      data: {
        plan: "free",
        plan_status: "none",
        plan_provider: null,
        plan_period_end: null,
        cancel_at_period_end: false,
        trial_ends_at: null,
        trial_used: false,
        entitlements: getEntitlements(null),
      },
    });
    return;
  }

  const cacheKey = `billing:${user.id}`;
  const hit = cache.get(cacheKey);
  if (hit) { res.json({ data: hit }); return; }

  const row = await getBillingRow(user.id);
  if (!row) { res.status(404).json({ error: "Profile not found" }); return; }

  const data = {
    plan: row.plan,
    plan_status: row.plan_status,
    plan_provider: row.plan_provider,
    plan_period_end: row.plan_period_end,
    cancel_at_period_end: row.cancel_at_period_end,
    trial_ends_at: row.trial_ends_at,
    trial_used: row.trial_used,
    entitlements: getEntitlements(row),
  };
  cache.set(cacheKey, data, TTL.BILLING);
  res.json({ data });
});

const checkoutLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  limit: 10,
  message: "Too many checkout attempts, please try again later.",
  name: "billing-checkout",
});

/** POST /api/billing/checkout — body { plan: "pro_monthly" | "pro_yearly" | "lifetime" }.
 *  Returns a Stripe Checkout URL. Pro gets a 7-day free trial on the first
 *  subscription only (trial_used flips in the webhook). */
router.post("/checkout", authenticate, checkoutLimiter, async (req, res) => {
  if (!BILLING_ENABLED || !stripe) { res.status(503).json({ error: "Billing is not enabled" }); return; }
  const { user } = req;
  const plan = req.body?.plan;
  if (!isCheckoutPlan(plan)) {
    res.status(400).json({ error: "plan must be pro_monthly, pro_yearly, or lifetime" });
    return;
  }
  const price = PRICE_IDS[plan];
  if (!price) { res.status(503).json({ error: "Billing is not configured" }); return; }

  const row = await getBillingRow(user.id);
  if (!row) { res.status(404).json({ error: "Profile not found" }); return; }
  if (row.plan === "lifetime") {
    res.status(400).json({ error: "already_lifetime" }); return;
  }
  const hasActiveSubscription =
    row.plan_provider === "stripe" &&
    !!row.stripe_subscription_id &&
    (row.plan_status === "active" || row.plan_status === "trialing" || row.plan_status === "past_due");
  if (plan !== "lifetime" && hasActiveSubscription) {
    // Manage/switch the existing subscription through the portal instead.
    res.status(400).json({ error: "already_subscribed" }); return;
  }
  if ((row.plan_status === "active" || row.plan_status === "trialing") && row.plan_provider !== "stripe" && row.plan_provider !== null) {
    // Subscribed through the App Store / Play — can't double-bill via Stripe.
    res.status(400).json({ error: "subscribed_via_store" }); return;
  }

  try {
    let customerId = row.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await adminDb.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${WEBAPP_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${WEBAPP_URL}/upgrade`,
      ...(plan === "lifetime"
        ? { mode: "payment" as const, metadata: { user_id: user.id } }
        : {
            mode: "subscription" as const,
            subscription_data: {
              metadata: { user_id: user.id },
              ...(row.trial_used ? {} : { trial_period_days: TRIAL_DAYS }),
            },
          }),
    });

    res.json({ data: { url: session.url } });
  } catch (e) {
    serverError(res, e as Error);
  }
});

/** POST /api/billing/portal — Stripe Customer Portal for subscription management. */
router.post("/portal", authenticate, async (req, res) => {
  if (!BILLING_ENABLED || !stripe) { res.status(503).json({ error: "Billing is not enabled" }); return; }
  const { user } = req;
  const row = await getBillingRow(user.id);
  if (!row?.stripe_customer_id) {
    res.status(400).json({ error: "No billing account. Subscribe first." }); return;
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${WEBAPP_URL}/settings`,
    });
    res.json({ data: { url: session.url } });
  } catch (e) {
    serverError(res, e as Error);
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
// Mounted separately in src/index.ts with express.raw() BEFORE the global JSON
// parser — signature verification needs the untouched request body.

function mapStripeStatus(s: Stripe.Subscription.Status): PlanStatus | null {
  switch (s) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    case "canceled":
    case "incomplete_expired": return "canceled";
    default: return null; // incomplete / paused — wait for a definitive event
  }
}

async function handleSubscriptionEvent(sub: Stripe.Subscription): Promise<void> {
  const userId =
    (sub.metadata?.user_id as string | undefined) ??
    (typeof sub.customer === "string" ? await findUserByStripeCustomer(sub.customer) : null);
  if (!userId) { console.error(`Stripe subscription ${sub.id}: no user mapping`); return; }

  const current = await getBillingRow(userId);
  if (current?.plan === "lifetime") return; // lifetime is never downgraded

  const status = mapStripeStatus(sub.status);
  if (!status) return;

  if (status === "canceled") {
    await applyPlanChange(userId, {
      plan: "free",
      plan_status: "canceled",
      plan_provider: null,
      plan_period_end: null,
      cancel_at_period_end: false,
      stripe_subscription_id: null,
    });
    return;
  }

  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  await applyPlanChange(userId, {
    plan: priceToPlan(sub.items?.data?.[0]?.price?.id) ?? "pro",
    plan_status: status,
    plan_provider: "stripe",
    plan_period_end: subscriptionPeriodEnd(sub),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    stripe_subscription_id: sub.id,
    ...(trialEnd ? { trial_ends_at: trialEnd, trial_used: true } : {}),
  });
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!BILLING_ENABLED || !stripe || !secret) { res.status(503).json({ error: "Billing is not enabled" }); return; }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      req.headers["stripe-signature"] as string,
      secret,
    );
  } catch {
    res.status(400).json({ error: "Invalid signature" }); return;
  }

  // Always 200 after this point (except signature failures) — Stripe retries
  // non-2xx, and our writes are absolute-state so re-processing is safe anyway.
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? (session.metadata?.user_id as string | undefined) ?? null;
        if (!(await recordBillingEvent("stripe", event.id, event.type, userId, { session_id: session.id, mode: session.mode }))) break;
        if (session.mode === "payment" && userId) {
          // Lifetime purchase. If they had a running Pro subscription, cancel it
          // so they aren't billed for a plan the lifetime purchase supersedes.
          const current = await getBillingRow(userId);
          if (current?.stripe_subscription_id) {
            await stripe.subscriptions.cancel(current.stripe_subscription_id).catch((e) =>
              console.error("Could not cancel subscription after lifetime purchase:", (e as Error).message));
          }
          await applyPlanChange(userId, {
            plan: "lifetime",
            plan_status: "active",
            plan_provider: "stripe",
            plan_period_end: null,
            cancel_at_period_end: false,
            stripe_subscription_id: null,
            ...(typeof session.customer === "string" ? { stripe_customer_id: session.customer } : {}),
          });
        }
        // Subscription checkouts: customer.subscription.created is authoritative.
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId =
          (sub.metadata?.user_id as string | undefined) ??
          (typeof sub.customer === "string" ? await findUserByStripeCustomer(sub.customer) : null);
        if (!(await recordBillingEvent("stripe", event.id, event.type, userId, { subscription_id: sub.id, status: sub.status }))) break;
        if (event.type === "customer.subscription.deleted") {
          if (userId) {
            const current = await getBillingRow(userId);
            if (current?.plan !== "lifetime") {
              await applyPlanChange(userId, {
                plan: "free",
                plan_status: "canceled",
                plan_provider: null,
                plan_period_end: null,
                cancel_at_period_end: false,
                stripe_subscription_id: null,
              });
            }
          }
        } else {
          await handleSubscriptionEvent(sub);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        const userId = customerId ? await findUserByStripeCustomer(customerId) : null;
        if (!(await recordBillingEvent("stripe", event.id, event.type, userId, { invoice_id: invoice.id }))) break;
        if (userId) {
          const current = await getBillingRow(userId);
          if (current?.plan === "pro" && current.plan_provider === "stripe") {
            await applyPlanChange(userId, { plan_status: "past_due" });
          }
        }
        break;
      }
      default:
        break; // unhandled event types are fine
    }
  } catch (e) {
    console.error("Stripe webhook processing error:", e);
  }
  res.json({ received: true });
}

// ── RevenueCat webhook (mobile IAP) ──────────────────────────────────────────
// Plain JSON body (no signature scheme) — authenticated by a shared secret the
// RevenueCat dashboard sends in the Authorization header. The mobile app
// configures Purchases with appUserID = Supabase user id, so app_user_id maps
// straight onto profiles.id.

interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  period_type?: string;
  store?: string;
  expiration_at_ms?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/revenuecat", async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!BILLING_ENABLED || !secret) { res.status(503).json({ error: "Billing is not enabled" }); return; }
  const auth = req.headers.authorization ?? "";
  if (auth !== secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }

  const event = (req.body?.event ?? {}) as RevenueCatEvent;
  const type = event.type ?? "";
  if (!type || type === "TEST") { res.json({ received: true }); return; }

  const rawUserId = event.app_user_id ?? event.original_app_user_id ?? "";
  const userId = UUID_RE.test(rawUserId) ? rawUserId : null;
  const eventId = event.id ?? `${type}:${rawUserId}:${event.expiration_at_ms ?? ""}`;

  if (!(await recordBillingEvent("revenuecat", eventId, type, userId, event))) {
    res.json({ received: true }); return;
  }
  if (!userId) { res.json({ received: true }); return; }

  const current = await getBillingRow(userId);
  if (!current) { res.json({ received: true }); return; }

  const provider = event.store === "PLAY_STORE" ? "google" as const : "apple" as const;
  const isLifetimeProduct = (event.product_id ?? "").toLowerCase().includes("lifetime");
  const periodEnd = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;
  const isTrial = event.period_type === "TRIAL";

  try {
    switch (type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "PRODUCT_CHANGE": {
        if (current.plan === "lifetime") break; // nothing beats lifetime
        await applyPlanChange(userId, {
          plan: "pro",
          plan_status: isTrial ? "trialing" : "active",
          plan_provider: provider,
          plan_period_end: periodEnd,
          cancel_at_period_end: false,
          revenuecat_app_user_id: rawUserId,
          ...(isTrial && periodEnd ? { trial_ends_at: periodEnd, trial_used: true } : { trial_used: true }),
        } as Partial<BillingRow>);
        break;
      }
      case "NON_RENEWING_PURCHASE": {
        if (!isLifetimeProduct) break;
        await applyPlanChange(userId, {
          plan: "lifetime",
          plan_status: "active",
          plan_provider: provider,
          plan_period_end: null,
          cancel_at_period_end: false,
          revenuecat_app_user_id: rawUserId,
        } as Partial<BillingRow>);
        break;
      }
      case "CANCELLATION": {
        // Auto-renew turned off — access continues until expiration.
        if (current.plan_provider !== provider) break; // cross-provider guard
        await applyPlanChange(userId, { cancel_at_period_end: true });
        break;
      }
      case "EXPIRATION": {
        // Cross-provider guard: an expired store subscription must not downgrade
        // a Stripe subscriber or a lifetime owner.
        if (current.plan === "lifetime" || current.plan_provider !== provider) break;
        await applyPlanChange(userId, {
          plan: "free",
          plan_status: "canceled",
          plan_provider: null,
          plan_period_end: null,
          cancel_at_period_end: false,
        });
        break;
      }
      case "BILLING_ISSUE": {
        if (current.plan_provider !== provider) break;
        await applyPlanChange(userId, { plan_status: "past_due" });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error("RevenueCat webhook processing error:", e);
  }
  res.json({ received: true });
});

export default router;
