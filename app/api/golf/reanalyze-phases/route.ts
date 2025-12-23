// app/api/golf/reanalyze-phases/route.ts

import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalysisResponse } from "@/app/golf/types";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { auth } from "@/auth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import type { PhaseFrame } from "@/app/lib/vision/extractPhaseFrames";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";

export const runtime = "nodejs";

function json<T>(body: T, init: { status: number }) {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function isValidAnalysisId(id: string | null | undefined): id is AnalysisId {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

const normalizeIndex = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 1 ? rounded : null;
};

const normalizeIndices = (value: unknown): number[] => {
  if (value == null) return [];
  if (typeof value === "number") {
    const idx = normalizeIndex(value);
    return idx ? [idx] : [];
  }
  if (!Array.isArray(value)) return [];
  const out = value.map((v) => normalizeIndex(v)).filter((v): v is number => v != null);
  return Array.from(new Set(out)).sort((a, b) => a - b);
};

function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  if (typeof url !== "string") return null;
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const [mimePart, ...params] = header.split(";");
  if (!params.includes("base64")) return null;
  const mimeType = mimePart || "image/jpeg";
  const base64 = data.replace(/\s+/g, "");
  if (!base64) return null;
  return { mimeType, base64 };
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function coerceScore0to20(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(20, Math.round(n)));
}

function parseSinglePhaseResult(raw: unknown): { score: number; good: string[]; issues: string[]; advice: string[] } {
  if (!raw || typeof raw !== "object") return { score: 0, good: [], issues: [], advice: [] };
  const obj = raw as Record<string, unknown>;
  return {
    score: coerceScore0to20(obj.score),
    good: coerceStringArray(obj.good).slice(0, 4),
    issues: coerceStringArray(obj.issues).slice(0, 4),
    advice: coerceStringArray(obj.advice).slice(0, 4),
  };
}

function buildPhasePrompt(args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }) {
  const metaLines = [
    `利き手: ${args.handedness === "left" ? "左打ち" : "右打ち"}`,
    `クラブ: ${args.clubType ?? "unknown"}`,
    `レベル: ${args.level ?? "unknown"}`,
  ].join("\n");

  return [
    `あなたはゴルフスイングの分析専門AIです。`,
    `これから提示する画像フレームは「${args.phaseLabel}」に該当するフレームです。`,
    `このフレーム群“のみ”を根拠に、${args.phaseLabel}の評価を返してください（一般論は禁止）。`,
    ``,
    `補足情報:`,
    metaLines,
    ``,
    `必ずJSONのみで返してください（前後の文章は禁止）。`,
    `出力形式:`,
    `{`,
    `  "score": 0〜20の数値,`,
    `  "good": ["良い点1","良い点2"],`,
    `  "issues": ["改善点1","改善点2"],`,
    `  "advice": ["アドバイス1","アドバイス2"]`,
    `}`,
  ].join("\n");
}

function computeTotalScoreFromPhases(phases: Record<string, { score?: number }>): number {
  const keys = ["address", "backswing", "top", "downswing", "impact", "finish"] as const;
  const sum = keys.reduce((acc, k) => acc + (Number(phases[k]?.score) || 0), 0);
  return Math.max(0, Math.min(100, Math.round((sum / (keys.length * 20)) * 100)));
}

async function loadAuthorizedAnalysis(req: NextRequest, analysisId: AnalysisId) {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null as Awaited<ReturnType<typeof getUserById>> | null;
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

  if (!effectiveUserId && !tokenAnonymous) {
    return { error: "not found" as const, account: null as typeof account };
  }

  const stored = await getAnalysis(analysisId);
  if (!stored) return { error: "not found" as const, account };

  if (effectiveUserId) {
    const user = await getUserById(effectiveUserId);
    if (!user) return { error: "not found" as const, account };
    const recordHasUser = stored.userId != null;
    const ownsByUser = recordHasUser && stored.userId === user.userId;
    const ownsByLinkedAnonymous =
      !recordHasUser &&
      !!stored.anonymousUserId &&
      Array.isArray(user.anonymousIds) &&
      user.anonymousIds.includes(stored.anonymousUserId);
    if (!ownsByUser && !ownsByLinkedAnonymous) return { error: "not found" as const, account };
  } else {
    if (stored.userId != null || !stored.anonymousUserId || stored.anonymousUserId !== tokenAnonymous) {
      return { error: "not found" as const, account };
    }
  }

  return { stored, account, error: null as const };
}

async function analyzeSinglePhase(
  frames: PhaseFrame[],
  args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }
) {
  const prompt = buildPhasePrompt(args);
  const raw = await askVisionAPI({ frames, prompt });
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  return parseSinglePhaseResult(parsed);
}

export async function POST(req: NextRequest): Promise<NextResponse<GolfAnalysisResponse | { error: string }>> {
  const body = (await req.json().catch(() => null)) as
    | { analysisId?: string; backswing?: unknown; top?: unknown; downswing?: unknown; impact?: unknown }
    | null;
  const analysisIdRaw = body?.analysisId ?? null;
  if (!isValidAnalysisId(analysisIdRaw)) {
    return json({ error: "invalid id" }, { status: 400 });
  }
  const analysisId = analysisIdRaw as AnalysisId;

  const backswingIndices = normalizeIndices(body?.backswing);
  const topIndices = normalizeIndices(body?.top);
  const downswingIndices = normalizeIndices(body?.downswing);
  const impactIndices = normalizeIndices(body?.impact);

  if (!backswingIndices.length && !topIndices.length && !downswingIndices.length && !impactIndices.length) {
    return json({ error: "no overrides" }, { status: 400 });
  }

  const loaded = await loadAuthorizedAnalysis(req, analysisId);
  if (loaded.error) return json({ error: loaded.error }, { status: 404 });
  const { stored, account } = loaded;

  const sequence = stored.result?.sequence;
  const frames = Array.isArray(sequence?.frames) ? sequence!.frames : [];
  if (!frames.length) {
    return json({ error: "sequence frames not available" }, { status: 400 });
  }

  const pickFrames = (indices: number[]): PhaseFrame[] => {
    const out: PhaseFrame[] = [];
    for (const idx1 of indices) {
      const i = idx1 - 1;
      const entry = frames[i];
      if (!entry || typeof entry.url !== "string") continue;
      const parsed = parseDataUrl(entry.url);
      if (!parsed) continue;
      out.push({ base64Image: parsed.base64, mimeType: parsed.mimeType, timestampSec: entry.timestampSec });
    }
    return out;
  };

  const meta = stored.meta ?? null;
  const phaseUpdates: Partial<
    Record<"backswing" | "top" | "downswing" | "impact", { score: number; good: string[]; issues: string[]; advice: string[] }>
  > = {};

  try {
    if (backswingIndices.length) {
      const picked = pickFrames(backswingIndices);
      if (!picked.length) return json({ error: "invalid backswing frames" }, { status: 400 });
      phaseUpdates.backswing = await analyzeSinglePhase(picked, {
        phaseLabel: "バックスイング",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (topIndices.length) {
      const picked = pickFrames(topIndices);
      if (!picked.length) return json({ error: "invalid top frames" }, { status: 400 });
      phaseUpdates.top = await analyzeSinglePhase(picked, {
        phaseLabel: "トップ",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (downswingIndices.length) {
      const picked = pickFrames(downswingIndices);
      if (!picked.length) return json({ error: "invalid downswing frames" }, { status: 400 });
      phaseUpdates.downswing = await analyzeSinglePhase(picked, {
        phaseLabel: "ダウンスイング",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
    if (impactIndices.length) {
      const picked = pickFrames(impactIndices);
      if (!picked.length) return json({ error: "invalid impact frames" }, { status: 400 });
      phaseUpdates.impact = await analyzeSinglePhase(picked, {
        phaseLabel: "インパクト",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
  } catch (err) {
    console.error("[reanalyze-phases] vision failed", err);
    return json({ error: "reanalyze failed" }, { status: 502 });
  }

  const nextResult = {
    ...stored.result,
    phases: {
      ...stored.result.phases,
      ...(phaseUpdates.backswing ? { backswing: phaseUpdates.backswing } : null),
      ...(phaseUpdates.top ? { top: phaseUpdates.top } : null),
      ...(phaseUpdates.downswing ? { downswing: phaseUpdates.downswing } : null),
      ...(phaseUpdates.impact ? { impact: phaseUpdates.impact } : null),
    },
  };

  const nextTotal = computeTotalScoreFromPhases(nextResult.phases as Record<string, { score?: number }>);
  const finalResult = { ...nextResult, totalScore: nextTotal };

  const updated = { ...stored, result: finalResult };
  await saveAnalysis(updated);

  const res = json(
    {
      analysisId,
      result: finalResult,
      meta: stored.meta,
      createdAt: stored.createdAt,
    },
    { status: 200 }
  );
  if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
  if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
  return res;
}
