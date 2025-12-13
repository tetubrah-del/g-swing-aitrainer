'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { SwingTypeKey, SwingTypeLLMResult } from '@/app/golf/types';
import { loadSwingTypeResult } from '@/app/golf/utils/swingTypeStorage';

const SwingTypeDetailPage = () => {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const type = (params?.type as SwingTypeKey) || null;

  const [data, setData] = useState<SwingTypeLLMResult | null>(null);

  useEffect(() => {
    const loaded = loadSwingTypeResult();
    setData(loaded);
  }, []);

  const matchInfo = useMemo(() => {
    if (!data || !type) return null;
    return data.swingTypeMatch?.find((m) => m.type === type) ?? null;
  }, [data, type]);

  const detail = useMemo(() => {
    if (!data || !type) return null;
    return data.swingTypeDetails?.[type] ?? null;
  }, [data, type]);

  const headlineType = detail?.title || matchInfo?.label || 'スイングタイプ';
  const reason = matchInfo?.reason || '診断結果から推定しました';
  const scorePercent = matchInfo ? Math.round(matchInfo.matchScore * 100) : null;
  const coachQuery = headlineType ? `?swingType=${encodeURIComponent(headlineType)}` : '';
  const from = searchParams?.get('from') || '';

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-3xl px-4 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">スイング型の解説</p>
            <h1 className="text-xl font-semibold">{headlineType}</h1>
            {scorePercent !== null && <p className="text-xs text-emerald-300 mt-1">適合度: {scorePercent}%</p>}
          </div>
          <button
            onClick={() => router.push(from || '/golf/upload')}
            className="rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-200 border border-slate-700 hover:bg-slate-700"
          >
            戻る
          </button>
        </header>

        {!detail && (
          <p className="text-sm text-slate-300">
            スイング型の詳細が見つかりませんでした。結果ページから再度開いてください。
          </p>
        )}

        {detail && (
          <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="space-y-1">
              <p className="text-sm text-slate-300">{detail.shortDescription}</p>
              <p className="text-xs text-slate-300 leading-relaxed">{detail.overview}</p>
              <p className="text-xs text-emerald-200">AIの判定理由: {reason}</p>
            </div>

            <div className="text-xs text-slate-200 space-y-2">
              <Section title="このタイプの特徴" items={detail.characteristics} />
              <Section title="向いている人・レベル" items={detail.recommendedFor} />
              <Section title="メリット" items={detail.advantages} />
              <Section title="注意点" items={detail.disadvantages} />
              <Section title="よくある誤解・失敗" items={detail.commonMistakes} />
            </div>

            <button
              onClick={() => router.push(`/coach${coachQuery}`)}
              className="w-full rounded-lg border border-emerald-500/50 bg-emerald-900/30 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/50 transition-colors"
            >
              👉 このスイングを磨くためにAIコーチに相談する
            </button>
          </div>
        )}
      </div>
    </main>
  );
};

const Section = ({ title, items }: { title: string; items?: string[] }) => {
  if (!items || !items.length) return null;
  return (
    <div className="space-y-1">
      <p className="font-semibold text-slate-200">{title}</p>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((line, idx) => (
          <li key={`${title}-${idx}`} className="text-slate-300">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default SwingTypeDetailPage;
