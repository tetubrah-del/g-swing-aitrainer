import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildUserUsageState } from "@/app/lib/membership";
import { findUserByEmail, getUserById, upsertGoogleUser } from "@/app/lib/userStore";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";

export async function GET(request: NextRequest) {
  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;
  const sessionEmail = session?.user?.email ?? null;
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(request);

  let account = sessionUserId ? await getUserById(sessionUserId) : null;
  if (!account && sessionEmail) {
    account = await findUserByEmail(sessionEmail);
  }
  if (!account && sessionUserId && sessionEmail) {
    account = await upsertGoogleUser({ googleSub: sessionUserId, email: sessionEmail, anonymousUserId: tokenAnonymous });
  }

  const anonId = tokenAnonymous ?? null;
  const userState = await buildUserUsageState({
    user: account,
    anonymousUserId: anonId,
  });

  const res = NextResponse.json({ userState });

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
