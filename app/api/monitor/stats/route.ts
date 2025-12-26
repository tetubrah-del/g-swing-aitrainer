import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildUserUsageState } from "@/app/lib/membership";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { getMonitorStats } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(request);
  const emailSession = readEmailSessionFromRequest(request);
  const activeAuth = readActiveAuthFromRequest(request) ?? (emailSession ? "email" : null);

  let account = null;

  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;

    account = sessionUserId ? await getUserById(sessionUserId) : null;
    if (!account && sessionEmail) {
      account = await findUserByEmail(sessionEmail);
    }
  }

  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (byId && byId.authProvider === "email") {
      account = byId;
    } else {
      const byEmail = await findUserByEmail(emailSession.email);
      if (byEmail && byEmail.authProvider === "email") account = byEmail;
    }
  }

  const userState = await buildUserUsageState({ user: account, anonymousUserId: tokenAnonymous ?? null });
  if (userState.isMonitor !== true || !account?.userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const stats = getMonitorStats({ userId: account.userId });
  return NextResponse.json(stats);
}

