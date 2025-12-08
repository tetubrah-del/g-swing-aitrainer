'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { GolfAnalysisResponse } from '@/app/golf/types';

const phaseOrder: Array<keyof GolfAnalysisResponse['result']['phases']> = [
  'address',
  'top',
  'downswing',
  'impact',
  'finish',
];

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

        {/* まとめ */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-2">
          <h2 className="text-sm font-semibold">総評</h2>
          <p className="text-sm leading-relaxed whitespace-pre-line">
            {result.summary}
          </p>
        </section>

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
