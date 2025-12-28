import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getStripe } from "@/app/lib/billing/stripe";
import { isUserDisabled, requestUserWithdrawal, updateStripeSubscriptionForUser, deleteUserAccountAndData } from "@/app/lib/userStore";

export const runtime = "nodejs";

function json<T>(body: T, init?: { status?: number }) {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Cookie");
  return res;
}

function normalizeReason(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return trimmed.slice(0, 200);
}

function requiresProCancel(account: {
  billingProvider?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
}) {
  if (account.billingProvider !== "stripe") return false;
  if (!account.stripeSubscriptionId) return false;
  const status = account.subscriptionStatus ?? null;
  // Active-ish states where the subscription still exists and can be scheduled for cancel at period end.
  return status === "active" || status === "trialing" || status === "past_due";
}

export async function GET(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account || isUserDisabled(account)) return json({ error: "unauthorized" }, { status: 401 });

  return json({
    ok: true,
    userId: account.userId,
    email: account.email ?? null,
    hasProAccess: account.proAccess === true,
    billingProvider: account.billingProvider ?? null,
    stripeSubscriptionId: account.stripeSubscriptionId ?? null,
    subscriptionStatus: account.subscriptionStatus ?? null,
    currentPeriodEnd: account.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd ?? null,
    withdrawRequestedAt: account.withdrawRequestedAt ?? null,
    withdrawScheduledAt: account.withdrawScheduledAt ?? null,
  });
}

export async function POST(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account || isUserDisabled(account)) return json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown; reason?: unknown };
  const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
  if (confirm !== "退会") {
    return json({ error: "confirm_required" }, { status: 400 });
  }
  const reason = normalizeReason(body.reason);

  // If the user has an active Stripe subscription, schedule cancel at period end and defer account deletion until then.
  if (requiresProCancel(account)) {
    try {
      const stripe = getStripe();
      const subscriptionId = account.stripeSubscriptionId as string;
      const subscription = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

      const currentPeriodEnd =
        typeof subscription.current_period_end === "number" ? subscription.current_period_end * 1000 : account.currentPeriodEnd ?? null;
      if (!currentPeriodEnd) return json({ error: "missing_current_period_end" }, { status: 500 });

      await updateStripeSubscriptionForUser({
        userId: account.userId,
        stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : account.stripeCustomerId ?? null,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status ?? null,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? true,
        trialEnd: subscription.trial_end ? subscription.trial_end * 1000 : null,
      });

      await requestUserWithdrawal({ userId: account.userId, scheduledAt: currentPeriodEnd, reason });

      return json({
        ok: true,
        mode: "scheduled",
        withdrawScheduledAt: currentPeriodEnd,
      });
    } catch (e) {
      console.error("[account:withdraw] stripe cancel_at_period_end failed", e);
      return json({ error: "stripe_failed" }, { status: 502 });
    }
  }

  // No active Stripe subscription: delete immediately.
  await requestUserWithdrawal({ userId: account.userId, scheduledAt: Date.now(), reason });
  await deleteUserAccountAndData(account.userId);

  return json({ ok: true, mode: "immediate" });
}

