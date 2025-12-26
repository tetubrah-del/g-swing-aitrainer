import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { ensureReferralCode } from "@/app/lib/referralTracking";
import { getBaseUrl } from "@/app/lib/billing/stripe";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";

export const runtime = "nodejs";

async function resolveActorId(req: NextRequest): Promise<string | null> {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null;
  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
    if (!account && sessionEmail) account = await findUserByEmail(sessionEmail);
  }

  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (byId && byId.authProvider === "email") account = byId;
  }

  return account?.userId ?? tokenAnonymous ?? null;
}

export async function GET(req: NextRequest) {
  const analysisId = req.nextUrl.searchParams.get("analysisId");
  if (!analysisId) return NextResponse.json({ error: "analysisId required" }, { status: 400 });

  const actorId = await resolveActorId(req);
  if (!actorId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const code = ensureReferralCode(actorId);
  const shareUrl = `${getBaseUrl()}/share/${encodeURIComponent(analysisId)}?ref=${encodeURIComponent(code)}`;
  return NextResponse.json({ shareUrl });
}
