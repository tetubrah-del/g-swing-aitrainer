import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { auth } from "@/auth";
import { listAnalyses } from "@/app/lib/store";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { getFeatures } from "@/app/lib/features";

function json<T>(body: T, init?: { status?: number }) {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Cookie");
  return res;
}

type PhaseRating = "good" | "needs_improvement";

const phaseOrder = ["address", "backswing", "top", "downswing", "impact", "finish"] as const;

function pickKeyImprovement(record: { result?: { summary?: string; phases?: Record<string, { score?: number; issues?: string[] }> } }) {
  const phases = record.result?.phases ?? {};
  const scored = Object.entries(phases)
    .map(([key, p]) => ({
      key,
      score: typeof p?.score === "number" ? p.score : 999,
      issue: Array.isArray(p?.issues) ? (p.issues?.[0] ?? "") : "",
    }))
    .sort((a, b) => a.score - b.score);
  const issue = scored.find((p) => p.issue.trim().length > 0)?.issue?.trim();
  if (issue) return issue;
  const summary = typeof record.result?.summary === "string" ? record.result.summary.trim() : "";
  if (summary) return summary.split("。")[0]?.trim() || summary;
  return null;
}

function buildPhaseRatings(record: { result?: { phases?: Record<string, { score?: number }> } }): Record<(typeof phaseOrder)[number], PhaseRating> {
  const phases = record.result?.phases ?? {};
  const ratings = {} as Record<(typeof phaseOrder)[number], PhaseRating>;
  for (const key of phaseOrder) {
    const score = typeof phases[key]?.score === "number" ? phases[key]!.score! : 0;
    ratings[key] = score >= 14 ? "good" : "needs_improvement";
  }
  return ratings;
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

  const now = Date.now();
  const isPro = !!account?.proAccess && (account.proAccessExpiresAt == null || account.proAccessExpiresAt > now);
  const features = getFeatures({ remainingCount: null, isPro });
  const depth = features.historyDepth;

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
    { limit: depth === "latest_only" ? 1 : 50, order: "desc" },
  );
  const visibleRecords = resolvedUserId ? records : records.filter((r) => r.userId == null);

  const items = visibleRecords.map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    score: record.result?.totalScore ?? null,
    club: record.meta?.clubType ?? null,
    level: record.meta?.level ?? null,
    keyImprovement: depth === "latest_only" ? pickKeyImprovement(record) : null,
    phaseRatings: depth === "latest_only" ? buildPhaseRatings(record) : null,
  }));

  const access = resolvedUserId ? "member" : "anonymous";

  const res = json({ items, access, historyDepth: depth });
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
