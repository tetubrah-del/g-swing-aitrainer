import { notFound } from "next/navigation";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import { listUsers } from "@/app/lib/userStore";
import { getAdminMonitorRows } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

export default async function AdminMonitorsPage() {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) notFound();

  const users = await listUsers();
  const monitors = users.filter((u) => u.proAccessReason === "monitor");
  const rows = getAdminMonitorRows({ userIds: monitors.map((u) => u.userId) });
  const byId = new Map(monitors.map((u) => [u.userId, u] as const));

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">モニター一覧</h1>
          <p className="text-sm text-slate-400">表示のみ（編集不可）</p>
        </header>

        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">user</th>
                <th className="px-4 py-3 text-right font-medium">shares</th>
                <th className="px-4 py-3 text-right font-medium">signups</th>
                <th className="px-4 py-3 text-right font-medium">paid</th>
                <th className="px-4 py-3 text-right font-medium">revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((row) => {
                const user = byId.get(row.userId);
                const label = user?.email ? `${user.email} (${row.userId.slice(0, 8)}…)` : `${row.userId.slice(0, 12)}…`;
                return (
                  <tr key={row.userId} className="hover:bg-slate-900/30">
                    <td className="px-4 py-3 text-slate-100 whitespace-nowrap">{label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.shares}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.signups}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.paid}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.revenue}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-slate-400" colSpan={5}>
                    モニターが見つかりません
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

