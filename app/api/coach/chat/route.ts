import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CoachChatRequest, CoachConfidenceLevel, CoachMessage } from "@/app/coach/types";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_PERSONA =
  "あなたはPGAティーチングプロ相当の専属AIゴルフコーチです。常に前向きで「褒めて伸ばす」スタンスを保ち、まず良い点を1つ短く認めたうえで、改善テーマを1つに絞って指導してください。診断結果を踏まえ、専門用語（フェースtoパス、ダイナミックロフト、アタックアングル、シャローイング、Pポジション等）を積極的に使い、再現性の根拠（クラブパス/フェース/回旋/地面反力/リリース機序）まで踏み込んで説明してください。メインの改善テーマは1つに絞るが、そのテーマを深掘りして「なぜできていないのか（直接原因/背景原因）」「どう確認するか（切り分けテスト）」「どう矯正するか」を具体的に示します。";

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

const isDiagnosticQuestion = (text?: string | null): boolean => {
  const t = (text || "").trim();
  if (!t) return false;
  return /できますか|できてる|できていますか|できてない|でしょうか|ですか|判定|判断|見て|確認|解析|分析|教えて|原因|なぜ|どうして|どこまで|どこから|低い|高い|早い|遅い|開く|閉じる|入る|外れる|シャロー|shallow|オンプレーン|プレーン|インサイド|アウトサイド|フェース|パス|ハンドファースト|リリース|タメ|体の開き/i.test(
    t
  );
};

const isWhyQuestion = (text?: string | null): boolean => {
  const t = (text || "").trim();
  if (!t) return false;
  return /なぜ|どうして|理由|原因|メカニズム|機序/i.test(t);
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
  const focusPhase = payload.focusPhase || null;
  const phaseContextText = payload.phaseContextText?.slice(0, 1200) || "N/A";
  const hasVision = !!payload.visionFrames?.length;
  const wantsGranularBreakdown = (payload.mode !== "initial" && !!payload.userMessage?.trim()) || isDiagnosticQuestion(payload.userMessage);
  const asksWhy = isWhyQuestion(payload.userMessage);
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
フェーズ指定: ${focusPhase ?? "なし"}
フレーム参照: ${payload.visionFrames?.length ? `ON (${framesMeta})` : "OFF"}`;

  const phaseSection = focusPhase
    ? `
【PhaseFocus（ユーザー質問の対象フェーズ）】
${focusPhase}

【PhaseEvaluationContext（そのフェーズの評価抜粋）】
${phaseContextText}
`
    : "";

  const granularBreakdownRule = wantsGranularBreakdown
    ? `
追加ルール（切り分け回答）:
- 「ある程度できている」で終わるのは禁止。必ず「どこまでOKで、どこからNGか」を切り分ける。
- 文章スタイル: Markdown見出し（###）や「-」箇条書きで区切らず、口語寄りの自然な文章でつなげる（短い段落で改行はOK）。
- 入れる情報の順番（この順に“文章の流れ”として含める。ラベルは文中の括弧程度に留めてOK）:
  1) 判定（4段階: OK / ほぼOK / 一部NG / NG）＋confidence（high/medium/low）＋その理由（1文）
  2) できている範囲（通常:最大2点 / 詳細:最大3点）
  3) できていない範囲（通常:最大2点 / 詳細:最大3点）
  4) 境界（どこから崩れ始めるか）: OK→NGに切り替わる「変化点」を特定（例: Top→Downの序盤/中盤/終盤、または address→top→downswing→impact→finish）。必ず frameIndex(#) を添える
  5) なぜできていないか（原因と機序）: 「直接原因→背景原因→切り分けテスト」の順で、それぞれ1〜2文で“文章として”説明する（専門用語OK）
  6) 修正ドリル（通常:1個 / 詳細:2個）: 「できていない範囲」を改善する最短手段に直結させる（メカニズムと対応づける）
  7) 切り分けチェック（次回動画で確認する1点）: 何を見れば「OK側/NG側」を判別できるかを1つだけ具体化
- 判定ラベルの定義（必ずこの意味で使う）:
  ・OK: 対象の動きが全区間で再現できている（致命的な崩れなし）
  ・ほぼOK: 大半はOKだが、終盤/一部フレームで軽微な崩れがある（プレー影響は小〜中）
  ・一部NG: フェーズ内に「OK区間」と「NG区間」が混在し、ミスにつながる崩れが観察できる（プレー影響は中）
  ・NG: フェーズ全体で狙いの動きが作れておらず、ミスの主因になっている可能性が高い
- 根拠の書き方:
  ・画像あり: 各指摘に必ず frameIndex(#) を付け、観察した事実（手元高さ/シャフト角/フェース向き/体の開き等）を書く
  ・画像なし: PhaseEvaluationContext または ユーザー申告（ボール傾向/違和感/ミス）を根拠にし、「仮説/要確認」を明示する
`
    : "";

  const whyDeepDiveRule = asksWhy
    ? `
追加ルール（なぜ/理由の専門解説）:
- ユーザーが「なぜ/どうして/原因」を聞いている場合、結論→原因（直接/背景）→切り分け（テスト or 観察ポイント）の順で答える。
- 「なぜNGか（結果の説明）」で終わらせず、「なぜその動きになってしまうのか（できていない理由）」を必ず1文で明示する。
`
    : "";

  const visionRule = hasVision
    ? `重要: このリクエストにはスイングのフレーム画像が含まれます。画像が与えられているのに『画像を確認できない』と言うのは禁止。冒頭に必ず「画像参照ログ」を置き、各フレームについて(1) frameIndex（#番号）とラベル/時刻 (2)手元が見えるか(見える/一部隠れ/ブレ/画角外) (3)判断可否(可/不可)と理由 を1行で列挙する。そのうえで、見える範囲で結論を出す。
注意: 「フレーム1/2/3」は送付画像の順番で、元動画の番号ではありません。元動画の番号は frameIndex（#）に従ってください。
判断できない場合は『何が見えないか』と『必要な撮影条件（正面/後方/高さ/該当フェーズ周辺のフレームが手元を含む等）』を具体的に述べる。
${focusPhase ? "追加制約: PhaseFocus が指定されている場合、回答の根拠は PhaseEvaluationContext と該当フェーズのフレーム観察を最優先にする。別フェーズの断定はしない（必要なら「別フェーズの可能性」として短く補足）。" : ""}`
    : "画像は与えられていないので、一般論に寄りすぎない範囲で仮説として回答し、不足情報があれば質問する。";

  const ask = (() => {
    if (!payload.detailMode) {
      return payload.mode === "initial"
        ? "初回メッセージを生成。構成: 1) 1行結論 2) 主要原因（専門用語OK） 3) ドリル1つ（回数/狙い） 4) 次回動画チェックポイント1つ 5) 質問1つ。"
        : asksWhy
          ? "最新のユーザー発話に対し、短めに要点回答。ただし『なぜ』が含まれる場合は「直接原因1行＋背景原因1行＋切り分けテスト1行」を必ず入れる。必ずドリル1つとチェックポイント1つを含める。"
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

${phaseSection}

【ThreadSummary（要約のみ）】
${summary}

【RecentMessages（新しい順）】
${recent}

【最新のユーザー質問/要望】
${latestUserMessage || "（直近の質問なし）"}

${toneInstruction}
${ask}
${visionRule}
${granularBreakdownRule}
${whyDeepDiveRule}

制約:
- まずユーザー質問に1文で直接答える。答えられない場合はその旨を簡潔に伝える。
- メインの改善テーマは必ず「最新のユーザー質問」に合わせて1つに絞る（primaryFactorは文脈として参照してよい）。
- PhaseFocusが指定されている場合、必ずそのフェーズに寄せて説明する（別フェーズへ話題が飛ばない）。
- confidenceがlowの場合は「参考推定」「次回動画で確認」を必ず含める。
- 返答は日本語。口語寄りで自然につなげる（短い段落区切りはOKだが、Markdown見出し（###）や「-」箇条書きは使わない）。
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
    // Vision frames can be sent even in cost-saving mode; do not automatically switch models just because images exist.
    const useDetailedModel = !!payload.detailMode;
    const model = useDetailedModel ? detailedModel : baseModel;
    const maxTokens = useDetailedModel ? 900 : 420;

    const maxVisionFrames = Number(process.env.OPENAI_COACH_VISION_MAX_FRAMES ?? 6);
    const frames = (payload.visionFrames ?? []).slice(0, Number.isFinite(maxVisionFrames) ? maxVisionFrames : 4);

    type OpenAIRequestMessageContent =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } };

    const userContent: OpenAIRequestMessageContent[] = [
      { type: "text", text: prompt },
      ...frames.map((f) => ({
        type: "image_url" as const,
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

    const body: {
      message: string;
      debug?: {
        model: string;
        hasVision: boolean;
        framesSent: number;
        detailMode: boolean;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
    } = { message };
    if (process.env.NODE_ENV !== "production") {
      body.debug = {
        model,
        hasVision,
        framesSent: frames.length,
        detailMode: !!payload.detailMode,
        usage: completion.usage
          ? {
              prompt_tokens: completion.usage.prompt_tokens,
              completion_tokens: completion.usage.completion_tokens,
              total_tokens: completion.usage.total_tokens,
            }
          : undefined,
      };
    }
    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    console.error("[coach-chat]", error);
    return NextResponse.json({ message: "コーチとの会話でエラーが発生しました。少し時間を空けて再度お試しください。" }, { status: 200 });
  }
}
