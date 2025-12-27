import { notFound } from "next/navigation";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import Link from "next/link";
import { listUsers, type UserAccount } from "@/app/lib/userStore";
import { getUserPaymentSummary } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

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

function monthKey(ms: number) {
  const d = new Date(ms);
  return d.getFullYear() * 12 + d.getMonth();
}

function monthsSince(startMs: number | null, nowMs: number) {
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs <= 0) return null;
  const diff = monthKey(nowMs) - monthKey(startMs);
  return Math.max(1, diff + 1);
}

function formatYen(amount: number) {
  const n = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  return n.toLocaleString("ja-JP");
}

function membershipLabel(user: UserAccount) {
  const status = (user.subscriptionStatus ?? "").toLowerCase();
  const isPro = user.plan === "pro" || user.proAccess === true || status === "active" || status === "trialing";
  if (isPro) return "PRO";
  const looksCanceled = status === "canceled" || status === "unpaid" || status === "incomplete_expired" || status === "past_due";
  if (looksCanceled || user.cancelAtPeriodEnd === true || (user.stripeSubscriptionId && !isPro)) return "解約";
  return "メール会員";
}

function billingTypeLabel(user: UserAccount, params: { lastPaidAt: number | null; nowMs: number }) {
  if (!user.currentPeriodEnd) return "-";
  const base = typeof params.lastPaidAt === "number" ? params.lastPaidAt : params.nowMs;
  const delta = user.currentPeriodEnd - base;
  if (!Number.isFinite(delta) || delta <= 0) return "-";
  // Heuristic: > ~200 days => yearly, else monthly.
  return delta > 1000 * 60 * 60 * 24 * 200 ? "年額" : "月額";
}

export default async function AdminUserPage() {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) {
    if (process.env.NODE_ENV !== "production") {
      return (
        <main className="min-h-screen bg-slate-950 text-slate-50 px-4 py-10">
          <div className="mx-auto w-full max-w-2xl space-y-4">
            <h1 className="text-2xl font-semibold">管理者権限がありません</h1>
            <p className="text-sm text-slate-300">
              この画面は管理者のみ閲覧できます。現在のログインメール:{" "}
              <span className="font-mono">{ctx.email ?? "-"}</span>
            </p>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-200 space-y-2">
              <p className="font-semibold">ローカルで開くには</p>
              <p>
                <span className="font-mono">.env.local</span> に{" "}
                <span className="font-mono">ADMIN_EMAILS</span> を設定して、開発サーバーを再起動してください。
              </p>
              <p className="font-mono text-xs text-slate-400">ADMIN_EMAILS=you@example.com</p>
            </div>
          </div>
        </main>
      );
    }
    notFound();
  }

  const users = await listUsers();
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const rows = users
    .map((u) => {
      const payment = getUserPaymentSummary(u.userId);
      const registeredAt = (typeof u.emailVerifiedAt === "number" ? u.emailVerifiedAt : u.createdAt) ?? null;
      const totalMonths = monthsSince(registeredAt, now);
      const billingMonths = payment.paidMonths;
      const billingType = billingTypeLabel(u, { lastPaidAt: payment.lastPaidAt, nowMs: now });

      return {
        userId: u.userId,
        nickname: u.nickname ?? null,
        email: u.email ?? null,
        membership: membershipLabel(u),
        emailRegisteredAt: registeredAt,
        proRegisteredAt: payment.firstPaidAt,
        billingType,
        totalMonths,
        totalAmount: payment.totalAmount,
        billingMonths,
      };
    })
    .sort((a, b) => b.totalAmount - a.totalAmount);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">ユーザー一覧</h1>
          <p className="text-sm text-slate-400">表示のみ（編集不可）</p>
        </header>

        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">ユーザー名</th>
                <th className="px-4 py-3 text-left font-medium">ID</th>
                <th className="px-4 py-3 text-left font-medium">会員種別</th>
                <th className="px-4 py-3 text-left font-medium">メール会員登録日時</th>
                <th className="px-4 py-3 text-left font-medium">PRO会員登録日時</th>
                <th className="px-4 py-3 text-left font-medium">課金タイプ</th>
                <th className="px-4 py-3 text-right font-medium">累計登録月数</th>
                <th className="px-4 py-3 text-right font-medium">累計課金額</th>
                <th className="px-4 py-3 text-right font-medium">課金継続月数</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((row) => {
                const userLabel = row.nickname ? row.nickname : row.email ? row.email.split("@")[0] : "-";
                return (
                  <tr key={row.userId} className="hover:bg-slate-900/30">
                    <td className="px-4 py-3 text-slate-100 whitespace-nowrap">
                      <Link href={`/admin/user/${encodeURIComponent(row.userId)}`} className="hover:underline">
                        {userLabel}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-200 font-mono whitespace-nowrap">
                      <Link href={`/admin/user/${encodeURIComponent(row.userId)}`} className="hover:underline">
                        {row.userId}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-100 whitespace-nowrap">{row.membership}</td>
                    <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{formatDate(row.emailRegisteredAt)}</td>
                    <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{formatDate(row.proRegisteredAt)}</td>
                    <td className="px-4 py-3 text-slate-100 whitespace-nowrap">{row.billingType}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-100">{row.totalMonths ?? "-"}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-100">{formatYen(row.totalAmount)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-100">{row.billingMonths}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-slate-400" colSpan={9}>
                    ユーザーが見つかりません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
