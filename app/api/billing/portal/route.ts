import { NextRequest, NextResponse } from "next/server";
import { resolveBillingAccount } from "@/app/lib/billing/resolveBillingAccount";
import { getBaseUrl, getStripe } from "@/app/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const account = await resolveBillingAccount(request);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!account.stripeCustomerId) {
    return NextResponse.json({ error: "no_customer" }, { status: 400 });
  }

  const stripe = getStripe();
  const baseUrl = getBaseUrl();

  const portal = await stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${baseUrl}/account/billing`,
  });

  return NextResponse.json({ url: portal.url });
}

