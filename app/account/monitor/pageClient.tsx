"use client";

import { useEffect, useState } from "react";

type MonitorStats = {
  shareCount: number;
  signupCount: number;
  paidCount: number;
};

export default function AccountMonitorPageClient() {
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/monitor/stats", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<MonitorStats> & { error?: string };
        if (!res.ok) throw new Error(json.error || "not found");
        if (!cancelled) {
          setStats({
            shareCount: Number(json.shareCount ?? 0),
            signupCount: Number(json.signupCount ?? 0),
            paidCount: Number(json.paidCount ?? 0),
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">🧪 モニター進捗</h1>
          <p className="text-sm text-slate-300">
            あなたは現在
            <br />
            「ゴルフAIスイング診断 モニター」に参加中です。
          </p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-3">
          <h2 className="text-lg font-semibold">📣 SNS共有実績</h2>
          {error && <p className="text-sm text-rose-300">取得できませんでした（{error}）</p>}
          <div className="text-sm text-slate-200 space-y-1">
            <p>今月の投稿数：{stats?.shareCount ?? 0} 件</p>
            <p>投稿経由の新規登録：{stats?.signupCount ?? 0} 人</p>
            <p>投稿経由のPRO登録：{stats?.paidCount ?? 0} 人</p>
          </div>
          <p className="text-xs text-slate-400">※ 投稿内容は自動で集計されます</p>
        </section>
      </div>
    </main>
  );
}

