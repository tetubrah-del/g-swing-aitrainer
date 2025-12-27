import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildUserUsageState } from "@/app/lib/membership";
import { findUserByEmail, getUserById, isUserDisabled, linkAnonymousIdToUser, upsertGoogleUser } from "@/app/lib/userStore";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";

export async function GET(request: NextRequest) {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(request);
  const emailSession = readEmailSessionFromRequest(request);
  // If both Google and Email sessions exist but active_auth is missing, default to email to avoid cross-account mixing.
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
    if (!account && sessionUserId && sessionEmail) {
      account = await upsertGoogleUser({ googleSub: sessionUserId, email: sessionEmail, anonymousUserId: tokenAnonymous });
    }
  }
  if (account && isUserDisabled(account)) account = null;

  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (
      byId &&
      byId.authProvider === "email" &&
      byId.emailVerifiedAt != null &&
      typeof byId.email === "string" &&
      byId.email.toLowerCase() === emailSession.email.toLowerCase()
    ) {
      account = byId;
    } else {
      const byEmail = await findUserByEmail(emailSession.email);
      if (byEmail && byEmail.authProvider === "email" && byEmail.emailVerifiedAt != null) {
        account = byEmail;
      }
    }
  }
  if (account && isUserDisabled(account)) account = null;

  const anonId = tokenAnonymous ?? null;

  // If a logged-in user is using a device anonymous token, link it so pre-login analyses remain in history after upgrade.
  if (account?.userId && anonId) {
    try {
      await linkAnonymousIdToUser(account.userId, anonId);
    } catch {
      // ignore: never fail /me due to merge
    }
  }

  const userState = await buildUserUsageState({
    user: account,
    anonymousUserId: anonId,
  });

  const res = NextResponse.json({ userState });
  if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
  if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");

  if (anonId) {
    setAnonymousTokenOnResponse(res, anonId);
  }

  if (!anonId && !account) {
    const newAnon = crypto.randomUUID();
    const freshState = await buildUserUsageState({
      user: null,
      anonymousUserId: newAnon,
    });
    const freshRes = NextResponse.json({ userState: freshState });
    setAnonymousTokenOnResponse(freshRes, newAnon);
    freshRes.headers.set("x-anonymous-id", newAnon);
    return freshRes;
  }

  return res;
}
