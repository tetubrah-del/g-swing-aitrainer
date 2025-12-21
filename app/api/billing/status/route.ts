import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getStripe } from "@/app/lib/billing/stripe";

export const runtime = "nodejs";

function json<T>(body: T, init?: { status?: number }) {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Cookie");
  return res;
}

export async function GET(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const provider = account.billingProvider ?? null;
  const subscriptionId = account.stripeSubscriptionId ?? null;

  if (provider !== "stripe" || !subscriptionId) {
    return json({
      provider,
      subscriptionStatus: account.subscriptionStatus ?? null,
      startedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: account.currentPeriodEnd ?? null,
      nextRenewalAt: account.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: account.cancelAtPeriodEnd ?? null,
      trialEnd: account.trialEnd ?? null,
      billingInterval: null,
      billingIntervalCount: null,
    });
  }

  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const startedAt = subscription.start_date ? subscription.start_date * 1000 : null;
    const currentPeriodStart = subscription.current_period_start ? subscription.current_period_start * 1000 : null;
    const currentPeriodEnd = subscription.current_period_end ? subscription.current_period_end * 1000 : null;
    const cancelAtPeriodEnd = subscription.cancel_at_period_end ?? null;
    const trialEnd = subscription.trial_end ? subscription.trial_end * 1000 : null;

    const firstItem = subscription.items?.data?.[0];
    const recurring = firstItem && typeof firstItem.price !== "string" ? firstItem.price?.recurring : null;
    const billingInterval = recurring?.interval ?? null;
    const billingIntervalCount = typeof recurring?.interval_count === "number" ? recurring.interval_count : null;

    return json({
      provider: "stripe" as const,
      subscriptionStatus: subscription.status ?? null,
      startedAt,
      currentPeriodStart,
      currentPeriodEnd,
      nextRenewalAt: currentPeriodEnd,
      cancelAtPeriodEnd,
      trialEnd,
      billingInterval,
      billingIntervalCount,
    });
  } catch (e) {
    console.error("[billing:status] failed", e);
    return json({
      provider: "stripe" as const,
      subscriptionStatus: account.subscriptionStatus ?? null,
      startedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: account.currentPeriodEnd ?? null,
      nextRenewalAt: account.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: account.cancelAtPeriodEnd ?? null,
      trialEnd: account.trialEnd ?? null,
      billingInterval: null,
      billingIntervalCount: null,
      error: "stripe_failed",
    });
  }
}
