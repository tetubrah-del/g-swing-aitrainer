import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/auth";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest, setActiveAuthOnResponse } from "@/app/lib/activeAuth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { getAnalysis } from "@/app/lib/store";
import { getFeatures } from "@/app/lib/features";
import { hasFreeCoachUsed, markFreeCoachUsed } from "@/app/lib/freeCoachUsageStore";
import type { AnalysisId, SwingAnalysis } from "@/app/golf/types";
import { retrieveCoachKnowledge } from "@/app/coach/rag/retrieve";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type GuidedCoachResponse = {
  keyImprovement: string;
  recommendedDrill: string;
  nextQuestions: [string, string, string];
};

type GuidedCoachReplyResponse = {
  reply: string;
};

function json<T>(body: T, init?: { status?: number }) {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Cookie");
  return res;
}

function isValidAnalysisId(id: unknown): id is AnalysisId {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

function parseJsonContent(content: unknown) {
  if (content === null || content === undefined) return {};
  if (typeof content === "object") return content;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toGuidedCoachResponse(value: unknown): GuidedCoachResponse | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.keyImprovement !== "string" || !v.keyImprovement.trim()) return null;
  if (typeof v.recommendedDrill !== "string" || !v.recommendedDrill.trim()) return null;
  if (!Array.isArray(v.nextQuestions) || v.nextQuestions.length !== 3) return null;
  const qs = v.nextQuestions;
  if (!qs.every((q) => typeof q === "string" && q.trim().length > 0)) return null;
  return {
    keyImprovement: v.keyImprovement.trim(),
    recommendedDrill: v.recommendedDrill.trim(),
    nextQuestions: [qs[0].trim(), qs[1].trim(), qs[2].trim()],
  };
}

function pickLowestPhaseIssue(analysis: SwingAnalysis): string {
  const phases = analysis?.phases ?? ({} as SwingAnalysis["phases"]);
  const entries = Object.entries(phases ?? {}) as Array<[string, { score?: number; issues?: string[] } | undefined]>;
  const scored = entries
    .map(([key, phase]) => ({
      key,
      score: typeof phase?.score === "number" ? phase.score : 999,
      issue: Array.isArray(phase?.issues) ? (phase?.issues?.[0] ?? "") : "",
    }))
    .sort((a, b) => a.score - b.score);
  const candidate = scored.find((p) => p.issue.trim().length > 0)?.issue?.trim();
  if (candidate) return candidate;
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  if (summary) return summary.split("。")[0]?.trim() || summary;
  return "今回もっとも優先して直すべきポイントを1つに絞りましょう";
}

function buildFallback(analysis: SwingAnalysis): GuidedCoachResponse {
  const keyImprovement = pickLowestPhaseIssue(analysis);
  const drill =
    Array.isArray(analysis.recommendedDrills) && analysis.recommendedDrills[0]
      ? String(analysis.recommendedDrills[0])
      : "ハーフスイングで、インパクト直前まで右手の力を抑えて10球だけ打つ（1球ごとにフィニッシュで2秒止める）。";
  return {
    keyImprovement,
    recommendedDrill: drill,
    nextQuestions: [
      "この改善点はどれくらいで直りますか？",
      "自宅練習でもできますか？",
      "別のクラブでも同じ問題は出ますか？",
    ],
  };
}

function buildPrompt(analysis: SwingAnalysis) {
  const summary = typeof analysis.summary === "string" ? analysis.summary.slice(0, 600) : "";
  const drills =
    Array.isArray(analysis.recommendedDrills) && analysis.recommendedDrills.length
      ? analysis.recommendedDrills.slice(0, 3).map(String).join("\n")
      : "（ドリル候補なし）";
  const phases = analysis.phases ?? ({} as SwingAnalysis["phases"]);
  const phaseText = Object.entries(phases)
    .map(([k, v]) => {
      const score = typeof (v as { score?: unknown })?.score === "number" ? (v as { score?: number }).score : null;
      const issue =
        Array.isArray((v as { issues?: unknown })?.issues) && (v as { issues?: string[] }).issues?.[0]
          ? (v as { issues?: string[] }).issues![0]
          : "";
      return `${k}: score=${score ?? "N/A"} issue=${issue || "N/A"}`;
    })
    .join("\n");

  const rag = retrieveCoachKnowledge(`${summary}\n${phaseText}`, { maxChunks: 2, maxChars: 700, minScore: 1 });

  return `
あなたはゴルフスイング診断アプリの「無料枠AIコーチ（体験版/メール会員）」です。
目的: 診断結果を補助するため、ユーザーが最優先で直すべき改善ポイントを1つだけ示し、定型ドリルを1つ提示する。

制約:
- 出力は JSON のみ。余計な文字は一切出力しない。
- 次のキーを必ず含める: keyImprovement, recommendedDrill, nextQuestions
- nextQuestions は必ずこの3つをそのまま返す:
  1) この改善点はどれくらいで直りますか？
  2) 自宅練習でもできますか？
  3) 別のクラブでも同じ問題は出ますか？
- keyImprovement は1つだけ（短く、具体的に）。
- recommendedDrill は定型ドリル文（短く、回数/狙いが含まれる）。

${rag.contextText ? `\n【KnowledgeBase（参考情報）】\n${rag.contextText}\n` : ""}

診断サマリ:
${summary || "N/A"}

フェーズ概要:
${phaseText || "N/A"}

推奨ドリル候補（あれば参考にしてよい）:
${drills}
`.trim();
}

function buildReplyPrompt(params: { analysis: SwingAnalysis; initial: GuidedCoachResponse; userMessage: string }) {
  const summary = typeof params.analysis.summary === "string" ? params.analysis.summary.slice(0, 600) : "";
  const keyImprovement = params.initial.keyImprovement;
  const drill = params.initial.recommendedDrill;
  const q = params.userMessage.trim().slice(0, 400);
  return `
あなたはゴルフスイング診断アプリの「無料枠AIコーチ（体験版/メール会員）」です。
ユーザーは無料枠として「質問は1回だけ」できます。あなたはその質問に「1回だけ」返答します。

重要: 無料枠では動画/画像フレームを直接参照しません。見ていないものを「できている/できていない」と断定しないでください。

前提となる診断サマリ:
${summary || "N/A"}

今回の最優先改善ポイント:
${keyImprovement}

おすすめドリル:
${drill}

ユーザーの質問:
${q}

厳守:
- 出力は日本語の短い文章のみ（JSON禁止）。
- 2〜4文以内（改行はOK）。
- 1文目で必ず「質問への直接回答」をする。
  - ユーザーのスイングの状態確認/判定を求める質問（例: 「〜できていますか？」「回せていますか？」「私のスイングは〜ですか？」）は、
    1文目を必ず次の定型文にする: 「現在のプランではスイングを確認できません。」
  - それ以外の一般質問は、1文目でYes/No/場合分けのいずれかで短く答える。
- 一般論ベースでOK。因果は浅くてOK。
- 数値を出す場合は幅（例: 2〜4週間 / 10〜30球 / 1〜2割）を持たせる。
- 最後の1文で自然に「PROなら詳しく解説できる」旨を示唆する。
`.trim();
}

function isUserSpecificSwingStateQuestion(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /私の|自分の|あなたの|この動画|この画像|診断結果|今回の結果/.test(t) || /できて(い|)ますか|回せ(て|)ますか|合って(い|)ますか|問題(は|が)ありますか|悪いですか|大丈夫ですか|ですか\?|\?$/.test(t) && /胸|体|腰|回転|開き|フェース|パス|軌道|インパクト|ダウンスイング|トップ|アドレス|手元|ハンド|リリース/.test(t);
}

function enforceSentenceLimit(text: string, maxSentences: number) {
  const raw = (text || "").trim();
  if (!raw) return raw;
  const parts = raw
    .split(/(?<=[。！？!?\n])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= maxSentences) return parts.join(" ");
  return parts.slice(0, maxSentences).join(" ");
}

function normalizeGuidedReply(params: { userMessage: string; reply: string }): string {
  const needsVisual = isUserSpecificSwingStateQuestion(params.userMessage);
  let text = sanitizeShortReply(params.reply);
  if (!text) return text;

  if (needsVisual) {
    text = text.replace(/^質問への直接回答は[「『].*?[」』]です[。．]\s*/u, "");
    text = text.replace(/^質問への直接回答は.*?です[。．]\s*/u, "");
    if (!text.startsWith("現在のプランではスイングを確認できません。")) {
      text = `現在のプランではスイングを確認できません。${text.startsWith("。") ? text.slice(1) : text}`;
    }
  }

  text = enforceSentenceLimit(text, 4);
  return text;
}

function sanitizeShortReply(text: string) {
  const cleaned = (text || "").trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = lines.join(" ");
  return joined.length > 900 ? `${joined.slice(0, 900)}…` : joined;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { analysisId?: unknown; mode?: unknown; message?: unknown };
  if (!isValidAnalysisId(body.analysisId)) {
    return json({ error: "invalid analysisId" }, { status: 400 });
  }
  const analysisId = body.analysisId;
  const mode = body.mode === "reply" ? "reply" : "init";

  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
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
  if (!effectiveUserId && !tokenAnonymous) {
    return json({ error: "not found" }, { status: 404 });
  }

  const now = Date.now();
  const isPro = !!account?.proAccess && (account.proAccessExpiresAt == null || account.proAccessExpiresAt > now);
  const features = getFeatures({ remainingCount: null, isPro });
  if (features.coach !== "guided") {
    return json({ error: "not found" }, { status: 404 });
  }

  const stored = await getAnalysis(analysisId);
  if (!stored?.result) {
    return json({ error: "not found" }, { status: 404 });
  }

  if (effectiveUserId) {
    const user = await getUserById(effectiveUserId);
    if (!user) return json({ error: "not found" }, { status: 404 });
    const recordHasUser = stored.userId != null;
    const ownsByUser = recordHasUser && stored.userId === user.userId;
    const ownsByLinkedAnonymous =
      !recordHasUser &&
      !!stored.anonymousUserId &&
      Array.isArray(user.anonymousIds) &&
      user.anonymousIds.includes(stored.anonymousUserId);
    if (!ownsByUser && !ownsByLinkedAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }
  } else {
    if (stored.userId != null || !stored.anonymousUserId || stored.anonymousUserId !== tokenAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }
  }

  const analysis = stored.result;
  const fallback = buildFallback(analysis);

  const actorId = effectiveUserId ? `user:${effectiveUserId}` : tokenAnonymous ? `anon:${tokenAnonymous}` : "unknown";

  if (mode === "reply") {
    const rawMessage = typeof body.message === "string" ? body.message : "";
    const userMessage = rawMessage.trim();
    if (!userMessage) {
      return json({ error: "message_required" }, { status: 400 });
    }

    const used = await hasFreeCoachUsed({ actorId, analysisId });
    if (used) {
      return json({ error: "free_coach_chat_used" }, { status: 403 });
    }

    const initial = fallback;
    if (!client.apiKey) {
      await markFreeCoachUsed({ actorId, analysisId });
      return json(
        {
          reply:
            "一般的には、改善の早さは2〜6週間程度が目安と言われています。ただし個人差があります。まずは提示したドリルを10〜30球ほど続けて変化を確認してみてください。あなたの条件に合わせた最短ルートは、PROで詳しく解説できます。",
        } satisfies GuidedCoachReplyResponse,
        { status: 200 },
      );
    }

    try {
      const prompt = buildReplyPrompt({ analysis, initial, userMessage });
      const result = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
        temperature: 0.35,
        max_tokens: 220,
      });
      const text = normalizeGuidedReply({ userMessage, reply: result.choices?.[0]?.message?.content ?? "" });
      await markFreeCoachUsed({ actorId, analysisId });
      return json({ reply: text || "PROで詳しく解説できます。" } satisfies GuidedCoachReplyResponse, { status: 200 });
    } catch (err) {
      console.error("[coach-guided reply]", err);
      await markFreeCoachUsed({ actorId, analysisId });
      return json(
        {
          reply:
            "一般的には、改善の早さは2〜6週間程度が目安と言われています。ただし個人差があります。まずは提示したドリルを10〜30球ほど続けて変化を確認してみてください。あなたの条件に合わせた最短ルートは、PROで詳しく解説できます。",
        } satisfies GuidedCoachReplyResponse,
        { status: 200 },
      );
    }
  }

  if (!client.apiKey) {
    const res = json(fallback, { status: 200 });
    if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
    if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
    return res;
  }

  try {
    const prompt = buildPrompt(analysis);
    const result = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant. Output JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 320,
      response_format: { type: "json_object" },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const structured = (result as any).choices?.[0]?.message?.parsed ?? result.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(structured);
    const response = toGuidedCoachResponse(parsed) ?? fallback;

    const res = json(response, { status: 200 });
    if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
    if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
    return res;
  } catch (err) {
    console.error("[coach-guided]", err);
    const res = json(fallback, { status: 200 });
    if (account?.authProvider === "google") setActiveAuthOnResponse(res, "google");
    if (account?.authProvider === "email") setActiveAuthOnResponse(res, "email");
    return res;
  }
}
