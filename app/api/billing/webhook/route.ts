import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/app/lib/billing/stripe";
import { updateStripeCustomerForUser, updateStripeSubscriptionForUser } from "@/app/lib/userStore";

export const runtime = "nodejs";

function getWebhookSecret() {
  const mode = (process.env.STRIPE_MODE ?? "").trim().toLowerCase() === "live" ? "live" : "test";
  const secret =
    mode === "live"
      ? process.env.STRIPE_WEBHOOK_SECRET_LIVE ?? process.env.STRIPE_WEBHOOK_SECRET
      : process.env.STRIPE_WEBHOOK_SECRET_TEST ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(mode === "live" ? "Missing STRIPE_WEBHOOK_SECRET_LIVE" : "Missing STRIPE_WEBHOOK_SECRET_TEST");
  }
  return secret.trim();
}

function extractUserIdFromSubscription(subscription: Stripe.Subscription): string | null {
  const meta = subscription.metadata ?? {};
  const userId = typeof meta.userId === "string" ? meta.userId : null;
  return userId && userId.trim().length > 0 ? userId : null;
}

async function applySubscriptionUpdate(params: {
  userId: string;
  subscription: Stripe.Subscription;
  stripeCustomerId?: string | null;
}) {
  const { subscription } = params;
  await updateStripeSubscriptionForUser({
    userId: params.userId,
    stripeCustomerId: params.stripeCustomerId ?? (typeof subscription.customer === "string" ? subscription.customer : null),
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null,
    trialEnd: subscription.trial_end ? subscription.trial_end * 1000 : null,
  });
}

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const sig = request.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing_signature" }, { status: 400 });

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, getWebhookSecret());
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = typeof session.client_reference_id === "string" ? session.client_reference_id : null;
        if (!userId) break;

        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
        if (customerId) {
          await updateStripeCustomerForUser({ userId, stripeCustomerId: customerId });
        }

        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const metaUserId = extractUserIdFromSubscription(subscription) ?? userId;
        await applySubscriptionUpdate({ userId: metaUserId, subscription, stripeCustomerId: customerId });
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = extractUserIdFromSubscription(subscription);
        if (!userId) break;
        await applySubscriptionUpdate({ userId, subscription });
        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.finalized":
        // subscription.updated に寄せる（必要なら後で精緻化）
        break;
      default:
        break;
    }
  } catch (e) {
    console.error("[billing:webhook] handler failed", event.type, e);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
