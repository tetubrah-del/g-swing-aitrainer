"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useMeUserState } from "@/app/golf/hooks/useMeUserState";
import { useUserState } from "@/app/golf/state/userState";

type BillingCycle = "monthly" | "yearly";

export default function PricingPageClient() {
  const params = useSearchParams();
  const canceled = params?.get("canceled") === "1";
  useMeUserState();
  const { state: userState } = useUserState();
  const [hydrated, setHydrated] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceLabel = useMemo(() => (cycle === "yearly" ? "年額" : "月額"), [cycle]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const startCheckout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billingCycle: cycle }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; manageUrl?: string };
      if (!res.ok || !data.url) {
        if (res.status === 409 && data.error === "already_subscribed" && data.manageUrl) {
          window.location.href = data.manageUrl;
          return;
        }
        if (data.error === "invalid_price_not_recurring") {
          setError("yearly_price_config_invalid");
          return;
        }
        setError(data.error ?? (res.status === 401 ? "unauthorized" : "checkout_failed"));
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("checkout_failed");
    } finally {
      setLoading(false);
    }
  }, [cycle]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold">PROにアップグレード</h1>
        <p className="mt-2 text-sm text-slate-300">
          年額/クーポン/トライアルはStripe上の設定に対応（将来のアプリ課金はIAPで統合）。
        </p>

        {canceled && (
          <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            決済がキャンセルされました。
          </div>
        )}

        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-medium">G-Swing AI Trainer PRO</div>
              <div className="mt-1 text-xs text-slate-400">診断・AIコーチ・履歴/可視化などを拡張</div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCycle("monthly")}
                className={`rounded-lg px-3 py-2 text-xs border ${
                  cycle === "monthly"
                    ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-700 bg-slate-950/30 text-slate-200"
                }`}
              >
                月額
              </button>
              <button
                type="button"
                onClick={() => setCycle("yearly")}
                className={`rounded-lg px-3 py-2 text-xs border ${
                  cycle === "yearly"
                    ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-700 bg-slate-950/30 text-slate-200"
                }`}
              >
                年額
              </button>
            </div>
          </div>

          <ul className="mt-6 space-y-2 text-sm text-slate-200">
            <li>・診断/分析: 上限解除（将来はPRO内で段階化可能）</li>
            <li>・AIコーチ: 利用可能</li>
            <li>・履歴/可視化: 拡張</li>
          </ul>

          <div className="mt-6 flex items-center gap-3">
            {!hydrated ? (
              <button
                type="button"
                disabled
                className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950 opacity-60"
              >
                読み込み中...
              </button>
            ) : userState.isAuthenticated ? (
              <button
                type="button"
                disabled={loading}
                onClick={startCheckout}
                className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {loading ? "処理中..." : `${priceLabel}で購入`}
              </button>
            ) : (
              <Link
                href={`/golf/register?next=${encodeURIComponent("/pricing")}`}
                className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-slate-950 hover:bg-emerald-400"
              >
                ログインして購入
              </Link>
            )}
            {error && (
              <div className="text-xs text-rose-200">
                {error === "yearly_price_config_invalid" ? "年額のprice設定がサブスク(Recurring)になっていません" : error}
              </div>
            )}
          </div>

          <div className="mt-4 text-xs text-slate-400">
            クーポンはCheckout画面で入力できます。支払い失敗（past_due）はStripe設定の猶予期間中はPRO扱いにできます。
          </div>
        </div>
      </div>
    </main>
  );
}
