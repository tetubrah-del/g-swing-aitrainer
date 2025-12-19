import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getStripe } from "@/app/lib/billing/stripe";
import { updateStripeCustomerForUser, updateStripeSubscriptionForUser } from "@/app/lib/userStore";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { sessionId?: string } | null;
  const sessionId = body?.sessionId ?? null;
  if (!sessionId) {
    return NextResponse.json({ error: "missing_sessionId" }, { status: 400 });
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });

  if (session.client_reference_id !== account.userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  if (customerId) {
    await updateStripeCustomerForUser({ userId: account.userId, stripeCustomerId: customerId });
  }

  const subscription = session.subscription;
  if (subscription && typeof subscription !== "string") {
    await updateStripeSubscriptionForUser({
      userId: account.userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null,
      trialEnd: subscription.trial_end ? subscription.trial_end * 1000 : null,
    });
  }

  return NextResponse.json({ ok: true });
}

