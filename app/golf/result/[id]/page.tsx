'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { GolfAnalysisResponse, SequenceStageKey } from '@/app/golf/types';
import { saveReport } from '@/app/golf/utils/reportStorage';

const phaseOrder: Array<keyof GolfAnalysisResponse['result']['phases']> = [
  'address',
  'top',
  'downswing',
  'impact',
  'finish',
];

const stageLabels: Record<SequenceStageKey, string> = {
  address: 'Address',
  address_to_backswing: 'Address → Backswing',
  backswing_to_top: 'Backswing → Top',
  top_to_downswing: 'Top → Downswing',
  downswing_to_impact: 'Downswing → Impact',
  finish: 'Finish',
};

const GolfResultPage = () => {
  const params = useParams();
  const router = useRouter();
  const id = (params?.id ?? '') as string;

  const [data, setData] = useState<GolfAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    const fetchResult = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const res = await fetch(`/api/golf/result/${id}`, {
          method: 'GET',
          cache: 'no-store',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || '診断結果の取得に失敗しました。');
        }

        const json = (await res.json()) as GolfAnalysisResponse;
        setData(json);
      } catch (err: unknown) {
        console.error(err);
        const message = err instanceof Error ? err.message : '予期せぬエラーが発生しました。';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchResult();
  }, [id]);

  useEffect(() => {
    if (!data) return;
    // 完了結果を localStorage に保存（最大20件）
    const record: GolfAnalysisResponse = {
      ...data,
      createdAt: data.createdAt ?? Date.now(),
    };
    saveReport(record);
  }, [data]);

  const handleRetry = () => {
    router.push('/golf/upload');
  };

  // ❗ Hooks は必ずトップレベルで呼ぶ必要がある
  const analyzedAt = useMemo(() => {
    if (!data?.createdAt) return null;
    return new Date(data.createdAt).toLocaleString('ja-JP');
  }, [data?.createdAt]);

  const phaseList = useMemo(() => {
    if (!data?.result?.phases) return [];

    return phaseOrder.map((key) => ({
      key,
      label:
        key === 'address'
          ? 'アドレス'
          : key === 'top'
            ? 'トップ'
            : key === 'downswing'
              ? 'ダウンスイング'
              : key === 'impact'
                ? 'インパクト'
                : 'フィニッシュ',
      data: data.result.phases[key],
    }));
  }, [data?.result?.phases]);

  const levelEstimate = useMemo(() => {
    const score = data?.result?.totalScore ?? 0;
    if (score >= 85)
      return {
        label: '上級',
        detail:
          '完成度が高く、安定した再現性が期待できます。細部のフェース管理と球筋コントロールを磨けば競技レベルでも通用します。下半身リードとトップの静止をキープしつつ、セットアップの精度を日々確認するとさらに安定度が上がります。',
      };
    if (score >= 70)
      return {
        label: '中上級',
        detail:
          '全体のバランスは良好で、再現性も高い段階です。トップからダウンの切り返しでクラブをスムーズに落とし、インパクトでのフェース向きを安定させると一気に上級域へ近づきます。ルーティンの質とテンポ管理を強化しましょう。',
      };
    if (score >= 55)
      return {
        label: '中級',
        detail:
          '基本は安定しており、リズムと軌道の精度を上げることで大きく伸びます。アドレスの重心とトップのクラブポジションを毎回揃えることが次のステップです。切り返しで手先が暴れないよう、下半身主導のイメージを持ちましょう。',
      };
    if (score >= 40)
      return {
        label: '初級',
        detail:
          '姿勢とテンポの基礎づくりを強化するタイミングです。アドレスの前傾とグリッププレッシャーを一定にし、ハーフスイングでフェース向きとコンタクトを安定させる練習がおすすめです。体重移動のリズムをゆっくり身につけましょう。',
      };
    return {
      label: 'ビギナー',
      detail:
        'まずはアドレスとリズムの基礎を固める段階です。スタンス幅、前傾角、グリップを毎回揃え、ハーフスイングで芯に当てる感覚を作りましょう。重心を左右に大きく動かさず、一定のテンポで振り抜くことを意識すると次のステップに進みやすくなります。',
    };
  }, [data?.result?.totalScore]);

  const roundEstimates = useMemo(() => {
    const totalScore = data?.result?.totalScore ?? 0;
    const mid = Math.round(100 - totalScore * 0.3); // スコアが高いほどストロークは小さい想定
    const spread = 2;
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const low = clamp(mid - spread, 60, 110);
    const high = clamp(mid + spread, 60, 110);

    // 簡易推定（適当な変換でイメージを示す）
    const fwKeep = clamp(55 + totalScore * 0.2, 40, 80); // フェアウェイキープ率
    const gir = clamp(35 + totalScore * 0.25, 20, 75); // パーオン率
    const ob = clamp(2.5 - totalScore * 0.015, 0.3, 4); // 推定OB数/18H

    return {
      strokeRange: `${low}〜${high}`,
      fwKeep: `${fwKeep.toFixed(0)}%`,
      gir: `${gir.toFixed(0)}%`,
      ob: `${ob.toFixed(1)} 回`,
    };
  }, [data?.result?.totalScore]);

  const extendedSummary = useMemo(() => {
    const base = (data?.result?.summary ?? '').trim();
    const extras: string[] = [];
    const phases = data?.result?.phases;
    const addPhase = (key: keyof typeof phases, label: string) => {
      const phase = phases?.[key];
      if (!phase) return;
      const good = phase.good?.[0];
      const issue = phase.issues?.[0];
      if (good || issue) {
        const goodText = good ? `良い点: ${good}` : '';
        const issueText = issue ? `改善点: ${issue}` : '';
        extras.push(`${label} — ${[goodText, issueText].filter(Boolean).join(' / ')}`);
      }
    };
    addPhase('address', 'Address');
    addPhase('top', 'Top');
    addPhase('downswing', 'Downswing');
    addPhase('impact', 'Impact');
    addPhase('finish', 'Finish');

    if (!extras.length) return base;
    const extraText = extras.map((e) => `- ${e}`).join('\n');
    return `${base}\n\n補足:\n${extraText}`;
  }, [data?.result?.summary, data?.result?.phases]);

  // ▼ early return は Hooks の後に置く
  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50">
        <p>診断結果を取得しています…</p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-50 space-y-4">
        <p className="text-red-400 text-sm">{error || '診断結果が見つかりませんでした。'}</p>
        <button
          onClick={handleRetry}
          className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
        >
          再診断する
        </button>
      </main>
    );
  }

  const { result, note, meta } = data;
  const sequenceFrames = result.sequence?.frames ?? [];
  const sequenceStages = result.sequence?.stages ?? [];
  const comparison = result.comparison;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-3xl px-4 py-8 space-y-6">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AIゴルフスイング診断 – 結果</h1>
            <p className="text-xs text-slate-400 mt-1">解析ID：{data.analysisId}</p>
            {(meta || analyzedAt) && (
              <div className="mt-1 space-y-0.5 text-xs text-slate-400">
                {analyzedAt && <p>解析日時: {analyzedAt}</p>}
                {meta && (
                  <p>
                    入力情報: {meta.handedness === 'right' ? '右打ち' : '左打ち'} / {meta.clubType} / {meta.level}
                  </p>
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleRetry}
            className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            再診断する
          </button>
        </header>

        {note && (
          <p className="text-xs text-amber-300">
            {note}
          </p>
        )}

        {/* スコア */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 sm:col-span-1">
            <p className="text-xs text-slate-400">総合スイングスコア</p>
            <p className="text-3xl font-bold mt-1">{result.totalScore}</p>
            <p className="text-xs text-slate-400 mt-1">（100点満点）</p>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 sm:col-span-2">
            <p className="text-xs text-slate-400">推奨ドリル</p>
            {result.recommendedDrills && result.recommendedDrills.length > 0 ? (
              <ul className="list-disc pl-5 space-y-1 text-sm mt-2">
                {result.recommendedDrills.map((drill, i) => (
                  <li key={i}>{drill}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-300 mt-2">ドリル情報がありません。</p>
            )}
          </div>
        </section>

        {/* 推定ラウンドスコア＆レベル診断 */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">推定ラウンドスコア</p>
            <p className="text-3xl font-bold mt-1">{roundEstimates.strokeRange}</p>
            <p className="text-xs text-slate-400 mt-1">ラウンドスコアの目安レンジ（ストローク）</p>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <p>推定フェアウェイキープ率: {roundEstimates.fwKeep}</p>
              <p>推定パーオン率: {roundEstimates.gir}</p>
              <p>推定OB数（18H換算）: {roundEstimates.ob}</p>
            </div>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">推定レベル診断</p>
            <p className="text-xl font-semibold mt-1">{levelEstimate.label}</p>
            <p className="text-sm text-slate-300 mt-1">{levelEstimate.detail}</p>
          </div>
        </section>

        {(sequenceFrames.length > 0 || sequenceStages.length > 0) && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">連続フレーム診断</h2>
                <p className="text-xs text-slate-400">抽出された14〜16フレームをそのまま診断に使用しています。</p>
              </div>
              <span className="text-xs text-slate-300">
                {sequenceFrames.length ? `${sequenceFrames.length}枚のフレーム` : 'ステージコメントのみ'}
              </span>
            </div>

            {sequenceFrames.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sequenceFrames.map((frame, idx) => (
                  <div key={`${frame.url}-${idx}`} className="rounded-lg border border-slate-800 bg-slate-950/50 p-2 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span className="font-semibold">#{idx + 1}</span>
                      {typeof frame.timestampSec === 'number' && <span>{frame.timestampSec.toFixed(2)}s</span>}
                    </div>
                    <div className="aspect-video w-full overflow-hidden rounded-md border border-slate-800 bg-slate-900">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={frame.url} alt={`sequence-frame-${idx + 1}`} className="h-full w-full object-contain bg-slate-950" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {sequenceStages.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {sequenceStages.map((stage, idx) => (
                  <div
                    key={`${stage.stage}-${idx}`}
                    className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{stageLabels[stage.stage]}</p>
                      {stage.keyFrameIndices?.length ? (
                        <span className="text-xs text-slate-300">
                          #{stage.keyFrameIndices.map((n) => n + 1).join(', ')}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-semibold text-emerald-200">{stage.headline || 'ステージ評価'}</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {(stage.details?.length ? stage.details : ['詳細情報がありません。']).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {comparison && (comparison.improved.length > 0 || comparison.regressed.length > 0) && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <h2 className="text-sm font-semibold">前回比 改善ポイント / 悪化ポイント</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-700/50 bg-emerald-900/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-emerald-300">改善ポイント</p>
                  <span className="text-xs text-emerald-200">{comparison.improved.length} 件</span>
                </div>
                {comparison.improved.length > 0 ? (
                  <ul className="list-disc pl-4 text-sm space-y-1 text-emerald-50">
                    {comparison.improved.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-emerald-100">改善点は報告されていません。</p>
                )}
              </div>

              <div className="rounded-lg border border-rose-700/50 bg-rose-900/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-rose-200">悪化ポイント</p>
                  <span className="text-xs text-rose-100">{comparison.regressed.length} 件</span>
                </div>
                {comparison.regressed.length > 0 ? (
                  <ul className="list-disc pl-4 text-sm space-y-1 text-rose-50">
                    {comparison.regressed.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-rose-100">悪化ポイントは報告されていません。</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* フェーズごとの評価 */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-4">
          <h2 className="text-sm font-semibold">フェーズ別評価</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {phaseList.map(({ key, label, data }) => {
              if (!data) {
                return (
                  <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{label}</p>
                    </div>
                    <div className="text-sm text-amber-300">解析データが不足しています（{key}）。</div>
                  </div>
                );
              }

              return (
                <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{label}</p>
                    <span className="text-xs text-slate-300">スコア：{data.score}/20</span>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">良い点</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {data.good.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">改善点</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {data.issues.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">アドバイス</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {data.advice.map((adv, i) => (
                        <li key={i}>{adv}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
};

export default GolfResultPage;
