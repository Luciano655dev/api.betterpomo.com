// Stripe client + price↔plan mapping. The client is null when
// STRIPE_SECRET_KEY is unset (local dev without billing) — billing routes
// respond 503 in that case instead of crashing the whole API on boot.
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
export const stripe = key ? new Stripe(key) : null;

/** Checkout plan identifiers accepted from clients. */
export const PRICE_IDS: Record<"pro_monthly" | "pro_yearly" | "lifetime", string> = {
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "",
  pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? "",
  lifetime: process.env.STRIPE_PRICE_LIFETIME ?? "",
};

export type CheckoutPlan = keyof typeof PRICE_IDS;

export function isCheckoutPlan(v: unknown): v is CheckoutPlan {
  return v === "pro_monthly" || v === "pro_yearly" || v === "lifetime";
}

/** Maps a Stripe price id back to our plan. Returns null for unknown prices
 *  (e.g. a price added in the dashboard but not configured in env). */
export function priceToPlan(priceId: string | null | undefined): "pro" | "lifetime" | null {
  if (!priceId) return null;
  if (priceId === PRICE_IDS.pro_monthly || priceId === PRICE_IDS.pro_yearly) return "pro";
  if (priceId === PRICE_IDS.lifetime) return "lifetime";
  return null;
}

/** current_period_end lives on the subscription in classic API versions and on
 *  subscription items in newer ones — check both. Returns an ISO string. */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } };
  const epoch = s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  return epoch ? new Date(epoch * 1000).toISOString() : null;
}
