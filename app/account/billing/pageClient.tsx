"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { UserUsageState } from "@/app/golf/types";

type BillingStatusResponse = {
  provider: "none" | "stripe" | "apple" | "google" | "revenuecat" | null;
  subscriptionStatus: string | null;
  startedAt: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  nextRenewalAt: number | null;
  cancelAtPeriodEnd: boolean | null;
  trialEnd: number | null;
  billingInterval: "day" | "week" | "month" | "year" | null;
  billingIntervalCount: number | null;
  error?: string;
};

const formatDate = (ts: number | null | undefined) => {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("ja-JP") : "-";
};

const formatBillingCycle = (status: BillingStatusResponse | null) => {
  if (!status?.billingInterval) return "-";
  const count = typeof status.billingIntervalCount === "number" && status.billingIntervalCount > 1 ? status.billingIntervalCount : 1;
  switch (status.billingInterval) {
    case "month":
      return count === 12 ? "年額（12ヶ月）" : count === 1 ? "月額" : `${count}ヶ月`;
    case "year":
      return count === 1 ? "年額" : `${count}年`;
    case "week":
      return count === 1 ? "週額" : `${count}週`;
    case "day":
      return count === 1 ? "日額" : `${count}日`;
    default:
      return "-";
  }
};

export default function AccountBillingPageClient() {
  const [userState, setUserState] = useState<UserUsageState | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const [meRes, billingRes] = await Promise.all([
          fetch("/api/golf/me", { cache: "no-store" }),
          fetch("/api/billing/status", { cache: "no-store" }),
        ]);

        const meJson = (await meRes.json().catch(() => ({}))) as { userState?: UserUsageState };
        if (!cancelled) setUserState(meJson.userState ?? null);

        if (billingRes.ok) {
          const billingJson = (await billingRes.json().catch(() => null)) as BillingStatusResponse | null;
          if (!cancelled) setBillingStatus(billingJson);
        } else {
          if (!cancelled) setBillingStatus(null);
        }
      } catch {
        if (!cancelled) setError("failed_to_load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
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

            {billingStatus?.provider === "stripe" && (
              <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-slate-200 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-3">
                  <div className="text-xs text-slate-400">開始日</div>
                  <div className="mt-1 font-medium">{formatDate(billingStatus.startedAt || billingStatus.currentPeriodStart)}</div>
                  <div className="mt-1 text-[11px] text-slate-400">請求周期: {formatBillingCycle(billingStatus)}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-3">
                  <div className="text-xs text-slate-400">次の更新日</div>
                  <div className="mt-1 font-medium">{formatDate(billingStatus.nextRenewalAt || billingStatus.currentPeriodEnd)}</div>
                  {billingStatus.cancelAtPeriodEnd && (
                    <div className="mt-1 text-[11px] text-slate-400">次回更新で解約予定</div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-3">
                  <div className="text-xs text-slate-400">ステータス</div>
                  <div className="mt-1 font-medium">{billingStatus.subscriptionStatus ?? "-"}</div>
                  {billingStatus.trialEnd && <div className="mt-1 text-[11px] text-slate-400">トライアル終了: {formatDate(billingStatus.trialEnd)}</div>}
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/pricing"
                className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950 hover:bg-emerald-400"
              >
                プランを見る
              </Link>
              <button
                type="button"
                disabled={portalLoading}
                onClick={openPortal}
                className="rounded-xl border border-slate-700 bg-slate-950/30 px-4 py-3 text-sm text-slate-100 hover:border-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-700"
              >
                {portalLoading ? "開いています…" : "支払い/解約を管理"}
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
