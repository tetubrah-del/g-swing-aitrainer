"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CouponGrantRow } from "@/app/lib/referralTracking";
import type { UserAccount } from "@/app/golf/types";

type Props = {
  user: UserAccount;
  referralCode: string | null;
  monitorPerformance: {
    userId: string;
    referralCode: string | null;
    sharesAll: number;
    sharesThisMonth: number;
    signupsAll: number;
    paidAll: number;
    revenueAll: number;
  };
  payment: {
    totalAmount: number;
    firstPaidAt: number | null;
    lastPaidAt: number | null;
    paidMonths: number;
  };
  coupons: CouponGrantRow[];
};

function formatDate(ms: number | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "-";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

function formatYen(amount: number) {
  const n = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  return n.toLocaleString("ja-JP");
}

function MetricCard(props: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4 space-y-1">
      <p className="text-xs text-slate-400">{props.label}</p>
      <p className="text-lg font-semibold text-slate-100 tabular-nums">{props.value}</p>
      {props.sub ? <p className="text-xs text-slate-400">{props.sub}</p> : null}
    </div>
  );
}

function membershipLabel(user: UserAccount) {
  const status = (user.subscriptionStatus ?? "").toLowerCase();
  const isPro = user.plan === "pro" || user.proAccess === true || status === "active" || status === "trialing";
  if (isPro) return "PRO";
  const looksCanceled = status === "canceled" || status === "unpaid" || status === "incomplete_expired" || status === "past_due";
  if (looksCanceled || user.cancelAtPeriodEnd === true || (user.stripeSubscriptionId && !isPro)) return "解約";
  return "メール会員";
}

export default function AdminUserDetailPageClient(props: Props) {
  const router = useRouter();
  const [monitorDays, setMonitorDays] = useState(30);
  const [couponNote, setCouponNote] = useState("");
  const [couponDays, setCouponDays] = useState(30);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawAnonymize, setWithdrawAnonymize] = useState(true);
  const [withdrawConfirm, setWithdrawConfirm] = useState("");
  const [busy, setBusy] = useState<"none" | "monitor" | "coupon" | "withdraw">("none");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const monitorStatus = useMemo(() => {
    if (props.user.proAccessReason !== "monitor") return "未参加";
    if (props.user.monitorExpiresAt) return `参加中（期限: ${formatDate(props.user.monitorExpiresAt)}）`;
    return "参加中（期限なし）";
  }, [props.user.monitorExpiresAt, props.user.proAccessReason]);

  const onGrantMonitor = async () => {
    setBusy("monitor");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/user/${encodeURIComponent(props.user.userId)}/monitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: monitorDays }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      setMessage("モニターを付与しました");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy("none");
    }
  };

  const onRevokeMonitor = async () => {
    setBusy("monitor");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/user/${encodeURIComponent(props.user.userId)}/monitor`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      setMessage("モニターを解除しました");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy("none");
    }
  };

  const onGrantCoupon = async () => {
    setBusy("coupon");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/user/${encodeURIComponent(props.user.userId)}/coupon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: couponNote, expiresDays: couponDays }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      setMessage("クーポンを付与しました");
      setCouponNote("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy("none");
    }
  };

  const onWithdraw = async () => {
    setBusy("withdraw");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/user/${encodeURIComponent(props.user.userId)}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: withdrawReason, anonymize: withdrawAnonymize }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      setMessage("退会処理を実行しました");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy("none");
    }
  };

  const onRestore = async () => {
    setBusy("withdraw");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/user/${encodeURIComponent(props.user.userId)}/withdraw`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      setMessage("退会を解除しました");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy("none");
    }
  };

  const withdrawDisabled = withdrawConfirm !== props.user.userId || busy !== "none";

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">ユーザー詳細</h1>
          <p className="text-sm text-slate-400 font-mono">{props.user.userId}</p>
        </header>

        {(error || message) && (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            {error && <p className="text-sm text-rose-300">{error}</p>}
            {message && <p className="text-sm text-emerald-200">{message}</p>}
          </div>
        )}

        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 space-y-4">
          <h2 className="text-lg font-semibold">基本情報</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-slate-400">ユーザー名</p>
              <p className="mt-1 text-slate-100">{props.user.nickname ?? "-"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">メールアドレス</p>
              <p className="mt-1 text-slate-100">{props.user.email ?? "-"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">会員種別</p>
              <p className="mt-1 text-slate-100">{membershipLabel(props.user)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">紹介コード</p>
              <p className="mt-1 text-slate-100 font-mono">{props.referralCode ?? "-"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">メール会員登録日時</p>
              <p className="mt-1 text-slate-100">{formatDate(props.user.emailVerifiedAt ?? props.user.createdAt)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">PRO会員登録日時（初回課金）</p>
              <p className="mt-1 text-slate-100">{formatDate(props.payment.firstPaidAt)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">最終ログイン</p>
              <p className="mt-1 text-slate-100">{formatDate(props.user.lastLoginAt ?? null)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">最終診断</p>
              <p className="mt-1 text-slate-100">{formatDate(props.user.lastAnalysisAt ?? null)}</p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 space-y-4">
          <h2 className="text-lg font-semibold">サブスク情報</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-xs text-slate-400">サブスク状態</p>
              <p className="mt-1 text-slate-100">{props.user.subscriptionStatus ?? "-"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">次回更新日</p>
              <p className="mt-1 text-slate-100">{formatDate(props.user.currentPeriodEnd ?? null)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">累計課金額</p>
              <p className="mt-1 text-slate-100 tabular-nums">{formatYen(props.payment.totalAmount)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">課金継続月数</p>
              <p className="mt-1 text-slate-100 tabular-nums">{props.payment.paidMonths}</p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 space-y-4">
          <h2 className="text-lg font-semibold">モニター</h2>
          <p className="text-sm text-slate-300">{monitorStatus}</p>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCard label="投稿数（今月）" value={`${props.monitorPerformance.sharesThisMonth}`} />
            <MetricCard label="投稿数（累計）" value={`${props.monitorPerformance.sharesAll}`} />
            <MetricCard label="新規登録（累計）" value={`${props.monitorPerformance.signupsAll}`} />
            <MetricCard label="PRO登録（累計）" value={`${props.monitorPerformance.paidAll}`} />
            <MetricCard label="売上（累計）" value={`${formatYen(props.monitorPerformance.revenueAll)}円`} />
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <span>期限（日）</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={monitorDays}
                onChange={(e) => setMonitorDays(Math.max(1, Math.min(3650, Number(e.target.value) || 30)))}
                className="w-28 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={busy !== "none"}
              onClick={onGrantMonitor}
              className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-800 px-4 py-2 font-semibold text-slate-900"
            >
              モニター付与
            </button>
            <button
              type="button"
              disabled={busy !== "none"}
              onClick={onRevokeMonitor}
              className="rounded-lg border border-slate-700 bg-slate-900/40 hover:bg-slate-900/70 disabled:opacity-50 px-4 py-2 font-semibold text-slate-100"
            >
              モニター解除
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 space-y-4">
          <h2 className="text-lg font-semibold">クーポン付与</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-sm text-slate-200">
              <span className="text-xs text-slate-400">メモ（任意）</span>
              <input
                type="text"
                value={couponNote}
                onChange={(e) => setCouponNote(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2"
                placeholder="例) 問い合わせ対応"
              />
            </label>
            <label className="text-sm text-slate-200">
              <span className="text-xs text-slate-400">期限（日）</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={couponDays}
                onChange={(e) => setCouponDays(Math.max(1, Math.min(3650, Number(e.target.value) || 30)))}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={busy !== "none"}
                onClick={onGrantCoupon}
                className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-800 px-4 py-2 font-semibold text-slate-900"
              >
                クーポン発行
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/30">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60 text-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">コード</th>
                  <th className="px-4 py-3 text-left font-medium">メモ</th>
                  <th className="px-4 py-3 text-left font-medium">期限</th>
                  <th className="px-4 py-3 text-left font-medium">付与日時</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {props.coupons.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-900/30">
                    <td className="px-4 py-3 font-mono text-slate-100 whitespace-nowrap">{c.code}</td>
                    <td className="px-4 py-3 text-slate-200">{c.note ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{formatDate(c.expiresAt)}</td>
                    <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
                {props.coupons.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-slate-400" colSpan={4}>
                      クーポンがありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400">
            注意: ここで発行したクーポンは「記録」用途です。割引適用（Stripe等）への連携は別実装です。
          </p>
        </section>

        <section className="rounded-2xl border border-rose-900/60 bg-rose-950/20 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-rose-100">退会</h2>
          <p className="text-sm text-slate-200">
            退会すると、このユーザーはログインできなくなります。外部課金（Stripe）の解約処理は別途です。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-sm text-slate-200">
              <span className="text-xs text-slate-400">理由（任意）</span>
              <input
                type="text"
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-rose-900/60 bg-slate-950/40 px-3 py-2"
                placeholder="例) 本人依頼"
              />
            </label>
            <label className="text-sm text-slate-200 flex items-end gap-2">
              <input
                type="checkbox"
                checked={withdrawAnonymize}
                onChange={(e) => setWithdrawAnonymize(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm">個人情報（メール/ニックネーム）も削除</span>
            </label>
            <label className="text-sm text-slate-200">
              <span className="text-xs text-slate-400">確認（ユーザーIDを入力）</span>
              <input
                type="text"
                value={withdrawConfirm}
                onChange={(e) => setWithdrawConfirm(e.target.value)}
                className="mt-1 w-full rounded-lg border border-rose-900/60 bg-slate-950/40 px-3 py-2 font-mono"
                placeholder={props.user.userId}
              />
            </label>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              disabled={withdrawDisabled}
              onClick={onWithdraw}
              className="rounded-lg bg-rose-500 hover:bg-rose-400 disabled:bg-rose-900 px-4 py-2 font-semibold text-slate-950"
            >
              退会させる
            </button>
            <button
              type="button"
              disabled={busy !== "none"}
              onClick={onRestore}
              className="rounded-lg border border-slate-700 bg-slate-900/40 hover:bg-slate-900/70 disabled:opacity-50 px-4 py-2 font-semibold text-slate-100"
            >
              退会を解除
            </button>
            <div className="text-sm text-slate-300 flex items-center">
              現在: <span className="ml-2 font-semibold">{props.user.isDisabled ? "退会済" : "在籍"}</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
