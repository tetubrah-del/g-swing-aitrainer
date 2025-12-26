// app/api/golf/swing-type/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CausalImpactExplanation, SwingAnalysis, SwingTypeDetail, SwingTypeKey, SwingTypeLLMResult, SwingTypeMatch } from "@/app/golf/types";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SWING_TYPE_LABELS: Record<SwingTypeKey, string> = {
  body_turn: "ボディターン型",
  arm_rotation: "アームローテーション型",
  shallow: "シャローイング型",
  steep: "スティープ型",
  hand_first: "ハンドファースト型",
  sweep: "スウィープ型",
  one_plane: "ワンプレーン型",
  two_plane: "ツープレーン型",
};

type RequestPayload = {
  analysis?: SwingAnalysis;
  meta?: unknown;
  causalImpact?: CausalImpactExplanation | null;
  forceFallback?: boolean;
};

function clampScore(n: number) {
  return Math.min(1, Math.max(0, n));
}

function buildPrompt(body: RequestPayload, fallback: SwingTypeLLMResult) {
  const analysis = body.analysis;
  const meta = body.meta;
  const causal = body.causalImpact;
  const trimmed = analysis ? JSON.stringify(analysis).slice(0, 2500) : "N/A";
  const causalText = causal ? JSON.stringify(causal).slice(0, 500) : "N/A";
  const fallbackText = JSON.stringify(fallback).slice(0, 1200);

  return `
あなたはプロゴルフコーチ兼、ゴルフスイング理論を体系化できる専門家です。
以下のユーザーのスイング診断結果をもとに、

1. スイング型一覧の中から「近い型」を判定し
2. 各スイング型の解説コンテンツを生成し
3. ユーザーが「この型を目指したい」と思えるよう導き
4. その型を目標にAIコーチへ相談するCTAを作成してください。

---

【前提条件】
・初心者〜中上級者が理解できる言葉で説明する
・特定の型を絶対視せず「向き・不向き」の文脈で説明する
・否定的・断定的な表現は避ける
・教育 → 納得 → 行動（CTA）の流れを意識する
・すべて JSON 形式で出力する

---

【スイング型一覧（固定）】
以下の8種類のスイング型のみを使用してください。

- body_turn（ボディターン型）
- arm_rotation（アームローテーション型）
- shallow（シャローイング型）
- steep（スティープ型）
- hand_first（ハンドファースト型）
- sweep（スウィープ型）
- one_plane（ワンプレーン型）
- two_plane（ツープレーン型）

---

【入力情報】
診断結果(JSON): ${trimmed}
メタ情報: ${meta ? JSON.stringify(meta).slice(0, 400) : "N/A"}
最重要因子: ${causalText}

【出力フォーマット（JSON）】
${fallbackText}

出力は上記構造に厳密に従い、すべてJSONで返してください。`;
}

const STATIC_DETAILS: Record<SwingTypeKey, SwingTypeDetail> = {
  body_turn: {
    title: "ボディターン型",
    shortDescription: "体幹の回転でクラブを運び、フェース管理をシンプルにするスタイル。",
    overview:
      "下半身から上半身へ順序よく回転を伝え、クラブを体の正面で運ぶ考え方。骨盤と胸の回転を軸にすることで軌道が安定しやすく、フェースローテーションを最小限に抑えられる。スイングテンポと軸を守ることで再現性が高まり、曲がり幅を抑えやすい。",
    characteristics: ["体幹主導で回転を作る", "フェースローテーションを抑えめに管理", "軸を保ったままフィニッシュまで回す"],
    recommendedFor: ["方向性を安定させたいゴルファー", "フェース管理をシンプルにしたい中級者以上"],
    advantages: ["方向性が安定しやすい", "再現性の高いインパクトを作りやすい", "力みを抑えやすい"],
    disadvantages: ["回転不足になるとプッシュ・スライスが出やすい", "柔軟性が低いと可動域が不足する"],
    commonMistakes: ["上半身だけで回そうとする", "回転が止まって手先で合わせる"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  arm_rotation: {
    title: "アームローテーション型",
    shortDescription: "腕のローテーションでフェース向きを作り、球筋を操作するスタイル。",
    overview:
      "腕の回旋とリストワークを活用してフェース向きと入射をコントロールする考え方。体の回転に加えて前腕のローテーションを活かすことで、球筋を打ち分けたり高さを調整しやすい。手元の感覚が求められるため、リズムとタイミングの一貫性が重要になる。",
    characteristics: ["前腕の回旋を積極的に使う", "手元の感覚でフェースを合わせる", "体の回転と腕のタイミングを同期"],
    recommendedFor: ["球筋を操作したいゴルファー", "手元の感覚に自信があるプレーヤー"],
    advantages: ["球筋の打ち分けがしやすい", "高さやスピン量の調整がしやすい"],
    disadvantages: ["タイミングが崩れると曲がりが大きくなる", "リリースの暴れで再現性が落ちやすい"],
    commonMistakes: ["体の回転が止まり手打ちになる", "ローテーション過多で引っかける"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  shallow: {
    title: "シャローイング型",
    shortDescription: "ダウンスイングでクラブを寝かせ、入射を緩やかにするスタイル。",
    overview:
      "切り返しでクラブをやや寝かせ、インサイドから浅い入射角でボールをとらえる考え方。地面反力や下半身リードと相性が良く、スピン量のコントロールやドロー系の球筋を作りやすい。過度なシャローはダフリ・プッシュを生むため、入射管理が鍵となる。",
    characteristics: ["切り返しでクラブを寝かせる動き", "インサイドインに近い入射", "下半身リードと相性が良い"],
    recommendedFor: ["入射を緩やかにして飛距離を伸ばしたい人", "ドロー系の球筋を安定させたい中級者以上"],
    advantages: ["スピンコントロールがしやすい", "ダフリに強くなる", "飛距離アップに繋がりやすい"],
    disadvantages: ["やりすぎるとプッシュ・ダフリが出る", "タイミングが遅れると右に出やすい"],
    commonMistakes: ["切り返しで寝かせ過ぎてフェースが開く", "体の回転が止まり手元で調整する"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  steep: {
    title: "スティープ型",
    shortDescription: "やや立ち気味のプレーンでダウンブローに打ち込むスタイル。",
    overview:
      "クラブを立てて振り、ダウンブローでボールをとらえる考え方。フェース管理をしやすく、ライン出しや風に強いショットと相性が良い。過度に立つとカット軌道やダフリ・トップの原因になるため、回転量とのバランスを取ることが重要。",
    characteristics: ["立ち気味のプレーン", "ややダウンブローの入射", "ライン出ししやすい軌道"],
    recommendedFor: ["方向性重視のプレーヤー", "低弾道・風に強い球を打ちたい人"],
    advantages: ["ライン出ししやすい", "フェースが開きにくい", "バンカーやラフでも抜けが良い"],
    disadvantages: ["立ち過ぎるとカット・スライスが出やすい", "ダフリやトップのリスク"],
    commonMistakes: ["体が突っ込みプレーンがさらに立つ", "リリースが早くなりトップする"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  hand_first: {
    title: "ハンドファースト型",
    shortDescription: "インパクトで手元を先行させ、ロフトと入射をコントロールするスタイル。",
    overview:
      "インパクトでグリップエンドが先行し、ロフトを立てて打つ考え方。フェース管理が安定しやすく、スピン量の調整や弾道コントロールに役立つ。過度になるとプッシュ・シャンクのリスクがあり、下半身リードとハンドファーストのタイミングが鍵。",
    characteristics: ["手元先行のインパクト", "ロフトを立てて打つ", "フェース向きを抑えめに管理"],
    recommendedFor: ["方向性とスピン量を安定させたい人", "風に強い弾道を作りたい中級者以上"],
    advantages: ["フェース管理が安定", "スピン・高さのコントロールがしやすい", "左のミスを抑えやすい"],
    disadvantages: ["やりすぎるとプッシュやシャンクが出る", "手首・前腕に負担がかかりやすい"],
    commonMistakes: ["体が止まって手元だけ先行させる", "ロフトを立てすぎて刺さる"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  sweep: {
    title: "スウィープ型",
    shortDescription: "浅い入射で払い打つようにボールをとらえるスタイル。",
    overview:
      "インパクトで芝を大きく削らず、浅い入射で払うように打つ考え方。フェアウェイウッドやロングアイアンと相性が良く、方向性と飛距離のバランスを取りやすい。入射が浅すぎるとトップやプッシュのリスクがあるため、下半身リードと前傾維持が重要。",
    characteristics: ["浅い入射で払い打つ", "前傾を保ちつつ低い打点で抜ける", "フェアウェイウッドと相性が良い"],
    recommendedFor: ["フェアウェイウッドを安定させたい人", "ダフリを減らしたい初中級者"],
    advantages: ["払い打ちでダフリに強い", "ミート率を上げやすい", "ウッド類で安定しやすい"],
    disadvantages: ["浅すぎるとトップしやすい", "フェースが開きやすい"],
    commonMistakes: ["体が起き上がりトップする", "入射が浅すぎてプッシュアウトする"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  one_plane: {
    title: "ワンプレーン型",
    shortDescription: "アドレス〜フィニッシュまでプレーンの変化を少なくするスタイル。",
    overview:
      "バックスイングとダウンスイングのプレーン差を小さく保ち、同じ面上で振る考え方。体の回転とクラブの動きが一体化しやすく、再現性が高い。過度に同一プレーンを意識しすぎると窮屈になり、スピンや高さが出にくいことがある。",
    characteristics: ["プレーンの変化を抑える", "体とクラブの一体感を重視", "回転軸をぶらさずに振る"],
    recommendedFor: ["再現性を重視するゴルファー", "体幹主導でコンパクトに振りたい人"],
    advantages: ["ミート率が上がりやすい", "方向性が安定しやすい", "シンプルな動きで覚えやすい"],
    disadvantages: ["高さ・スピン量が出にくいことがある", "窮屈なトップになりやすい"],
    commonMistakes: ["腕を体に貼り付けすぎて窮屈になる", "プレーンを守ろうとして回転が減る"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
  two_plane: {
    title: "ツープレーン型",
    shortDescription: "バックスイングとダウンスイングでプレーンを切り替え、インパクトを合わせるスタイル。",
    overview:
      "バックスイングはややアップライトに上げ、ダウンでプレーンを切り替えてインパクトを合わせる考え方。可動域が活きるため飛距離を出しやすく、球筋操作の幅も広がる。タイミングが合わないと再現性が落ちるため、リズムと切り返しの精度が鍵となる。",
    characteristics: ["バックスイングはアップライト", "ダウンでプレーンを切り替える", "リズムとタイミングが重要"],
    recommendedFor: ["可動域が広いゴルファー", "高さや球筋の打ち分けをしたい人"],
    advantages: ["飛距離を出しやすい", "球筋操作の自由度が高い", "ドロー・フェードを打ち分けやすい"],
    disadvantages: ["タイミングが合わないと再現性が落ちる", "プレーンの切り替えが難しい"],
    commonMistakes: ["切り返しで間が取れず軌道が乱れる", "プレーンを切り替えすぎてトップ/ダフリが出る"],
    cta: {
      headline: "このスイングを目指したい方へ",
      message:
        "このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。",
      buttonText: "この型を目標にAIコーチに相談する",
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildFallbackResult(analysis?: SwingAnalysis | null, _causalImpact?: CausalImpactExplanation | null): SwingTypeLLMResult {
  if (!analysis) {
    return {
      swingTypeMatch: [
        { type: "body_turn", label: SWING_TYPE_LABELS.body_turn, matchScore: 0.6, reason: "体幹主体のリズムが基準" },
        { type: "hand_first", label: SWING_TYPE_LABELS.hand_first, matchScore: 0.52, reason: "インパクトでの手元先行傾向" },
        { type: "shallow", label: SWING_TYPE_LABELS.shallow, matchScore: 0.45, reason: "入射を緩めたい余地" },
      ],
      swingTypeDetails: STATIC_DETAILS,
      nextCoachingContext: {
        description: "目標のスイング型に向けた継続コーチング用コンテキスト",
        promptInstruction:
          "このユーザーは特定のスイング型を目標にしています。現在のスイングと目標の型を比較し、どこが近く、どこを優先的に直すべきかを具体的に示してください。やりすぎると逆効果になる点にも触れ、ユーザーのレベルに合った現実的な改善ステップを提示してください。",
      },
      source: "fallback",
      note: "OPENAI_API_KEY未設定のためルールベース結果",
    };
  }

  const phases = analysis.phases;
  const downswingScore = phases.downswing?.score ?? 0;
  const impactScore = phases.impact?.score ?? 0;
  const summary = analysis.summary ?? "";
  const textPool = Object.values(phases)
    .map((p) => [...(p.good || []), ...(p.issues || []), ...(p.advice || [])].join("／"))
    .join("／")
    .concat(summary);

  const has = (keyword: string | RegExp) => (typeof keyword === "string" ? textPool.includes(keyword) : keyword.test(textPool));

  const matches: SwingTypeMatch[] = [];

  const bodyScore = clampScore((downswingScore + impactScore) / 40);
  matches.push({
    type: "body_turn",
    label: SWING_TYPE_LABELS.body_turn,
    matchScore: 0.5 + bodyScore * 0.4,
    reason: "下半身リードと体幹回転の割合が高いため",
  });

  const handScore = has(/ハンドファースト|右手を我慢|手元先行/) ? 0.6 : 0.35;
  matches.push({
    type: "hand_first",
    label: SWING_TYPE_LABELS.hand_first,
    matchScore: handScore,
    reason: "インパクトで手元先行を意識する場面があるため",
  });

  const shallowScore = has(/シャロー|寝かせ|入射を緩め/) ? 0.55 : 0.35;
  matches.push({
    type: "shallow",
    label: SWING_TYPE_LABELS.shallow,
    matchScore: shallowScore,
    reason: "入射を緩めて当てたいニーズが見えるため",
  });

  const steepScore = has(/アップライト|上から|立てる/) ? 0.55 : 0.32;
  matches.push({
    type: "steep",
    label: SWING_TYPE_LABELS.steep,
    matchScore: steepScore,
    reason: "やや立ち気味のプレーンを指向する傾向が見えるため",
  });

  const armScore = has(/ローテーション|腕主導|リストワーク/) ? 0.55 : 0.35;
  matches.push({
    type: "arm_rotation",
    label: SWING_TYPE_LABELS.arm_rotation,
    matchScore: armScore,
    reason: "腕や前腕の回旋でフェースを合わせる場面があるため",
  });

  const sweepScore = has(/払い打ち|スウィープ|ダフリを減/) ? 0.5 : 0.3;
  matches.push({
    type: "sweep",
    label: SWING_TYPE_LABELS.sweep,
    matchScore: sweepScore,
    reason: "払い打ちでダフリを抑えたい意図があるため",
  });

  const onePlaneScore = has(/一体感|一体/) ? 0.48 : 0.32;
  matches.push({
    type: "one_plane",
    label: SWING_TYPE_LABELS.one_plane,
    matchScore: onePlaneScore,
    reason: "体とクラブの一体感を重視する記述があるため",
  });

  const twoPlaneScore = has(/アップライト|切り替え/) ? 0.45 : 0.28;
  matches.push({
    type: "two_plane",
    label: SWING_TYPE_LABELS.two_plane,
    matchScore: twoPlaneScore,
    reason: "バックスイングとダウンでプレーンを変える余地があるため",
  });

  const sorted = matches.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);

  return {
    swingTypeMatch: sorted,
    swingTypeDetails: STATIC_DETAILS,
    nextCoachingContext: {
      description: "目標のスイング型に向けた継続コーチング用コンテキスト",
      promptInstruction:
        "このユーザーは特定のスイング型を目標にしています。現在のスイングと目標の型を比較し、どこが近く、どこを優先的に直すべきかを具体的に示してください。やりすぎると逆効果になる点にも触れ、ユーザーのレベルに合った現実的な改善ステップを提示してください。",
    },
    source: "fallback",
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as RequestPayload;
    const fallback = buildFallbackResult(body.analysis, body.causalImpact);

    if (body.forceFallback === true || !client.apiKey) {
      return NextResponse.json(fallback, { status: 200 });
    }

    const prompt = buildPrompt(body, fallback);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 1200,
      temperature: 0.2,
    });

    const parsed =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (completion as any).choices?.[0]?.message?.parsed ?? completion.choices?.[0]?.message?.content;

    let candidate: SwingTypeLLMResult | null = null;
    if (parsed) {
      try {
        candidate = typeof parsed === "string" ? (JSON.parse(parsed) as SwingTypeLLMResult) : (parsed as SwingTypeLLMResult);
      } catch {
        candidate = null;
      }
    }

    const result: SwingTypeLLMResult = {
      swingTypeMatch: candidate?.swingTypeMatch?.length ? candidate.swingTypeMatch : fallback.swingTypeMatch,
      swingTypeDetails: candidate?.swingTypeDetails ?? fallback.swingTypeDetails,
      nextCoachingContext: candidate?.nextCoachingContext ?? fallback.nextCoachingContext,
      source: "ai",
      note: candidate?.note,
    };

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[swing-type]", err);
    const fallback = buildFallbackResult(null, null);
    return NextResponse.json({ ...fallback, note: "AI generation failed; using fallback" }, { status: 200 });
  }
}
