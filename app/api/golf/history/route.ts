import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { auth } from "@/auth";
import { listAnalyses } from "@/app/lib/store";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";

function json<T>(body: T, init?: { status?: number }) {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Cookie");
  return res;
}

export async function GET(req: NextRequest) {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
  // If both Google and Email sessions exist but active_auth is missing, default to email to avoid cross-account mixing.
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null;

  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
  }

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
  const isLoggedIn = !!account;
  const resolvedUserId: string | null = account?.userId ?? null;
  const anonymousUserId: string | null = isLoggedIn ? null : tokenAnonymous ?? null;

  if (!resolvedUserId && !anonymousUserId) {
    // Mint a fresh anonymous token (same behavior as /api/golf/me) so clients don't need to send IDs.
    const newAnon = crypto.randomUUID();
    const res = json({ items: [], access: "anonymous" as const });
    setAnonymousTokenOnResponse(res, newAnon);
    res.headers.set("x-anonymous-id", newAnon);
    return res;
  }

  const records = await listAnalyses(
    { userId: resolvedUserId ?? undefined, anonymousUserId: anonymousUserId ?? undefined },
    { limit: 50, order: "desc" },
  );
  const visibleRecords = resolvedUserId ? records : records.filter((r) => r.userId == null);

  const items = visibleRecords.map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    score: record.result?.totalScore ?? null,
    club: record.meta?.clubType ?? null,
    level: record.meta?.level ?? null,
  }));

  const access = resolvedUserId ? "member" : "anonymous";

  const res = json({ items, access });
  if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
  if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
  if (anonymousUserId) {
    setAnonymousTokenOnResponse(res, anonymousUserId);
  }
  if (process.env.NODE_ENV !== "production") {
    res.headers.set("x-debug-active-auth", activeAuth ?? "null");
    res.headers.set("x-debug-account-provider", account?.authProvider ?? "null");
    res.headers.set("x-debug-account-userid", account?.userId ?? "null");
  }
  return res;
}
