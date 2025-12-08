'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GolfAnalysisResponse } from '@/app/golf/types';
import { getLatestReport } from '@/app/golf/utils/reportStorage';

const GolfUploadPage = () => {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [handedness, setHandedness] = useState<'right' | 'left'>('right');
  const [clubType, setClubType] = useState<'driver' | 'iron' | 'wedge'>('driver');
  const [level, setLevel] = useState<
    'beginner' | 'beginner_plus' | 'intermediate' | 'upper_intermediate' | 'advanced'
  >('intermediate');

  const [previousReport, setPreviousReport] = useState<GolfAnalysisResponse | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 前回の診断結果を自動で紐付ける
    const latest = getLatestReport();
    if (latest) {
      setPreviousReport(latest);
    }
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('スイングの画像または動画ファイルを選択してください。');
      return;
    }

    try {
      setIsSubmitting(true);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('handedness', handedness);
      formData.append('clubType', clubType);
      formData.append('level', level);
      if (previousReport) {
        formData.append('previousAnalysisId', previousReport.analysisId);
        formData.append('previousReportJson', JSON.stringify(previousReport.result));
      }

      const res = await fetch('/api/golf/analyze', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '診断APIの呼び出しに失敗しました。');
      }

      const data = (await res.json()) as { analysisId: string };
      if (!data.analysisId) {
        throw new Error('analysisId がレスポンスに含まれていません。');
      }

      // 結果画面へ遷移
      router.push(`/golf/result/${data.analysisId}`);
      } catch (err: unknown) {
        console.error(err);
        const message = err instanceof Error ? err.message : '予期せぬエラーが発生しました。';
        setError(message);
      } finally {
        setIsSubmitting(false);
      }
  };

  return (
    <main className="min-h-screen flex justify-center items-center bg-slate-950 text-slate-50">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900/70 border border-slate-700 p-6 space-y-6">
        <h1 className="text-2xl font-semibold text-center">
          AIゴルフスイング診断 – アップロード
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ファイル */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              スイング画像 / 動画ファイル
            </label>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
              }}
              className="block w-full text-sm border border-slate-600 rounded-lg bg-slate-900 px-3 py-2 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-slate-700 file:text-sm file:font-medium hover:file:bg-slate-600"
            />
          </div>

          {/* 利き手 */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">利き手</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="handedness"
                  value="right"
                  checked={handedness === 'right'}
                  onChange={() => setHandedness('right')}
                />
                右打ち
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="handedness"
                  value="left"
                  checked={handedness === 'left'}
                  onChange={() => setHandedness('left')}
                />
                左打ち
              </label>
            </div>
          </div>

          {/* クラブ種別 */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">クラブ種別</label>
            <select
              value={clubType}
              onChange={(e) => setClubType(e.target.value as typeof clubType)}
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="driver">ドライバー</option>
              <option value="iron">アイアン</option>
              <option value="wedge">ウェッジ</option>
            </select>
          </div>

          {/* レベル */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">現在のレベル感</label>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as typeof level)}
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="beginner">初心者</option>
              <option value="beginner_plus">初級</option>
              <option value="intermediate">中級</option>
              <option value="upper_intermediate">中上級</option>
              <option value="advanced">上級</option>
            </select>
          </div>

          {/* エラー */}
          {error && (
            <p className="text-sm text-red-400">
              {error}
            </p>
          )}

          {/* 送信ボタン */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-700 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors"
          >
            {isSubmitting ? '診断中…' : 'AIスイング診断を実行'}
          </button>
        </form>
      </div>
    </main>
  );
};

export default GolfUploadPage;
