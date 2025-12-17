import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CoachChatRequest, CoachConfidenceLevel, CoachMessage } from "@/app/coach/types";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_PERSONA =
  "あなたはPGAティーチングプロ相当の専属AIゴルフコーチです。常に前向きで「褒めて伸ばす」スタンスを保ち、まず良い点を1つ短く認めたうえで、改善テーマを1つに絞って指導してください。診断結果を踏まえ、専門用語（フェースtoパス、ダイナミックロフト、アタックアングル、シャローイング、Pポジション等）を積極的に使い、再現性の根拠（クラブパス/フェース/回旋/地面反力/リリース機序）まで踏み込んで説明してください。メインの改善テーマは1つに絞るが、そのテーマを深掘りして「なぜ起きるか」「どう確認するか」「どう矯正するか」を具体的に示します。";

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

const formatVisionFramesMeta = (frames?: Array<{ url: string; timestampSec?: number; label?: string; frameIndex?: number }>) => {
  if (!frames?.length) return "N/A";
  return frames
    .slice(0, 6)
    .map((f, idx) => {
      const ts = typeof f.timestampSec === "number" ? `${f.timestampSec.toFixed(2)}s` : "ts:N/A";
      const stage = f.label ? ` ${f.label}` : "";
      const i = typeof f.frameIndex === "number" ? `#${f.frameIndex}` : "";
      return `frame${idx + 1}${stage}${i}@${ts}`;
    })
    .join(", ");
};

const buildPrompt = (payload: CoachChatRequest) => {
  const confidence = confidenceFromNumber(payload.analysisContext?.confidence);
  const chain = payload.analysisContext?.chain?.join(" → ") || "未設定";
  const nextAction = payload.analysisContext?.nextAction || "次の練習内容は未設定";
  const primary = payload.analysisContext?.primaryFactor || "テーマ未設定";
  const summary = payload.summaryText?.slice(0, 600) || "前回要約なし";
  const profile = payload.userProfileSummary || "ユーザープロフィール情報なし";
  const recent = formatRecentMessages(payload.recentMessages);
  const framesMeta = formatVisionFramesMeta(payload.visionFrames);
  const latestUserMessage = payload.userMessage?.slice(0, 400) || "";
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
スイング型: ${payload.analysisContext?.swingTypeHeadline || "N/A"}
フレーム参照: ${payload.visionFrames?.length ? `ON (${framesMeta})` : "OFF"}`;

  const visionRule = payload.visionFrames?.length
    ? "重要: このリクエストにはスイングのフレーム画像が含まれます。画像が与えられているのに『画像を確認できない』と言うのは禁止。冒頭に必ず「画像参照ログ」を置き、各フレームについて(1)何のフレームか(ラベル/時刻) (2)手元が見えるか(見える/一部隠れ/ブレ/画角外) (3)判断可否(可/不可)と理由 を1行で列挙する。そのうえで、見える範囲で結論を出す。判断できない場合は『何が見えないか』と『必要な撮影条件（正面/後方/高さ/インパクト周辺のフレームが手元を含む等）』を具体的に述べる。"
    : "画像は与えられていないので、一般論に寄りすぎない範囲で仮説として回答し、不足情報があれば質問する。";

  const ask = (() => {
    if (!payload.detailMode) {
      return payload.mode === "initial"
        ? "初回メッセージを生成。構成: 1) 1行結論 2) 主要原因（専門用語OK） 3) ドリル1つ（回数/狙い） 4) 次回動画チェックポイント1つ 5) 質問1つ。"
        : "最新のユーザー発話に対し、短めに要点回答。必ずドリル1つとチェックポイント1つを含める。";
    }
    return payload.mode === "initial"
      ? "初回メッセージを生成。構成: 1) 1行結論 2) 症状→メカニズム（専門用語OK） 3) 具体ドリル2つ（回数/狙い） 4) 次回動画チェックポイント2つ（P位置/フェース/パス等） 5) 追加で聞くべき質問1つ。"
      : "最新のユーザー発話に対し、専門的に深掘りしつつ実行可能な提案で応答。必ずドリル2つとチェックポイント2つを含める。";
  })();

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

【最新のユーザー質問/要望】
${latestUserMessage || "（直近の質問なし）"}

${toneInstruction}
${ask}
${visionRule}

制約:
- まずユーザー質問に1文で直接答える。答えられない場合はその旨を簡潔に伝える。
- メインの改善テーマは1つに絞り、primaryFactorから逸脱しない（ただし深掘りは歓迎）。
- confidenceがlowの場合は「参考推定」「次回動画で確認」を必ず含める。
- 返答は日本語。見出し＋箇条書きで読みやすく。
- 通常モード: 目安 120〜700文字、ドリル1つ＋チェックポイント1つ。
- 詳細モード: 目安 300〜2200文字、ドリル2つ＋チェックポイント2つ。
- フレーム参照ONの場合: 画像で観察できる事実（手元/フェース/体の向き/軌道の傾向など）を根拠として必ず1つ挙げる。見えない場合は見えないと明言する。
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

    const baseModel = process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";
    const detailedModel = process.env.OPENAI_COACH_MODEL_DETAILED || baseModel;
    const hasVision = !!payload.visionFrames?.length;
    const model = payload.detailMode || hasVision ? detailedModel : baseModel;
    const maxTokens = payload.detailMode || hasVision ? 900 : 420;

    const maxVisionFrames = Number(process.env.OPENAI_COACH_VISION_MAX_FRAMES ?? 6);
    const frames = (payload.visionFrames ?? []).slice(0, Number.isFinite(maxVisionFrames) ? maxVisionFrames : 4);

    const userContent: any = [
      { type: "text", text: prompt },
      ...frames.map((f) => ({
        type: "image_url",
        image_url: { url: f.url },
      })),
    ];

    const completion = await client.chat.completions.create({
      model,
      temperature: payload.mode === "initial" ? 0.45 : 0.4,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: persona },
        {
          role: "system",
          content:
            payload.detailMode
              ? "厳守: (1) 最新のユーザー質問にまず1文で答える（できない場合はできないと述べる）。 (2) 良い点を1つ短く褒める。 (3) メインテーマは1つ（primaryFactorに紐づける）が、原因・根拠・矯正は深掘りする。 (4) ドリル2つ（回数/狙い）と次回動画チェックポイント2つ（合格条件）を必ず入れる。 (5) confidenceがlowなら参考推定として扱い、次回動画での確認点を明示する。"
              : "厳守: (1) 最新のユーザー質問にまず1文で答える（できない場合はできないと述べる）。 (2) 良い点を1つ短く褒める。 (3) メインテーマは1つ（primaryFactorに紐づける）。 (4) ドリル1つ（回数/狙い）と次回動画チェックポイント1つ（合格条件）を必ず入れる。 (5) confidenceがlowなら参考推定として扱い、次回動画での確認点を明示する。",
        },
        { role: "user", content: userContent },
      ],
    });

    const aiMessage = completion.choices?.[0]?.message?.content?.trim();
    const message = aiMessage && aiMessage.length > 0 ? aiMessage : buildFallback(payload);

    const body: any = { message };
    if (process.env.NODE_ENV !== "production") {
      body.debug = { model, hasVision, framesSent: frames.length, detailMode: !!payload.detailMode };
    }
    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    console.error("[coach-chat]", error);
    return NextResponse.json({ message: "コーチとの会話でエラーが発生しました。少し時間を空けて再度お試しください。" }, { status: 200 });
  }
}
