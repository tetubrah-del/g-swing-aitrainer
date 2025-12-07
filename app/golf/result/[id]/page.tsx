'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { GolfAnalysisResponse } from '@/app/golf/types';

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

  const { result, note, meta, createdAt } = data;
  const analyzedAt = createdAt ? new Date(createdAt).toLocaleString('ja-JP') : null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-3xl px-4 py-8 space-y-6">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AIゴルフスイング診断 – 結果</h1>
            <p className="text-xs text-slate-400 mt-1">Analysis ID: {data.analysisId}</p>
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

        {/* スコア・レベル */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">スイングスコア</p>
            <p className="text-3xl font-bold mt-1">{result.score}</p>
            <p className="text-xs text-slate-400 mt-1">（100点満点）</p>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">推定ラウンドスコア</p>
            <p className="text-xl font-semibold mt-1">{result.estimatedOnCourseScore}</p>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">レベル診断</p>
            <p className="text-sm font-semibold mt-1">
              {result.estimatedLevel}
            </p>
          </div>
        </section>

        {/* まとめ */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-2">
          <h2 className="text-sm font-semibold">総評</h2>
          <p className="text-sm leading-relaxed whitespace-pre-line">
            {result.summary}
          </p>
        </section>

        {/* 良い点 / 改善点 */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <h2 className="text-sm font-semibold mb-2">良い点</h2>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {result.goodPoints.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <h2 className="text-sm font-semibold mb-2">改善したい点</h2>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {result.badPoints.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* 優先改善ポイント */}
        <section className="rounded-xl bg-slate-900/70 border border-emerald-500/60 p-4">
          <h2 className="text-sm font-semibold mb-2 text-emerald-300">
            最優先で直すポイント
          </h2>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {result.priorityFix.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </section>

        {/* ドリル */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold mb-2">おすすめドリル</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {result.drills.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>

        {/* 前回比較 */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold mb-2">前回との比較</h2>
          {result.improvement.hasPrevious ? (
            <div className="space-y-1 text-sm">
              <p>方向性：{result.improvement.direction}</p>
              <p>変化の概要：{result.improvement.changeSummary}</p>
              <p>次に意識したいこと：{result.improvement.nextFocus}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              初回診断のため、比較データはありません。
            </p>
          )}
        </section>
      </div>
    </main>
  );
};

export default GolfResultPage;
