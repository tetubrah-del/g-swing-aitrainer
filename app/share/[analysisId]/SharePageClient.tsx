"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CausalImpactExplanation, SwingAnalysis, SwingTypeLLMResult } from "@/app/golf/types";
import { buildRuleBasedCausalImpact } from "@/app/golf/utils/causalImpact";
import { computeRoundFallbackFromScore, estimateLevelFromScore } from "@/app/golf/utils/scoreCalibration";

type ShareResult = { analysisId: string; totalScore: number | null; createdAt: number | null };

type ShareDetailPayload = {
  analysisId?: string;
  nickname?: string | null;
  totalScore?: number | null;
  createdAt?: number | null;
  phases?: SwingAnalysis["phases"] | null;
  summary?: string | null;
  recommendedDrills?: string[] | null;
  selectedFrames?: string[] | null;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function normalizeDetail(payload: ShareDetailPayload | null | undefined, analysisId: string): Required<ShareDetailPayload> | null {
  if (!payload || typeof payload !== "object") return null;
  const frames = Array.isArray(payload.selectedFrames) ? payload.selectedFrames.filter((u) => typeof u === "string") : [];
  const drills = Array.isArray(payload.recommendedDrills)
    ? payload.recommendedDrills.filter((d) => typeof d === "string")
    : [];
  const nicknameRaw = typeof payload.nickname === "string" ? payload.nickname.trim() : "";
  const nickname = nicknameRaw ? nicknameRaw.slice(0, 24) : null;
  return {
    analysisId: typeof payload.analysisId === "string" ? payload.analysisId : analysisId,
    nickname,
    totalScore: typeof payload.totalScore === "number" ? payload.totalScore : null,
    createdAt: typeof payload.createdAt === "number" ? payload.createdAt : null,
    phases: payload.phases ?? null,
    summary: typeof payload.summary === "string" ? payload.summary : null,
    recommendedDrills: drills,
    selectedFrames: frames,
  };
}

export default function SharePageClient(props: {
  analysisId: string;
  referralCode: string | null;
  initial?: { totalScore: number | null; createdAt: number | null } | null;
}) {
  const [data, setData] = useState<ShareResult | null>(() =>
    props.initial ? { analysisId: props.analysisId, totalScore: props.initial.totalScore, createdAt: props.initial.createdAt } : null
  );
  const [detail, setDetail] = useState<Required<ShareDetailPayload> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swingType, setSwingType] = useState<SwingTypeLLMResult | null>(null);

  useEffect(() => {
    // Fragment fallback: /share/{id}?ref=...#s=71&t=...
    if (typeof window === "undefined") return;
    const hash = window.location.hash?.startsWith("#") ? window.location.hash.slice(1) : "";
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const s = params.get("s");
    const t = params.get("t");
    const totalScore = s != null ? Number(s) : null;
    const createdAt = t != null ? Number(t) : null;
    if (Number.isFinite(totalScore) || Number.isFinite(createdAt)) {
      setError(null);
      setData((prev) => {
        if (prev) return prev;
        return {
          analysisId: props.analysisId,
          totalScore: Number.isFinite(totalScore) ? totalScore : null,
          createdAt: Number.isFinite(createdAt) ? createdAt : null,
        };
      });
    }
  }, [props.analysisId]);

  useEffect(() => {
    if (!props.referralCode) return;
    try {
      window.localStorage.setItem("referral_code", props.referralCode);
    } catch {
      // ignore
    }
    try {
      document.cookie = `referral_code=${encodeURIComponent(props.referralCode)}; path=/; samesite=lax`;
    } catch {
      // ignore
    }
    // Record visit & let server set cookies (including httpOnly session id).
    try {
      fetch("/api/share/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralCode: props.referralCode }),
        cache: "no-store",
      }).catch(() => {});
    } catch {
      // ignore
    }
  }, [props.referralCode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detailRes = await fetch(`/api/share/detail/${encodeURIComponent(props.analysisId)}`, { cache: "no-store" });
        if (detailRes.ok) {
          const json = (await detailRes.json().catch(() => ({}))) as { payload?: ShareDetailPayload };
          const normalized = normalizeDetail(json.payload ?? null, props.analysisId);
          if (!cancelled && normalized) {
            setDetail(normalized);
            setError(null);
            setData({
              analysisId: props.analysisId,
              totalScore: normalized.totalScore ?? data?.totalScore ?? null,
              createdAt: normalized.createdAt ?? data?.createdAt ?? null,
            });
          }
          return;
        }

        const res = await fetch(`/api/share/result/${encodeURIComponent(props.analysisId)}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<ShareResult> & { error?: string };
        if (!res.ok) throw new Error(json?.error || "not found");
        if (!cancelled) setData(json as ShareResult);
      } catch (e) {
        if (!cancelled) {
          const hasFallback = data?.totalScore != null || data?.createdAt != null;
          if (!hasFallback) {
            setError(e instanceof Error ? e.message : "failed");
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.createdAt, data?.totalScore, props.analysisId]);

  const score = useMemo(() => (typeof data?.totalScore === "number" ? data.totalScore : 0), [data?.totalScore]);
  const levelEstimate = useMemo(() => estimateLevelFromScore(score), [score]);
  const round = useMemo(() => computeRoundFallbackFromScore(score), [score]);

  const causalImpact = useMemo<CausalImpactExplanation>(() => {
    if (!detail?.phases) return buildRuleBasedCausalImpact({ totalScore: score });
    return buildRuleBasedCausalImpact({
      totalScore: score,
      phases: detail.phases,
      summary: detail.summary ?? undefined,
      roundEstimates: { strokeRange: round.strokeRange, ob: round.ob },
    });
  }, [detail?.phases, detail?.summary, round.ob, round.strokeRange, score]);

  useEffect(() => {
    if (!detail?.phases) return;
    const analysis: SwingAnalysis = {
      analysisId: props.analysisId,
      createdAt: new Date(detail.createdAt ?? Date.now()).toISOString(),
      totalScore: score,
      phases: detail.phases as SwingAnalysis["phases"],
      summary: detail.summary ?? "",
      recommendedDrills: detail.recommendedDrills ?? [],
      sequence: detail.selectedFrames?.length ? { frames: detail.selectedFrames.map((url) => ({ url })) } : undefined,
    };

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/golf/swing-type", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis, causalImpact, forceFallback: true }),
        });
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as SwingTypeLLMResult | null;
        if (!cancelled && json) setSwingType(json);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [causalImpact, detail?.createdAt, detail?.phases, detail?.recommendedDrills, detail?.selectedFrames, detail?.summary, props.analysisId, score]);

  const scoreLabel = useMemo(() => {
    if (data?.totalScore == null) return "-";
    return String(data.totalScore);
  }, [data?.totalScore]);

  const phaseList = useMemo(() => {
    const phases = detail?.phases;
    if (!phases) return [];
    const order: Array<keyof SwingAnalysis["phases"]> = ["address", "backswing", "top", "downswing", "impact", "finish"];
    const labelOf = (key: string) =>
      key === "address"
        ? "アドレス"
        : key === "backswing"
          ? "バックスイング"
          : key === "top"
            ? "トップ"
            : key === "downswing"
              ? "ダウンスイング"
              : key === "impact"
                ? "インパクト"
                : "フィニッシュ";
    return order.map((key) => {
      const p = phases[key];
      const good = Array.isArray(p?.good) ? p.good.filter((v) => typeof v === "string") : [];
      const issues = Array.isArray(p?.issues) ? p.issues.filter((v) => typeof v === "string") : [];
      const advice = Array.isArray(p?.advice) ? p.advice.filter((v) => typeof v === "string") : [];
      return {
        key,
        label: labelOf(key),
        score: typeof p?.score === "number" ? p.score : 0,
        good: good.slice(0, 3),
        issues: issues.slice(0, 3),
        advice: advice.slice(0, 3),
      };
    });
  }, [detail?.phases]);

  const topSwingType = swingType?.swingTypeMatch?.[0] ?? null;
  const recommendedSwingTypes = (swingType?.swingTypeMatch ?? []).slice(0, 3);
  const swingTypeDetails = swingType?.swingTypeDetails ?? null;
  const topSwingTypeDetail = topSwingType && swingTypeDetails ? swingTypeDetails[topSwingType.type] : null;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">Golf AI Trainer</p>
          <h1 className="text-2xl font-semibold leading-tight">
            {detail?.nickname ? `${detail.nickname}さんの診断結果` : "診断結果"}
          </h1>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2 md:col-span-1">
            <p className="text-xs text-slate-400">総合スイングスコア</p>
            <p className="text-5xl font-bold">{scoreLabel}</p>
            <p className="text-xs text-slate-400">（100点満点）</p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2 md:col-span-2">
            <p className="text-xs text-slate-400">推定レベル診断</p>
            <p className="text-xl font-semibold">{levelEstimate.label}</p>
            <p className="text-sm text-slate-300">{levelEstimate.detail}</p>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2">
            <p className="text-xs text-slate-400">推定ラウンドスコア</p>
            <p className="text-3xl font-bold">{round.strokeRange}</p>
            <div className="text-xs text-slate-300 space-y-1">
              <p>推定フェアウェイキープ率: {round.fwKeep}</p>
              <p>推定パーオン率: {round.gir}</p>
              <p>推定OB数（18H換算）: {round.ob}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2">
            <p className="text-xs text-slate-400">推奨ドリル</p>
            {detail?.recommendedDrills?.length ? (
              <ul className="list-disc pl-5 space-y-1 text-sm text-slate-100">
                {detail.recommendedDrills.slice(0, 6).map((d, idx) => (
                  <li key={idx}>{d}</li>
                ))}
              </ul>
            ) : causalImpact?.nextAction?.content ? (
              <ul className="list-disc pl-5 space-y-1 text-sm text-slate-100">
                <li>{causalImpact.nextAction.content}</li>
              </ul>
            ) : (
              <p className="text-sm text-slate-300">-</p>
            )}
          </div>
        </section>

        {detail?.selectedFrames?.length ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">選択フレーム</h2>
              <p className="text-xs text-slate-400">7枚</p>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
              {detail.selectedFrames.slice(0, 7).map((url, idx) => (
                <div
                  key={idx}
                  className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/40 aspect-[3/4]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`frame ${idx + 1}`} className="h-full w-full object-cover" />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-3">
          <p className="text-xs text-slate-400">スコアへの因果チェーン</p>
          <div className="flex flex-wrap gap-2">
            {(causalImpact.chain ?? []).slice(0, 6).map((part, idx) => (
              <span
                key={idx}
                className="rounded-full border border-slate-700 bg-slate-950/30 px-3 py-1 text-xs text-slate-100"
              >
                {part}
              </span>
            ))}
          </div>
          {causalImpact.nextAction?.content && (
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-900/10 p-3 text-sm text-emerald-100">
              {causalImpact.nextAction.content}
            </div>
          )}
        </section>

        {detail?.summary ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2">
            <p className="text-xs text-slate-400">診断サマリ</p>
            <p className="text-sm text-slate-100 whitespace-pre-line">{detail.summary}</p>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-3">
          <p className="text-sm font-semibold">フェーズ別評価</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {phaseList.map((p) => (
              <div key={p.key} className="rounded-xl border border-slate-800 bg-slate-950/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-slate-100">{p.label}</p>
                  <p className="text-xs text-slate-300 tabular-nums">{p.score}/20</p>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-emerald-300"
                    style={{ width: `${Math.round(clamp(p.score, 0, 20) * 5)}%` }}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-slate-400">良い点</p>
                    {p.good.length ? (
                      <ul className="mt-1 list-disc pl-5 space-y-1 text-slate-100">
                        {p.good.map((t, idx) => (
                          <li key={idx}>{t}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-slate-300">-</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">課題</p>
                    {p.issues.length ? (
                      <ul className="mt-1 list-disc pl-5 space-y-1 text-slate-100">
                        {p.issues.map((t, idx) => (
                          <li key={idx}>{t}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-slate-300">-</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">改善アドバイス</p>
                    {p.advice.length ? (
                      <ul className="mt-1 list-disc pl-5 space-y-1 text-slate-100">
                        {p.advice.map((t, idx) => (
                          <li key={idx}>{t}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-slate-300">-</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {phaseList.length === 0 && <p className="text-sm text-slate-400">データがありません</p>}
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-2">
            <p className="text-xs text-slate-400">あなたのスイングタイプ</p>
            {topSwingType ? (
              <>
                <p className="text-xl font-semibold">{topSwingType.label}</p>
                <p className="text-sm text-slate-300">{topSwingType.reason}</p>
                {topSwingTypeDetail?.shortDescription && (
                  <p className="text-sm text-slate-100 mt-2">{topSwingTypeDetail.shortDescription}</p>
                )}
                {topSwingTypeDetail?.characteristics?.length ? (
                  <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-slate-300">
                    {topSwingTypeDetail.characteristics.slice(0, 4).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-slate-300">-</p>
            )}
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-3">
            <p className="text-xs text-slate-400">あなたに向いてるスイングタイプ</p>
            {recommendedSwingTypes.length ? (
              <ul className="space-y-2">
                {recommendedSwingTypes.map((m) => (
                  <li key={m.type} className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-slate-100">{m.label}</p>
                      <p className="text-xs text-slate-400 tabular-nums">{Math.round(m.matchScore * 100)}%</p>
                    </div>
                    <p className="text-sm text-slate-300 mt-1">{m.reason}</p>
                    {swingTypeDetails?.[m.type]?.shortDescription && (
                      <p className="text-sm text-slate-100 mt-2">{swingTypeDetails[m.type]!.shortDescription}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-300">-</p>
            )}
          </div>
        </section>

        {error && <p className="text-sm text-rose-300">表示できませんでした（{error}）</p>}

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <Link
            href="/golf/upload"
            className="rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            自分も診断する
          </Link>
          <Link href="/golf/register" className="text-emerald-300 underline underline-offset-4">
            無料登録
          </Link>
          <Link href="/pricing" className="text-emerald-300 underline underline-offset-4">
            PROを見る
          </Link>
        </div>
      </div>
    </main>
  );
}
