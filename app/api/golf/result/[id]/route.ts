// app/api/golf/result/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { AnalysisId, GolfAnalysisResponse, MOCK_GOLF_ANALYSIS_RESULT } from "@/app/golf/types";
import { getAnalysis } from "@/app/lib/store";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { auth } from "@/auth";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";

export const runtime = "nodejs";

function json<T>(body: T, init: { status: number }) {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function isValidAnalysisId(id: string | null | undefined): id is AnalysisId {
  if (!id) return false;
  // Allow simple uuid-ish / slug ids, reject obviously invalid input
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

async function buildStoreDebug(id: string, enabled: boolean) {
  if (!enabled) return null;
  const storePath =
    process.env.GOLF_STORE_PATH && process.env.GOLF_STORE_PATH.trim().length > 0
      ? process.env.GOLF_STORE_PATH.trim()
      : path.join(process.cwd(), ".data", "golf-analyses.json");
  try {
    const stat = await fs.stat(storePath);
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(parsed, id);
    return {
      storePath,
      fileSize: stat.size,
      hasId,
    };
  } catch (error) {
    return {
      storePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse<GolfAnalysisResponse | { error: string }>> {
  const { id } = await context.params;
  if (!isValidAnalysisId(id)) {
    return json({ error: "invalid id" }, { status: 400 });
  }
  const analysisId = id as AnalysisId;
  const debugEnabled = process.env.NODE_ENV !== "production" && req.nextUrl.searchParams.get("debug") === "1";
  const storeDebug = await buildStoreDebug(analysisId, debugEnabled);

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
  const effectiveUserId = account?.userId ?? null;

  // Existence-hiding: if caller has neither auth nor token-backed anonymous id, always return 404.
  if (!effectiveUserId && !tokenAnonymous) {
    return json({ error: "not found" }, { status: 404 });
  }

  const stored = await getAnalysis(analysisId);

  if (!stored) {
    if (process.env.NODE_ENV !== "production") {
      return json(
        {
          analysisId,
          result: MOCK_GOLF_ANALYSIS_RESULT,
          note: "MVPダミー: 実データがないためサンプル結果を返しています。",
          ...(storeDebug ? { debug: storeDebug } : null),
        },
        { status: 200 }
      );
    }
    return json({ error: "not found" }, { status: 404 });
  }

  if (effectiveUserId) {
    const user = await getUserById(effectiveUserId);
    if (!user) {
      return json({ error: "not found" }, { status: 404 });
    }
    const recordHasUser = stored.userId != null;
    const ownsByUser = recordHasUser && stored.userId === user.userId;
    const ownsByLinkedAnonymous =
      !recordHasUser &&
      !!stored.anonymousUserId &&
      Array.isArray(user.anonymousIds) &&
      user.anonymousIds.includes(stored.anonymousUserId);

    // When logged-in, never allow access just because the device anonymous token matches.
    // Access to anonymous-only records requires an explicit link (user.anonymousIds).
    if (!ownsByUser && !ownsByLinkedAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }

  } else {
    // Anonymous caller: only allow token-backed anonymous access, and only for records not already owned by a user.
    if (stored.userId != null || !stored.anonymousUserId || stored.anonymousUserId !== tokenAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }
  }

  const res = json(
    {
      analysisId,
      result: stored.result,
      meta: stored.meta,
      createdAt: stored.createdAt,
      ...(storeDebug ? { debug: storeDebug } : null),
    },
    { status: 200 }
  );
  if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
  if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
  return res;
}
