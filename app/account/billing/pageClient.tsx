"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { UserUsageState } from "@/app/golf/types";

export default function AccountBillingPageClient() {
  const [userState, setUserState] = useState<UserUsageState | null>(null);
  const [loading, setLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/golf/me", { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})))
      .then((data: { userState?: UserUsageState }) => {
        if (!cancelled) setUserState(data.userState ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("failed_to_load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openPortal = useCallback(async () => {
    setPortalLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "portal_failed");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("portal_failed");
    } finally {
      setPortalLoading(false);
    }
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold">お支払い・プラン</h1>

        {loading && <div className="mt-4 text-sm text-slate-300">読み込み中…</div>}
        {error && <div className="mt-4 text-sm text-rose-200">{error}</div>}

        {userState && (
          <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
            <div className="text-sm text-slate-300">現在のプラン</div>
            <div className="mt-1 text-lg font-medium">{userState.plan ?? "-"}</div>
            <div className="mt-1 text-xs text-slate-400">
              PRO判定: {userState.hasProAccess ? "有効" : "無効"}
              {userState.entitlements?.billingProvider ? ` / provider: ${userState.entitlements.billingProvider}` : ""}
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/pricing"
                className="rounded-xl border border-slate-700 bg-slate-950/30 px-4 py-3 text-sm text-slate-100 hover:border-emerald-400/60"
              >
                プランを見る
              </Link>
              <button
                type="button"
                disabled={portalLoading}
                onClick={openPortal}
                className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {portalLoading ? "開いています…" : "支払い情報を管理"}
              </button>
            </div>

            <div className="mt-4 text-xs text-slate-400">
              解約/カード変更/領収書はStripeのポータルで管理します。
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

