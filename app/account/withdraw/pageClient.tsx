"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

type WithdrawStatusResponse = {
  ok?: boolean;
  error?: string;
  userId?: string;
  email?: string | null;
  hasProAccess?: boolean;
  billingProvider?: "none" | "stripe" | "apple" | "google" | "revenuecat" | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean | null;
  withdrawRequestedAt?: number | null;
  withdrawScheduledAt?: number | null;
};

const formatDate = (ts: number | null | undefined) => {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("ja-JP") : "-";
};

export default function AccountWithdrawPageClient() {
  const router = useRouter();
  const [status, setStatus] = useState<WithdrawStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ackDelete, setAckDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/account/withdraw", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as WithdrawStatusResponse;
        if (!cancelled) {
          setStatus(res.ok ? json : { error: json.error ?? "unauthorized" });
        }
      } catch {
        if (!cancelled) setError("failed_to_load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scheduledAt = status?.withdrawScheduledAt ?? null;
  const alreadyScheduled = useMemo(() => typeof scheduledAt === "number" && Number.isFinite(scheduledAt), [scheduledAt]);
  const isStripe = status?.billingProvider === "stripe" && !!status?.stripeSubscriptionId;
  const canSubmit = !loading && !submitting && ackDelete && confirmText.trim() === "退会" && !alreadyScheduled;

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/account/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: confirmText.trim(), reason }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mode?: string; withdrawScheduledAt?: number };
        if (!res.ok || !data.ok) {
          setError(data.error ?? "failed");
          return;
        }

        // Refresh status for scheduled withdrawals.
        if (data.mode === "scheduled") {
          setStatus((prev) => ({
            ...(prev ?? {}),
            withdrawRequestedAt: Date.now(),
            withdrawScheduledAt: typeof data.withdrawScheduledAt === "number" ? data.withdrawScheduledAt : prev?.withdrawScheduledAt ?? null,
            cancelAtPeriodEnd: true,
          }));
          return;
        }

        // Immediate deletion: logout locally.
        try {
          await fetch("/api/golf/logout", { method: "POST" });
        } catch {
          // ignore
        }
        try {
          await signOut({ redirect: false });
        } catch {
          // ignore
        }
        router.replace("/");
        router.refresh();
      } catch {
        setError("failed");
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, confirmText, reason, router],
  );

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-6 py-12 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold text-rose-100">退会</h1>
          <p className="text-sm text-slate-300">退会すると、診断履歴・投稿データを含むユーザーデータが削除されます。</p>
        </header>

        {loading && <div className="text-sm text-slate-300">読み込み中…</div>}
        {error && <div className="text-sm text-rose-200">{error}</div>}

        {!loading && status?.error === "unauthorized" && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-200">
            ログインが必要です。{" "}
            <Link href="/golf/register" className="text-emerald-300 underline underline-offset-4">
              ログイン/登録
            </Link>
          </div>
        )}

        {!loading && status?.ok && (
          <>
            {alreadyScheduled ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6 space-y-2">
                <div className="text-sm text-slate-300">退会予約済み</div>
                <div className="text-sm text-slate-200">
                  退会予定日: <span className="font-medium text-slate-100">{formatDate(status.withdrawScheduledAt)}</span>
                </div>
                <div className="text-xs text-slate-400">
                  {isStripe
                    ? "Stripeのサブスクリプションは期間末で解約されます。期間中は引き続きご利用いただけます。"
                    : "退会処理が予定されています。"}
                </div>
                <div className="pt-2">
                  <Link href="/account/profile" className="text-emerald-300 underline underline-offset-4 text-sm">
                    プロフィールへ戻る
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="rounded-2xl border border-rose-900/60 bg-rose-950/20 p-6 space-y-4">
                <div className="text-sm text-rose-100 font-medium">重要</div>
                <ul className="list-disc pl-5 space-y-1 text-sm text-slate-200">
                  <li>退会すると、診断履歴・投稿データ・アカウント情報は削除され、元に戻せません。</li>
                  {isStripe && (
                    <li>
                      PROは期間末で解約されます（期間中は利用できます）。現在の期間終了:{" "}
                      <span className="font-medium">{formatDate(status.currentPeriodEnd)}</span>
                    </li>
                  )}
                </ul>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-200">退会理由（任意）</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none"
                    placeholder="任意"
                  />
                </div>

                <label className="flex items-start gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={ackDelete}
                    onChange={(e) => setAckDelete(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-rose-400"
                  />
                  <span>退会するとユーザーデータが削除されることを理解しました</span>
                </label>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-200">確認のため「退会」と入力してください</label>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm focus:border-rose-300 focus:outline-none"
                    placeholder="退会"
                  />
                </div>

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="w-full rounded-xl bg-rose-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "処理中…" : isStripe ? "解約して退会予約する" : "退会する"}
                </button>

                <div className="pt-1 text-xs text-slate-400">
                  <Link href="/account/profile" className="text-emerald-300 underline underline-offset-4">
                    キャンセルして戻る
                  </Link>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
