import Link from 'next/link';

type OnPlaneSectionProps = {
  onPlaneData: unknown;
  isPro: boolean;
};

type ScoreTone = 'green' | 'yellow' | 'red';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.+-]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nested =
      obj.cm ??
      obj.deg ??
      obj.value ??
      obj.amount ??
      obj.delta ??
      obj.diff ??
      obj.score ??
      obj.matchScore ??
      obj.match_score;
    if (nested !== undefined) return readNumber(nested);
  }
  return null;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
};

const getObj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' ? (value as Record<string, unknown>) : null);

const resolveScore100 = (data: unknown): number | null => {
  const obj = getObj(data);
  if (!obj) return null;
  const candidates = [
    obj.score,
    obj.matchScore,
    obj.match_score,
    obj.onPlaneScore,
    obj.on_plane_score,
    obj.accuracy,
    obj.accuracyScore,
  ];
  for (const c of candidates) {
    const n = readNumber(c);
    if (n == null) continue;
    const score = n <= 1.2 ? n * 100 : n;
    return clamp(Math.round(score), 0, 100);
  }
  return null;
};

const resolveTone = (score: number): ScoreTone => (score >= 80 ? 'green' : score >= 70 ? 'yellow' : 'red');

const resolveGrade = (score: number): string => {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
};

const toneClasses = (tone: ScoreTone) => {
  switch (tone) {
    case 'green':
      return { text: 'text-emerald-300', ring: 'ring-emerald-400/30', bg: 'bg-emerald-900/10' };
    case 'yellow':
      return { text: 'text-amber-200', ring: 'ring-amber-300/30', bg: 'bg-amber-900/10' };
    case 'red':
      return { text: 'text-rose-300', ring: 'ring-rose-400/30', bg: 'bg-rose-900/10' };
  }
};

const resolveSummary = (data: unknown): string | null => {
  const obj = getObj(data);
  if (!obj) return null;
  const candidates = [
    obj.shortSummary,
    obj.short_summary,
    obj.oneLineSummary,
    obj.one_line_summary,
    obj.headline,
    obj.summary,
    obj.comment,
    obj.insight,
    obj.message,
  ];
  for (const c of candidates) {
    const s = readString(c);
    if (!s) continue;
    return s.replace(/\s+/g, ' ').replace(/\n+/g, ' ').trim();
  }
  return null;
};

const sanitizeOneLinerForFree = (text: string | null): string | null => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const first = (t.split('。')[0] || t).trim();
  const s = first.endsWith('。') ? first : `${first}。`;
  const hasUnitNumber = /\b\d+(\.\d+)?\s*(cm|deg)\b/i.test(s) || /\d+(\.\d+)?\s*(センチ|度)\b/.test(s) || /\d+(\.\d+)?\s*°/.test(s);
  if (hasUnitNumber) return null;
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

type PhaseDeviationKey = 'top_to_downswing' | 'late_downswing' | 'impact';

const resolveDeviationCm = (data: unknown, key: PhaseDeviationKey): number | null => {
  const obj = getObj(data);
  if (!obj) return null;

  const breakdown =
    getObj(obj.phaseBreakdown) ??
    getObj(obj.phase_breakdown) ??
    getObj(obj.phaseDeviations) ??
    getObj(obj.phase_deviations) ??
    getObj(obj.deviations) ??
    getObj(obj.breakdown) ??
    getObj(obj.phases);

  const mapCandidate = getObj(breakdown) ?? obj;

  const candidates =
    key === 'top_to_downswing'
      ? [
          mapCandidate.top_to_downswing_cm,
          mapCandidate.topToDownswingCm,
          mapCandidate.top_to_downswing,
          mapCandidate.topToDownswing,
          mapCandidate.transition_cm,
          mapCandidate.transitionCm,
          mapCandidate.transition,
        ]
      : key === 'late_downswing'
        ? [
            mapCandidate.late_downswing_cm,
            mapCandidate.lateDownswingCm,
            mapCandidate.downswing_late_cm,
            mapCandidate.downswingLateCm,
            mapCandidate.downswing_second_half_cm,
            mapCandidate.downswingSecondHalfCm,
            mapCandidate.downswing_late,
            mapCandidate.downswingLate,
          ]
        : [
            mapCandidate.impact_cm,
            mapCandidate.impactCm,
            mapCandidate.impact,
            mapCandidate.at_impact_cm,
            mapCandidate.atImpactCm,
          ];

  for (const c of candidates) {
    const n = readNumber(c);
    if (n == null) continue;
    return n;
  }
  return null;
};

const sign = (v: number) => (v > 0 ? '+' : '');

const directionLabel = (v: number) => (v >= 0 ? '外側' : '内側');

function OnPlaneMiniViz(props: { deviations: { top: number; late: number; impact: number }; tone: ScoreTone }) {
  const { deviations, tone } = props;
  const toneClass = tone === 'green' ? 'stroke-emerald-300' : tone === 'yellow' ? 'stroke-amber-200' : 'stroke-rose-300';
  const scale = (cm: number) => clamp(cm * 2.8, -22, 22);
  const p0 = { x: 18, y: 52 };
  const p1 = { x: 54, y: 30 };
  const p2 = { x: 90, y: 12 };
  const path = `M ${p0.x + scale(deviations.top)} ${p0.y} Q ${p1.x + scale(deviations.late)} ${p1.y} ${p2.x + scale(deviations.impact)} ${p2.y}`;
  const base = `M ${p0.x} ${p0.y} Q ${p1.x} ${p1.y} ${p2.x} ${p2.y}`;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">簡易可視化（理解優先）</p>
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-slate-500" />
            プレーン
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${tone === 'green' ? 'bg-emerald-300' : tone === 'yellow' ? 'bg-amber-200' : 'bg-rose-300'}`} />
            軌道
          </span>
        </div>
      </div>
      <svg viewBox="0 0 110 64" className="mt-2 h-24 w-full">
        <path d={base} className="stroke-slate-500/70" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d={path} className={toneClass} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default function OnPlaneSection(props: OnPlaneSectionProps) {
  const { onPlaneData, isPro } = props;
  const score = resolveScore100(onPlaneData);
  const tone = resolveTone(score ?? 0);
  const toneClass = toneClasses(tone);

  const summary = resolveSummary(onPlaneData);

  const top = resolveDeviationCm(onPlaneData, 'top_to_downswing');
  const late = resolveDeviationCm(onPlaneData, 'late_downswing');
  const impact = resolveDeviationCm(onPlaneData, 'impact');
  const hasDeviations = [top, late, impact].some((v) => typeof v === 'number' && Number.isFinite(v));

  const derivedOneLiner = (() => {
    if (!hasDeviations) return '診断データが不足しています。';
    const entries = [
      { key: 'top→downswing', v: top },
      { key: 'downswing後半', v: late },
      { key: 'impact', v: impact },
    ].filter((e): e is { key: string; v: number } => typeof e.v === 'number' && Number.isFinite(e.v));
    entries.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const main = entries[0];
    if (!main) return '診断データが不足しています。';
    const dir = directionLabel(main.v);
    if (main.key === 'impact') return `インパクト付近でやや${dir}を通過しています。`;
    if (main.key === 'downswing後半') return `ダウンスイング後半でやや${dir}を通過しています。`;
    return `切り返し〜下ろしでやや${dir}を通過しています。`;
  })();

  const freeOneLiner = sanitizeOneLinerForFree(summary) ?? derivedOneLiner;

  const proCausalSummary = (() => {
    const obj = getObj(onPlaneData);
    const direct = resolveSummary(onPlaneData) ?? readString(obj?.causal_summary) ?? readString(obj?.cause_summary) ?? readString(obj?.why);
    if (direct) return direct;
    if (!hasDeviations) return '軌道のズレは複合要因で起こるため、まずはズレが大きいフェーズを優先して整えるのが近道です。';
    const entries = [
      { phase: 'Top → Downswing', v: top },
      { phase: 'Downswing後半', v: late },
      { phase: 'Impact', v: impact },
    ].filter((e): e is { phase: string; v: number } => typeof e.v === 'number' && Number.isFinite(e.v));
    entries.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const main = entries[0];
    if (!main) return '軌道のズレは複合要因で起こるため、まずはズレが大きいフェーズを優先して整えるのが近道です。';
    const dir = directionLabel(main.v);
    return `${main.phase}で${dir}へのズレが大きく出ています。ここが崩れると、そのままインパクトまで軌道が戻りにくくなります。`;
  })();

  const prev = (() => {
    const obj = getObj(onPlaneData);
    return obj?.previous ?? obj?.prev ?? (getObj(obj?.comparison)?.previous ?? null);
  })();
  const prevScore = resolveScore100(prev);
  const scoreDelta = typeof score === 'number' && typeof prevScore === 'number' ? score - prevScore : null;

  const impactPrev = resolveDeviationCm(prev, 'impact');
  const impactDelta = typeof impact === 'number' && typeof impactPrev === 'number' ? impact - impactPrev : null;
  const impactTrend = (() => {
    if (typeof impact !== 'number' || typeof impactPrev !== 'number') return null;
    const prevAbs = Math.abs(impactPrev);
    const nowAbs = Math.abs(impact);
    if (nowAbs < prevAbs) return '改善';
    if (nowAbs > prevAbs) return '悪化';
    return '変化なし';
  })();

  return (
    <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">オンプレーン診断</h2>
          <p className="text-xs text-slate-400 mt-1">スイング軌道が理想的なプレーンにどれだけ一致しているか</p>
        </div>
        {typeof score === 'number' ? (
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] ring-1 ${toneClass.ring} ${toneClass.bg} ${toneClass.text}`}>
            {tone === 'green' ? '良好' : tone === 'yellow' ? '要調整' : '要改善'}
          </span>
        ) : null}
      </div>

      {!isPro ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <p className={`text-4xl font-bold tracking-tight tabular-nums ${toneClass.text}`}>
                {typeof score === 'number' ? score : '--'}
                <span className="text-base font-semibold text-slate-300 ml-1">点</span>
              </p>
            </div>
          </div>
          <p className="text-sm text-slate-200">{freeOneLiner}</p>
          <div className="pt-1">
            <Link
              href="/pricing"
              className="text-sm text-slate-300 underline underline-offset-4 hover:text-slate-100"
            >
              どのフェーズで、どれくらいズレているかを見る（PRO）
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <p className={`text-4xl font-bold tracking-tight tabular-nums ${toneClass.text}`}>
                {typeof score === 'number' ? score : '--'}
                <span className="text-base font-semibold text-slate-300 ml-1">点</span>
              </p>
              {typeof score === 'number' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">グレード</span>
                  <span className="rounded-full border border-slate-700 bg-slate-950/40 px-2 py-1 text-xs font-semibold text-slate-100">
                    {resolveGrade(score)}
                  </span>
                </div>
              ) : null}
            </div>

            {(typeof scoreDelta === 'number' || typeof impactDelta === 'number') && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                <p className="text-[11px] text-slate-400">前回比較</p>
                {typeof scoreDelta === 'number' && (
                  <p className={`text-sm font-semibold tabular-nums ${scoreDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {scoreDelta === 0 ? 'スコア変化なし' : `スコア ${scoreDelta >= 0 ? '+' : ''}${scoreDelta}点`}
                  </p>
                )}
                {typeof impactDelta === 'number' && impactTrend && (
                  <p className="text-xs text-slate-300 tabular-nums mt-1">
                    Impact {impactTrend}（差分 {sign(impactDelta)}{impactDelta.toFixed(1)}cm）
                  </p>
                )}
              </div>
            )}
          </div>

          {typeof top === 'number' && typeof late === 'number' && typeof impact === 'number' ? (
            <OnPlaneMiniViz deviations={{ top, late, impact }} tone={tone} />
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <p className="text-xs text-slate-400">簡易可視化</p>
              <p className="text-sm text-slate-300 mt-1">可視化に必要なデータが不足しています。</p>
            </div>
          )}

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs text-slate-400">フェーズ別ズレ内訳</p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Top → Downswing</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof top === 'number' ? `${sign(top)}${top.toFixed(1)}cm` : '--'}
                </p>
                {typeof top === 'number' ? <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(top)}</p> : null}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Downswing後半</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof late === 'number' ? `${sign(late)}${late.toFixed(1)}cm` : '--'}
                </p>
                {typeof late === 'number' ? <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(late)}</p> : null}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Impact</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof impact === 'number' ? `${sign(impact)}${impact.toFixed(1)}cm` : '--'}
                </p>
                {typeof impact === 'number' ? (
                  <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(impact)}</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs text-slate-400">因果サマリ</p>
            <p className="text-sm text-slate-200 mt-2">{proCausalSummary}</p>
          </div>
        </div>
      )}
    </section>
  );
}
