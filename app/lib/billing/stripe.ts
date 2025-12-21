import Stripe from "stripe";

let cachedStripe: Stripe | null = null;

type StripeMode = "test" | "live";

function getStripeMode(): StripeMode {
  const raw = (process.env.STRIPE_MODE ?? "").trim().toLowerCase();
  if (raw === "live") return "live";
  if (raw === "test") return "test";
  return process.env.NODE_ENV === "production" ? "live" : "test";
}

function getStripeSecretKey() {
  const mode = getStripeMode();
  const key =
    mode === "live"
      ? process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY
      : process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY;
  return { mode, key: key?.trim() ?? "" };
}

export function getStripe() {
  if (cachedStripe) return cachedStripe;
  const { mode, key } = getStripeSecretKey();
  if (!key) {
    throw new Error(
      mode === "live"
        ? "Missing STRIPE_SECRET_KEY_LIVE (or STRIPE_SECRET_KEY)"
        : "Missing STRIPE_SECRET_KEY_TEST (or STRIPE_SECRET_KEY)"
    );
  }
  const looksLikeStripeSecret =
    key.startsWith("sk_test_") ||
    key.startsWith("sk_live_") ||
    // restricted keys (server-side) also work for some operations
    key.startsWith("rk_test_") ||
    key.startsWith("rk_live_");
  if (!looksLikeStripeSecret) {
    throw new Error(
      "Invalid Stripe secret key (expected sk_test_/sk_live_/rk_test_/rk_live_). Check STRIPE_MODE and STRIPE_SECRET_KEY_*."
    );
  }
  cachedStripe = new Stripe(key);
  return cachedStripe;
}

export function getBaseUrl() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

export function getStripePriceId(billingCycle: "monthly" | "yearly") {
  const mode = getStripeMode();
  const priceId =
    billingCycle === "yearly"
      ? mode === "live"
        ? process.env.STRIPE_PRICE_ID_PRO_YEARLY_LIVE ?? process.env.STRIPE_PRICE_ID_PRO_YEARLY
        : process.env.STRIPE_PRICE_ID_PRO_YEARLY_TEST ?? process.env.STRIPE_PRICE_ID_PRO_YEARLY
      : mode === "live"
        ? process.env.STRIPE_PRICE_ID_PRO_MONTHLY_LIVE ?? process.env.STRIPE_PRICE_ID_PRO_MONTHLY
        : process.env.STRIPE_PRICE_ID_PRO_MONTHLY_TEST ?? process.env.STRIPE_PRICE_ID_PRO_MONTHLY;
  if (!priceId) {
    throw new Error(
      billingCycle === "yearly"
        ? "Missing Stripe price id (set STRIPE_PRICE_ID_PRO_YEARLY_TEST/LIVE)"
        : "Missing Stripe price id (set STRIPE_PRICE_ID_PRO_MONTHLY_TEST/LIVE)"
    );
  }
  return priceId.trim();
}
