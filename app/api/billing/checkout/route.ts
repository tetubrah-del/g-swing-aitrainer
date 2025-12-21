import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getBaseUrl, getStripe, getStripePriceId } from "@/app/lib/billing/stripe";

export const runtime = "nodejs";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function POST(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { billingCycle?: "monthly" | "yearly" } | null;
  const billingCycle = body?.billingCycle === "yearly" ? "yearly" : "monthly";

  const stripe = getStripe();
  const baseUrl = getBaseUrl();
  const priceId = getStripePriceId(billingCycle);

  try {
    if (account.stripeSubscriptionId && ACTIVE_SUBSCRIPTION_STATUSES.has(account.subscriptionStatus ?? "")) {
      if (!account.stripeCustomerId) {
        return NextResponse.json({ error: "already_subscribed" }, { status: 409 });
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: account.stripeCustomerId,
        return_url: `${baseUrl}/account/billing`,
      });
      return NextResponse.json({ error: "already_subscribed", manageUrl: portal.url }, { status: 409 });
    }

    const price = await stripe.prices.retrieve(priceId);
    if (price.type !== "recurring" || !price.recurring) {
      return NextResponse.json({ error: "invalid_price_not_recurring", priceId }, { status: 400 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: account.userId,
      customer: account.stripeCustomerId ?? undefined,
      customer_email: account.stripeCustomerId ? undefined : account.email ?? undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          userId: account.userId,
        },
      },
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing?canceled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error("[billing:checkout] failed", e);
    return NextResponse.json({ error: "checkout_failed" }, { status: 500 });
  }
}
