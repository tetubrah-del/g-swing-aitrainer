import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getBaseUrl, getStripe, getStripePriceId } from "@/app/lib/billing/stripe";

export const runtime = "nodejs";

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
}

