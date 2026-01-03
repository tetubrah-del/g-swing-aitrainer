export type LevelEstimate = { label: string; detail: string };

export type RoundEstimateMetrics = {
  strokeRange: string;
  fwKeep: string;
  gir: string;
  ob: string;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function calibrateSwingScore(scoreRaw: number): number {
  const score = clamp(Number.isFinite(scoreRaw) ? scoreRaw : 0, 0, 100);
  const lerp = (x0: number, y0: number, x1: number, y1: number, x: number) =>
    y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  const calibrated =
    score <= 57
      ? lerp(0, 20, 57, 65, score)
      : lerp(57, 65, 100, 100, score);
  return clamp(Math.round(calibrated), 0, 100);
}

type PhaseKey = "address" | "backswing" | "top" | "downswing" | "impact" | "finish";
type PhaseLike = { score: number; good?: string[]; issues?: string[]; advice?: string[] };

const PHASE_LABEL: Record<PhaseKey, string> = {
  address: "アドレス",
  backswing: "バックスイング",
  top: "トップ",
  downswing: "ダウンスイング",
  impact: "インパクト",
  finish: "フィニッシュ",
};

export function estimateLevelFromScore(scoreRaw: number): LevelEstimate {
  const score = clamp(Number.isFinite(scoreRaw) ? scoreRaw : 0, 0, 100);
  if (score >= 90)
    return {
      label: "上級",
      detail:
        "全体の完成度が高く、動きの再現性が高いスイングです。良い点は、切り返し以降の体幹の回転が途切れにくく、インパクトでの当たり負けが少ないことです。一方で、わずかなフェース向きのズレやリリースのタイミング差が球筋に出やすく、弾道のばらつき要因になりやすい傾向があります。",
    };
  if (score >= 80)
    return {
      label: "中上級",
      detail:
        "全体のバランスが良く、スイングの形が崩れにくいタイプです。良い点は、トップ〜ダウンの動きが比較的スムーズで、ミート率につながる“体とクラブの同調”が見えやすいことです。課題は、切り返し付近でクラブの落ち方／フェース向きが一定になりきらず、方向性のブレが残りやすい点です。",
    };
  if (score >= 60)
    return {
      label: "中級",
      detail:
        "基本動作は安定しており、スイングの形としては十分にまとまっています。良い点は、アドレス〜トップまでの流れが大きく破綻せず、振り抜きまでのリズムが作れていることです。課題は、重心位置やトップ位置にわずかな差が出やすく、その影響が切り返し以降のクラブ軌道／フェース向きのばらつきとして現れやすい点です。",
    };
  if (score >= 45)
    return {
      label: "初級",
      detail:
        "スイングは成立しており、形の方向性も見えています。良い点は、フィニッシュまで振り切ろうとする意識があり、動作が途中で止まりにくいことです。課題は、アドレスの姿勢（前傾・重心）やグリップの一定感が揺れやすく、インパクトで当たり所とフェース向きが安定しにくい点です。",
    };
  return {
    label: "ビギナー",
    detail:
      "スイングの骨格を作っている段階で、動きの再現性はこれから伸びるタイプです。良い点は、クラブを振る動作自体はできており、改善に必要な“基準の形”を作れる余地が大きいことです。課題は、アドレス姿勢とテンポが毎回変わりやすく、トップ位置やインパクトの当たり所が揃いにくい点です。",
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function pickNotableIssues(phase: PhaseLike, max: number): string[] {
  const issues = normalizeList(phase.issues);
  if (!issues.length) return [];
  const priorityPatterns: RegExp[] = [
    /アウトサイドイン傾向が強い|アウトサイドイン（確定）/,
    /アウトサイドイン傾向が見られる|外から入りやすい傾向/,
    /アウトサイドイン/,
    /外から下り/,
    /カット軌道/,
    /早期伸展/,
    /骨盤.*前.*出/,
    /前傾.*起き/,
    /すくい打ち/,
    /体勢崩壊/,
    /早開き/,
    /上半身先行/,
  ];
  const prioritized = issues.filter((t) => priorityPatterns.some((p) => p.test(t)));
  const rest = issues.filter((t) => !prioritized.includes(t));
  return uniq([...prioritized, ...rest]).slice(0, max);
}

function safeScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.round(n), 0, 20);
}

export function buildLevelDiagnosis(params: {
  totalScore: number;
  phases?: Partial<Record<PhaseKey, PhaseLike>> | null;
}): LevelEstimate {
  const base = estimateLevelFromScore(calibrateSwingScore(params.totalScore));
  const phases = params.phases ?? null;
  if (!phases) return base;

  const keys = Object.keys(PHASE_LABEL) as PhaseKey[];
  const scored = keys
    .map((k) => ({ key: k, score: safeScore(phases[k]?.score), phase: phases[k] }))
    .filter((x) => x.phase != null);
  if (!scored.length) return base;

  scored.sort((a, b) => a.score - b.score);
  const weakest = scored.slice(0, 2);
  const strongest = [...scored].sort((a, b) => b.score - a.score).slice(0, 2);

  const strongestSummary = strongest
    .map(({ key, phase }) => {
      const goods = uniq(normalizeList(phase?.good)).slice(0, 1);
      const tail = goods.length ? `（${goods[0]}）` : "";
      return `${PHASE_LABEL[key]}では${tail ? tail.slice(1, -1) : "安定感が出ています"}`;
    })
    .join("、");

  const weakestSummary = weakest
    .map(({ key, phase }) => {
      const issues = pickNotableIssues((phase ?? { score: 0 }) as PhaseLike, 2);
      const tail = issues.length ? `（${issues.join("／")}）` : "";
      return `${PHASE_LABEL[key]}では${tail ? tail.slice(1, -1) : "改善余地が残ります"}`;
    })
    .join("、");

  const downswingIssues = phases.downswing ? pickNotableIssues(phases.downswing as PhaseLike, 2) : [];
  const impactIssues = phases.impact ? pickNotableIssues(phases.impact as PhaseLike, 2) : [];

  const causalHints: string[] = [];
  if (
    downswingIssues.some((t) =>
      /アウトサイドイン傾向が強い|アウトサイドイン傾向が見られる|アウトサイドイン（確定）|外から入りやすい傾向|アウトサイドイン|外から下り|カット軌道/.test(t)
    )
  ) {
    causalHints.push("ダウンスイングの軌道が乱れると、方向性（特に右への曲がり）や当たり負けにつながりやすいです。");
  }
  if (impactIssues.some((t) => /早期伸展|骨盤.*前.*出|前傾.*起き|スペース.*潰/.test(t))) {
    causalHints.push("インパクトでスペースが潰れると、手元が浮きやすく、打点とフェース向きが安定しにくくなります。");
  }

  const detail = [
    `${base.detail}`,
    ``,
    strongestSummary
      ? `良い傾向としては、${strongestSummary}あたりが土台になっています。`
      : `良い傾向は、現状の情報だけだと特定しきれませんでした。`,
    ``,
    weakestSummary
      ? `一方でスコアに直結しやすい課題は、${weakestSummary}です。ここを整えると、結果（球筋・当たり）の安定が出やすくなります。`
      : `一方で、現状の情報だけだと優先課題を特定しきれませんでした。`,
    ...(causalHints.length
      ? [
          ``,
          `理由をもう少し噛み砕くと、${causalHints.join(" ")}`,
        ]
      : []),
  ].join("\n");

  return { label: base.label, detail };
}

export function computeRoundFallbackFromScore(scoreRaw: number): RoundEstimateMetrics {
  const score = calibrateSwingScore(scoreRaw);

  // Calibrated for typical amateurs, anchored to analyzer score expectations:
  // - swing score ~50 -> ~110前後
  // - swing score ~65 -> ~90〜95
  // - swing score ~80 -> ~85前後
  // - swing score ~95 -> ~75前後
  // - swing score ~100 -> ~72前後
  const mid = (() => {
    const s = score;
    // Piecewise linear interpolation to align mid-score expectations.
    // Anchors: (0,135), (50,110), (65,93), (80,85), (95,75), (100,72)
    const lerp = (x0: number, y0: number, x1: number, y1: number, x: number) =>
      y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    if (s <= 50) return lerp(0, 135, 50, 110, s);
    if (s <= 65) return lerp(50, 110, 65, 93, s);
    if (s <= 80) return lerp(65, 93, 80, 85, s);
    if (s <= 95) return lerp(80, 85, 95, 75, s);
    return lerp(95, 75, 100, 72, s);
  })();
  const spread = 3;
  const low = clamp(mid - spread, 60, 140);
  const high = clamp(mid + spread, 60, 140);
  const lowInt = Math.round(low);
  const highInt = Math.max(lowInt, Math.round(high));
  const strokeRange =
    lowInt <= 72 ? (highInt <= 72 ? "アンダーパー" : `アンダーパー〜${highInt}`) : `${lowInt}〜${highInt}`;

  const fwKeep = clamp(25 + score * 0.35, 25, 70);
  const gir = clamp(10 + score * 0.3, 10, 55);
  const ob = clamp(7 - score * 0.045, 1.5, 7);

  return {
    strokeRange,
    fwKeep: `${fwKeep.toFixed(0)}%`,
    gir: `${gir.toFixed(0)}%`,
    ob: `${ob.toFixed(1)} 回`,
  };
}
