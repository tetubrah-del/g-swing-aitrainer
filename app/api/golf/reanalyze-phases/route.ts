// app/api/golf/reanalyze-phases/route.ts

import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalysisResponse, SwingAnalysis } from "@/app/golf/types";
import { buildPhaseComparison } from "@/app/golf/utils/phaseComparison";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { auth } from "@/auth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import type { PhaseFrame } from "@/app/lib/vision/extractPhaseFrames";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { rescoreSwingAnalysis } from "@/app/golf/scoring/phaseGuardrails";

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

function postprocessSinglePhaseResult(args: { phaseLabel: string; result: { score: number; good: string[]; issues: string[]; advice: string[] } }) {
  const { phaseLabel, result } = args;
  const goodCount = result.good.filter((t) => t.trim().length > 0).length;

  if (phaseLabel === "ダウンスイング") {
    const dropGenericAdviceWhenNoIssues = () => {
      if (result.issues.length) return;
      result.advice = result.advice.filter(
        (t) =>
          !/インサイド|内側|手元.*先行|フェース.*開|アウトサイドイン|外から|カット軌道|かぶせ|上から|連動|同調/.test(String(t))
      );
    };
    // Soft "要確認" alone is not enough evidence to keep the score low.
    if (result.issues.length === 1 && /外から入りやすい傾向（要確認）/.test(result.issues[0]) && goodCount >= 2) {
      result.issues = [];
      result.score = Math.max(result.score, 18);
      dropGenericAdviceWhenNoIssues();
    }
    // If issues are empty but score is still low, lift it to match the rubric.
    if (!result.issues.length && goodCount >= 2 && result.score < 18) {
      result.score = 20;
      dropGenericAdviceWhenNoIssues();
    }
  }

  if (phaseLabel === "インパクト") {
    const dropGenericAdviceWhenNoIssues = () => {
      if (result.issues.length) return;
      result.advice = result.advice.filter((t) => !/骨盤|前傾|早期伸展|腰.*前|スペース.*潰|軸|体幹/.test(String(t)));
    };
    // If early extension is mentioned without "(確定)", keep it as "要確認" and avoid harsh scoring.
    if (result.issues.some((t) => /早期伸展/.test(t)) && !result.issues.some((t) => /早期伸展（確定）/.test(t))) {
      result.issues = result.issues.map((t) => (/早期伸展/.test(t) ? "早期伸展の懸念（要確認）" : t));
      result.score = Math.max(result.score, 11);
    }
    // If it's only a soft "要確認" note and otherwise all-positive, don't treat it as a real defect.
    if (result.issues.length === 1 && /早期伸展の懸念（要確認）/.test(result.issues[0]) && goodCount >= 2) {
      result.issues = [];
      result.score = Math.max(result.score, 20);
      dropGenericAdviceWhenNoIssues();
    }
    if (!result.issues.length && goodCount >= 2 && result.score < 20) {
      result.score = 20;
      dropGenericAdviceWhenNoIssues();
    }
  }

  return result;
}

function buildPhasePrompt(args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }) {
  const metaLines = [
    `利き手: ${args.handedness === "left" ? "左打ち" : "右打ち"}`,
    `クラブ: ${args.clubType ?? "unknown"}`,
    `レベル: ${args.level ?? "unknown"}`,
  ].join("\n");

  const mustCheckLines: string[] = [];
  if (args.phaseLabel === "ダウンスイング") {
    mustCheckLines.push(
      `【重要チェック（省略不可）】`,
      `- クラブ軌道が「アウトサイドイン（確定）」か、「外から入りやすい傾向（要確認）」かを必ず判定する。`,
      `- 確定できる場合のみ issues に必ず「アウトサイドイン（確定）」を含め、score は 0〜8 に収める。`,
      `- 外から入りそうな傾向が“見える”程度なら issues に「外から入りやすい傾向（要確認）」を含め、score は 9〜12 に収める（確定と書かない）。`,
      `- 判断できない場合は、その文言を書かない（無理に当てはめない）。`
    );
  }
  if (args.phaseLabel === "インパクト") {
    mustCheckLines.push(
      `【重要チェック（省略不可）】`,
      `- 「早期伸展（骨盤が前に出る／前傾が起きる／スペースが潰れる）」に該当するか必ず判定する。`,
      `- 確定できる場合のみ issues に必ず「早期伸展（確定）」を含める。`,
      `- 懸念レベル（要確認）の場合は issues に「早期伸展の懸念（要確認）」を含める（確定と書かない）。`,
      `- 確定の場合 score は 0〜12（明確なら 0〜10）に収める。要確認の場合は 11〜15 を目安にし、過剰に減点しない。`
    );
  }

  return [
    `あなたはゴルフスイングの分析専門AIです。`,
    `これから提示する画像フレームは「${args.phaseLabel}」に該当するフレームです。`,
    `このフレーム群“のみ”を根拠に、${args.phaseLabel}の評価を返してください（一般論は禁止）。`,
    ``,
    `補足情報:`,
    metaLines,
    mustCheckLines.length ? `` : null,
    ...mustCheckLines,
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

  return { stored, account, error: null };
}

async function analyzeSinglePhase(
  frames: PhaseFrame[],
  args: { phaseLabel: string; handedness?: string; clubType?: string; level?: string }
) {
  const prompt = buildPhasePrompt(args);
  const raw = await askVisionAPI({ frames, prompt });
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  return postprocessSinglePhaseResult({ phaseLabel: args.phaseLabel, result: parseSinglePhaseResult(parsed) });
}

export async function POST(req: NextRequest): Promise<NextResponse<GolfAnalysisResponse | { error: string }>> {
  const body = (await req.json().catch(() => null)) as
    | { analysisId?: string; address?: unknown; backswing?: unknown; top?: unknown; downswing?: unknown; impact?: unknown; finish?: unknown }
    | null;
  const analysisIdRaw = body?.analysisId ?? null;
  if (!isValidAnalysisId(analysisIdRaw)) {
    return json({ error: "invalid id" }, { status: 400 });
  }
  const analysisId = analysisIdRaw as AnalysisId;

  const addressIndices = normalizeIndices(body?.address);
  const backswingIndices = normalizeIndices(body?.backswing);
  const topIndices = normalizeIndices(body?.top);
  const downswingIndices = normalizeIndices(body?.downswing);
  const impactIndices = normalizeIndices(body?.impact);
  const finishIndices = normalizeIndices(body?.finish);

  if (!addressIndices.length && !backswingIndices.length && !topIndices.length && !downswingIndices.length && !impactIndices.length && !finishIndices.length) {
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
    Record<"address" | "backswing" | "top" | "downswing" | "impact" | "finish", { score: number; good: string[]; issues: string[]; advice: string[] }>
  > = {};

  try {
    if (addressIndices.length) {
      const picked = pickFrames(addressIndices);
      if (!picked.length) return json({ error: "invalid address frames" }, { status: 400 });
      phaseUpdates.address = await analyzeSinglePhase(picked, {
        phaseLabel: "アドレス",
        handedness: meta?.handedness,
        clubType: meta?.clubType,
        level: meta?.level,
      });
    }
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
    if (finishIndices.length) {
      const picked = pickFrames(finishIndices);
      if (!picked.length) return json({ error: "invalid finish frames" }, { status: 400 });
      phaseUpdates.finish = await analyzeSinglePhase(picked, {
        phaseLabel: "フィニッシュ",
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
      ...(phaseUpdates.address ? { address: phaseUpdates.address } : null),
      ...(phaseUpdates.backswing ? { backswing: phaseUpdates.backswing } : null),
      ...(phaseUpdates.top ? { top: phaseUpdates.top } : null),
      ...(phaseUpdates.downswing ? { downswing: phaseUpdates.downswing } : null),
      ...(phaseUpdates.impact ? { impact: phaseUpdates.impact } : null),
      ...(phaseUpdates.finish ? { finish: phaseUpdates.finish } : null),
    },
  };

  const nextTotal = computeTotalScoreFromPhases(nextResult.phases as Record<string, { score?: number }>);
  const rescored = rescoreSwingAnalysis({
    result: { ...(nextResult as SwingAnalysis), totalScore: nextTotal },
    deriveFromText: true,
  });

  let previousReport: SwingAnalysis | null = null;
  const previousAnalysisId = stored.meta?.previousAnalysisId ?? null;
  if (typeof previousAnalysisId === "string" && previousAnalysisId !== analysisId) {
    const previousLoaded = await loadAuthorizedAnalysis(req, previousAnalysisId as AnalysisId);
    if (!previousLoaded.error && "stored" in previousLoaded) {
      previousReport = previousLoaded.stored.result ?? null;
    }
  }

  const phaseComparison = previousReport ? buildPhaseComparison(previousReport, rescored) : null;
  const finalResult = { ...rescored, comparison: phaseComparison ?? rescored.comparison };

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
