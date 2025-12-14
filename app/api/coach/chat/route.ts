import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CoachChatRequest, CoachConfidenceLevel, CoachMessage } from "@/app/coach/types";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_PERSONA =
  "あなたは専属のAIゴルフコーチです。常に1つの改善テーマに絞り、次の練習・次の動画撮影で確認できる行動を具体的に示します。雑談は最小限にし、ユーザーが迷わず『次に何をするか』を決められるよう導いてください。";

const confidenceFromNumber = (value?: number | null): CoachConfidenceLevel => {
  if (typeof value !== "number" || Number.isNaN(value)) return "medium";
  if (value >= 0.7) return "high";
  if (value >= 0.4) return "medium";
  return "low";
};

const formatRecentMessages = (messages?: CoachMessage[]): string => {
  if (!messages || !messages.length) return "N/A";
  return messages
    .slice(-10)
    .map((m) => `${m.role === "assistant" ? "Coach" : m.role === "user" ? "User" : "System"}: ${m.content.slice(0, 220)}`)
    .join("\n");
};

const buildPrompt = (payload: CoachChatRequest) => {
  const confidence = confidenceFromNumber(payload.analysisContext?.confidence);
  const chain = payload.analysisContext?.chain?.join(" → ") || "未設定";
  const nextAction = payload.analysisContext?.nextAction || "次の練習内容は未設定";
  const primary = payload.analysisContext?.primaryFactor || "テーマ未設定";
  const summary = payload.summaryText?.slice(0, 600) || "前回要約なし";
  const profile = payload.userProfileSummary || "ユーザープロフィール情報なし";
  const recent = formatRecentMessages(payload.recentMessages);
  const toneInstruction =
    confidence === "high"
      ? "断定的かつ行動重視で提示する。"
      : confidence === "medium"
        ? "仮説であることを示しつつ『まずは』で始まる提案にする。"
        : "参考推定として柔らかく、観察と次回動画で確認すべき1点を示す。";

  const analysisContext = `現在の最重要テーマ: ${primary}
因果チェーン: ${chain}
次の練習アクション: ${nextAction}
confidence: ${confidence} (${payload.analysisContext?.confidence ?? "N/A"})
診断サマリ: ${payload.analysisContext?.summary || "N/A"}
スイング型: ${payload.analysisContext?.swingTypeHeadline || "N/A"}`;

  const ask =
    payload.mode === "initial"
      ? "初回メッセージを生成してください。構成: 1) 現状評価 2) 因果チェーン要約 3) 次の練習アクション 4) 会話への問いかけ。"
      : "最新のユーザー発話に1つのアクションで応答し、必ず次の練習 or 次回動画撮影で確認できるチェックポイントを1つ示す。";

  return `
【SystemPersona】
${payload.systemPersona || DEFAULT_PERSONA}

【UserProfileSummary】
${profile}

【CurrentAnalysisContext】
${analysisContext}

【ThreadSummary（要約のみ）】
${summary}

【RecentMessages（新しい順）】
${recent}

${toneInstruction}
${ask}

制約:
- 改善点は1つだけ。
- primaryFactorから逸脱しない。
- confidenceがlowの場合は「参考推定」「次回動画で確認」を含める。
- 返答は日本語で4〜6文以内。
- 行動や次の動画撮影で見るポイントを必ず1つ入れる。
`;
};

const buildFallback = (payload: CoachChatRequest) => {
  const confidence = confidenceFromNumber(payload.analysisContext?.confidence);
  const primary = payload.analysisContext?.primaryFactor || "スイングの再現性";
  const chain = payload.analysisContext?.chain?.join(" → ") || "原因とミスの関係を特定中";
  const action = payload.analysisContext?.nextAction || "ハーフスイングでフェース向きを一定に保つ練習を10球";
  const question =
    confidence === "low"
      ? "次の動画ではどの場面で違和感があるか教えてください。"
      : "次の練習で意識できそうか、気になる場面があれば教えてください。";

  return `現在フォーカスするのは「${primary}」です。因果は ${chain} と見ています。まずは ${action} を1セットだけ試してください。${
    confidence === "low" ? "推定精度は低めなので、次回の動画でもう一度確認しましょう。" : "この1点だけを守れば軌道とフェースが揃いやすくなります。"
  } ${question}`;
};

export async function POST(req: Request) {
  try {
    const payload = (await req.json().catch(() => ({}))) as CoachChatRequest;
    const persona = payload.systemPersona || DEFAULT_PERSONA;

    if (!client.apiKey) {
      return NextResponse.json({ message: buildFallback(payload) }, { status: 200 });
    }

    const prompt = buildPrompt(payload);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: payload.mode === "initial" ? 0.4 : 0.35,
      max_tokens: 420,
      messages: [
        { role: "system", content: persona },
        {
          role: "system",
          content:
            "厳守: (1) 改善は常に1つ。 (2) primaryFactorに紐づける。 (3) 次の練習・次回動画で確認するチェックポイントを入れる。 (4) confidenceがlowなら参考推定として扱う。",
        },
        { role: "user", content: prompt },
      ],
    });

    const aiMessage = completion.choices?.[0]?.message?.content?.trim();
    const message = aiMessage && aiMessage.length > 0 ? aiMessage : buildFallback(payload);

    return NextResponse.json({ message }, { status: 200 });
  } catch (error) {
    console.error("[coach-chat]", error);
    return NextResponse.json({ message: "コーチとの会話でエラーが発生しました。少し時間を空けて再度お試しください。" }, { status: 200 });
  }
}
