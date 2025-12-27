import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";

export const runtime = "nodejs";

export default async function AdminHomePage() {
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

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">管理画面</h1>
          <p className="text-sm text-slate-400">一覧表示のみ（編集不可）</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            href="/admin/user"
            className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 hover:bg-slate-900/30 transition-colors"
          >
            <p className="text-lg font-semibold text-slate-100">ユーザー</p>
            <p className="mt-1 text-sm text-slate-400">
              会員種別、登録日時、課金状況など
            </p>
          </Link>

          <Link
            href="/admin/monitors"
            className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 hover:bg-slate-900/30 transition-colors"
          >
            <p className="text-lg font-semibold text-slate-100">モニター</p>
            <p className="mt-1 text-sm text-slate-400">
              投稿数・登録数・PRO登録数・売上
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}

