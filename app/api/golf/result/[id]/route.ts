// app/api/golf/result/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { AnalysisId, GolfAnalysisResponse, MOCK_GOLF_ANALYSIS_RESULT } from "@/app/golf/types";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { auth } from "@/auth";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { buildAnalyzerPromptBlock, buildSwingAnalyzerProfile } from "@/app/lib/swing/analyzerProfile";

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

function normalizeOutsideInPhrase(text: string): string {
  if (text.includes("アウトサイドイン傾向が強い") || text.includes("アウトサイドイン傾向が見られる")) {
    return text;
  }
  if (text.includes("アウトサイドイン（確定）")) return "アウトサイドイン傾向が強い";
  if (text.includes("外から入りやすい傾向")) return "アウトサイドイン傾向が見られる";
  if (/アウトサイドイン(?!傾向)/.test(text)) return "アウトサイドイン傾向が見られる";
  return text;
}

function normalizeDownswingPhrases(result: GolfAnalysisResponse["result"]): boolean {
  const downswing = result?.phases?.downswing;
  if (!downswing) return false;

  const normalizeList = (items: unknown) => {
    if (!Array.isArray(items)) return null;
    const normalized = items
      .map((item) => (typeof item === "string" ? normalizeOutsideInPhrase(item) : item))
      .filter((item): item is string => typeof item === "string");
    const unique = Array.from(new Set(normalized));
    return unique;
  };

  const nextIssues = normalizeList(downswing.issues);
  const nextAdvice = normalizeList(downswing.advice);
  let changed = false;
  if (nextIssues && JSON.stringify(nextIssues) !== JSON.stringify(downswing.issues ?? [])) {
    downswing.issues = nextIssues;
    changed = true;
  }
  if (nextAdvice && JSON.stringify(nextAdvice) !== JSON.stringify(downswing.advice ?? [])) {
    downswing.advice = nextAdvice;
    changed = true;
  }
  return changed;
}

async function backfillAnalyzerComment(stored: { id: AnalysisId; result: GolfAnalysisResponse["result"] }) {
  if (stored.result?.analyzerComment) return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const analyzerProfile = buildSwingAnalyzerProfile({
    poseMetrics: stored.result.poseMetrics ?? null,
    onPlane: stored.result.on_plane ?? null,
  });
  const analyzerBlock = buildAnalyzerPromptBlock(analyzerProfile);
  if (!analyzerBlock || analyzerBlock === "なし") return null;

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_API_BASE ?? undefined,
  });

  const prompt = [
    "あなたはプロのゴルフスイングコーチです。",
    "以下のスイングアナライザー定量のみを根拠に、AIコーチの解説を4〜5文で生成してください。",
    "構成は「結論→情緒（納得感）→改善1つ」。落ち着いた指導系の語り口。",
    "2〜3回に1回の頻度で比喩を入れる（過剰に煽らない）。",
    "定量と矛盾しないこと。定量が不足する場合は一般論に逃げず、控えめに伝える。",
    "",
    "【スイングアナライザー定量】",
    analyzerBlock,
    "",
    "JSONのみで返してください：",
    '{ "analyzer_comment": "..." }',
  ].join("\n");

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 500,
      temperature: 0.4,
    });

    const parsed =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (completion as any).choices?.[0]?.message?.parsed ?? completion.choices?.[0]?.message?.content;
    const json = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    const comment =
      json && typeof json === "object" && typeof json.analyzer_comment === "string"
        ? json.analyzer_comment.trim()
        : "";
    if (!comment) return null;

    return comment;
  } catch (err) {
    console.warn("[golf/result] analyzerComment backfill failed", err);
    return null;
  }
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

  if (stored?.result && !stored.result.analyzerComment) {
    const comment = await backfillAnalyzerComment({ id: analysisId, result: stored.result });
    if (comment) {
      const updated = {
        ...stored,
        result: {
          ...stored.result,
          analyzerComment: comment,
        },
      };
      await saveAnalysis(updated);
      stored.result = updated.result;
    }
  }

  if (stored?.result && normalizeDownswingPhrases(stored.result)) {
    const updated = {
      ...stored,
      result: { ...stored.result },
    };
    await saveAnalysis(updated);
    stored.result = updated.result;
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
