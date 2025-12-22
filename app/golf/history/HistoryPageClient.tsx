"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { useUserState } from "@/app/golf/state/userState";
import { useMeUserState } from "@/app/golf/hooks/useMeUserState";
import { getFeatures } from "@/app/lib/features";
import ProUpsellModal from "@/app/components/ProUpsellModal";

type HistoryItem = {
  id: string;
  createdAt: number;
  score: number | null;
  club: string | null;
  level: string | null;
  keyImprovement?: string | null;
  phaseRatings?: Record<"address" | "backswing" | "top" | "downswing" | "impact" | "finish", "good" | "needs_improvement"> | null;
};

type HistoryResponse = {
  items: HistoryItem[];
  access: "anonymous" | "member";
  historyDepth?: "full" | "latest_only";
};

const formatDate = (ts: number) => {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("ja-JP") : "";
};

const PHASE_LABELS: Record<keyof NonNullable<HistoryItem["phaseRatings"]>, string> = {
  address: "アドレス",
  backswing: "バックスイング",
  top: "トップ",
  downswing: "ダウン",
  impact: "インパクト",
  finish: "フィニッシュ",
};

export default function HistoryPage() {
  useMeUserState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const { state: userState } = useUserState();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showToast, setShowToast] = useState(false);
  const [proModalOpen, setProModalOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/golf/history", { cache: "no-store" });
        const json = (await res.json()) as HistoryResponse & { error?: string };
        if (!res.ok) {
          throw new Error(json.error || "履歴の取得に失敗しました");
        }
        setData(json);
      } catch (err) {
        const message = err instanceof Error ? err.message : "履歴の取得に失敗しました";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [userState.userId, userState.email, userState.isAuthenticated]);

  useEffect(() => {
    const registered = searchParams.get("registered");
    if (registered) {
      setShowToast(true);
      const timer = setTimeout(() => setShowToast(false), 3500);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("registered");
      const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(nextUrl);
      return () => clearTimeout(timer);
    }
  }, [pathname, router, searchParams]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return [...data.items]
      .filter((item) => typeof item.score === "number")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => ({
        date: new Date(item.createdAt).toLocaleDateString("ja-JP"),
        score: item.score ?? 0,
      }));
  }, [data]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50">
        <p>診断履歴を読み込み中です…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-50 space-y-4">
        <p className="text-red-400 text-sm">{error}</p>
        <Link
          href="/golf/upload"
          className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
        >
          診断をアップロードする
        </Link>
      </main>
    );
  }

  const isMember = userState.isAuthenticated || data?.access === "member";
  const isAnonymous = !isMember;
  const hasHistories = (data?.items.length ?? 0) > 0;
  const registerUrl = `/golf/register?next=${encodeURIComponent(pathname)}`;
  const features = getFeatures({ remainingCount: userState.monthlyAnalysis?.remaining ?? null, isPro: userState.hasProAccess });
  const isPro = features.historyDepth === "full";
  const latest = data?.items?.[0] ?? null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-4xl px-4 py-8 space-y-8">
        {showToast && (
          <div className="fixed top-4 inset-x-0 flex justify-center px-4">
            <div className="max-w-lg w-full rounded-lg border border-emerald-400/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 shadow-lg shadow-emerald-900/30">
              登録が完了しました。履歴が保存されました。
            </div>
          </div>
        )}
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">診断履歴</h1>
            <p className="text-xs text-slate-400 mt-1">過去の診断結果とスコア推移を確認できます。</p>
          </div>
          <Link
            href="/golf/upload"
            className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            新しく診断する
          </Link>
        </header>

        {!isAnonymous && hasHistories && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-4 space-y-3 relative">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">スコア推移</h2>
              <p className="text-xs text-slate-400">
                {isPro ? "スコアと診断日で推移を確認できます。" : "過去との比較・推移は PRO で確認できます"}
              </p>
            </div>
            {!isPro && (
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setProModalOpen(true)}
                  className="rounded-md border border-emerald-500/40 bg-emerald-900/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-900/20"
                >
                  PROにアップグレード
                </button>
              </div>
            )}
            <div className={`h-64 ${isPro ? "" : "opacity-40"}`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#475569" />
                  <XAxis dataKey="date" stroke="#cbd5e1" tick={{ fontSize: 12 }} />
                  <YAxis domain={[0, 100]} stroke="#cbd5e1" tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#e2e8f0" }}
                    labelStyle={{ color: "#e2e8f0" }}
                  />
                  <Line type="monotone" dataKey="score" stroke="#34d399" strokeWidth={2} dot />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {!isPro && (
              <button
                type="button"
                onClick={() => setProModalOpen(true)}
                className="absolute inset-0 rounded-xl"
                aria-label="PRO案内"
              />
            )}
          </section>
        )}

        {isAnonymous && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-100">スコア推移グラフ</h2>
            <p className="text-sm text-slate-300">
              スコア推移を見るにはメール登録が必要です。登録すると無料診断が生涯3回まで利用できます。
            </p>
            <Link
              href={registerUrl}
              className="inline-flex justify-center rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
            >
              メールアドレスを登録する
            </Link>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-100">診断履歴一覧</h2>
          {!hasHistories && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300 space-y-2">
              <p>まだ診断履歴がありません。</p>
              <Link href="/golf/upload" className="text-emerald-300 underline underline-offset-4">
                診断をアップロードする →
              </Link>
            </div>
          )}

          {hasHistories && isPro && (
            <div className="space-y-3">
              {data?.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <p className="text-slate-100 text-sm font-semibold">{formatDate(item.createdAt)}</p>
                    <p className="text-xs text-slate-400">
                      クラブ: {item.club ?? "不明"} / レベル: {item.level ?? "不明"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-lg font-bold text-emerald-300">
                      {item.score !== null ? `${item.score} 点` : "スコアなし"}
                    </p>
                    <Link
                      href={`/golf/result/${item.id}`}
                      className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      結果を見る
                    </Link>
                    <Link
                      href={`/coach?analysisId=${encodeURIComponent(item.id)}`}
                      className="rounded-md border border-emerald-500/50 bg-emerald-900/20 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/35"
                    >
                      AIコーチ
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasHistories && !isPro && latest && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-slate-100 text-sm font-semibold">{formatDate(latest.createdAt)}</p>
                    <p className="text-xs text-slate-400">
                      クラブ: {latest.club ?? "不明"} / レベル: {latest.level ?? "不明"}
                    </p>
                    {latest.keyImprovement && (
                      <p className="text-xs text-slate-200">改善ポイント: {latest.keyImprovement}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-lg font-bold text-emerald-300">
                      {latest.score !== null ? `${latest.score} 点` : "スコアなし"}
                    </p>
                    <Link
                      href={`/golf/result/${latest.id}`}
                      className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      結果を見る
                    </Link>
                    <Link
                      href={`/coach?analysisId=${encodeURIComponent(latest.id)}`}
                      className="rounded-md border border-slate-700 bg-slate-900/30 px-3 py-2 text-sm text-slate-100 hover:border-emerald-400/70"
                    >
                      AIコーチ
                    </Link>
                  </div>
                </div>

                {latest.phaseRatings && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {Object.entries(latest.phaseRatings).map(([key, value]) => (
                      <div
                        key={key}
                        className={`rounded-full border px-3 py-1 text-xs ${
                          value === "good"
                            ? "border-emerald-500/40 bg-emerald-900/20 text-emerald-100"
                            : "border-slate-700 bg-slate-950/30 text-slate-200"
                        }`}
                      >
                        {PHASE_LABELS[key as keyof typeof PHASE_LABELS]}：{value === "good" ? "良い" : "要改善"}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 relative">
                <div className="opacity-40 space-y-2">
                  <p className="text-sm font-semibold text-slate-100">過去の履歴一覧（PRO）</p>
                  <p className="text-xs text-slate-300">
                    PROなら推移グラフ・履歴の蓄積・前回比の比較ができ、AIコーチもフリーチャット＋診断画像参照で深掘りできます。
                  </p>
                  <div className="grid gap-2">
                    {[0, 1].map((i) => (
                      <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/20 p-3 text-xs text-slate-300">
                        過去の診断がここに表示されます
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setProModalOpen(true)}
                    className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                  >
                    PROにアップグレード
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setProModalOpen(true)}
                  className="absolute inset-0 rounded-lg"
                  aria-label="PRO案内"
                />
                <p className="mt-2 text-xs text-slate-400">過去との比較・推移は PRO で確認できます</p>
              </div>
            </div>
          )}
        </section>
      </div>

      <ProUpsellModal
        open={proModalOpen}
        onClose={() => setProModalOpen(false)}
        title="過去との比較・推移はPROで確認できます"
        message="履歴一覧・推移グラフ・比較機能が利用できます。"
        ctaHref={userState.isAuthenticated ? "/pricing" : `/golf/register?next=${encodeURIComponent("/pricing")}`}
        ctaLabel={userState.isAuthenticated ? "PROにアップグレード" : "登録してPROを見る"}
      />
    </main>
  );
}
