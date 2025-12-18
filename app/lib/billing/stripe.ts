import Stripe from "stripe";

let cachedStripe: Stripe | null = null;

export function getStripe() {
  if (cachedStripe) return cachedStripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }
  cachedStripe = new Stripe(key);
  return cachedStripe;
}

export function getBaseUrl() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

export function getStripePriceId(billingCycle: "monthly" | "yearly") {
  const priceId =
    billingCycle === "yearly" ? process.env.STRIPE_PRICE_ID_PRO_YEARLY : process.env.STRIPE_PRICE_ID_PRO_MONTHLY;
  if (!priceId) {
    throw new Error(
      billingCycle === "yearly" ? "Missing STRIPE_PRICE_ID_PRO_YEARLY" : "Missing STRIPE_PRICE_ID_PRO_MONTHLY"
    );
  }
  return priceId;
}
