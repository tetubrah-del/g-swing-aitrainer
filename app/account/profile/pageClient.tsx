"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type ProfileResponse = {
  userId: string;
  email: string | null;
  nickname: string | null;
};

export default function AccountProfilePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextHref = useMemo(() => {
    const raw = searchParams?.get("next") ?? "";
    if (!raw) return null;
    // Basic open-redirect guard: only allow absolute paths within this origin.
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    return raw;
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading");
        const res = await fetch("/api/account/profile", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<ProfileResponse> & { error?: string };
        if (!res.ok) throw new Error(json.error || "failed");
        const loaded: ProfileResponse = {
          userId: String(json.userId ?? ""),
          email: typeof json.email === "string" ? json.email : null,
          nickname: typeof json.nickname === "string" ? json.nickname : null,
        };
        if (cancelled) return;
        setProfile(loaded);
        setNickname(loaded.nickname ?? "");
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed");
      } finally {
        if (!cancelled) setStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canSave = useMemo(() => status === "idle" && !!profile?.userId, [profile?.userId, status]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setStatus("saving");
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<ProfileResponse> & { error?: string; ok?: boolean };
      if (!res.ok || !json.ok) throw new Error(json.error || "failed");
      const next: ProfileResponse = {
        userId: String(json.userId ?? profile?.userId ?? ""),
        email: typeof json.email === "string" ? json.email : profile?.email ?? null,
        nickname: typeof json.nickname === "string" ? json.nickname : null,
      };
      setProfile(next);
      setNickname(next.nickname ?? "");
      setMessage("保存しました");
      // Close-like UX: return to where the user came from (when provided), otherwise go back.
      if (nextHref) router.push(nextHref);
      else router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setStatus("idle");
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">プロフィール</h1>
          <p className="text-sm text-slate-300">ニックネームは共有ページの表示にも使われます。</p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 space-y-4">
          {error && <p className="text-sm text-rose-300">{error}</p>}
          {message && <p className="text-sm text-emerald-200">{message}</p>}

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-200">メールアドレス</label>
              <input
                type="text"
                value={profile?.email ?? ""}
                readOnly
                className="w-full rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-300"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-200">ニックネーム</label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="例) taro"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
              />
              <p className="text-[11px] text-slate-400">最大24文字。空にすると初期値（メールの@前）に戻ります。</p>
            </div>

            <button
              type="submit"
              disabled={!canSave}
              className="w-full rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-700 px-4 py-3 font-semibold text-slate-900"
            >
              {status === "saving" ? "保存中…" : "保存"}
            </button>
          </form>
        </section>

        <div className="text-xs text-slate-400">
          <Link href="/terms" className="text-emerald-300 underline underline-offset-4">
            利用規約
          </Link>
        </div>

        <div className="rounded-2xl border border-rose-900/60 bg-rose-950/20 p-5">
          <div className="text-sm font-semibold text-rose-100">退会</div>
          <p className="mt-2 text-xs text-slate-300">
            退会すると、診断履歴・投稿データを含むユーザーデータが削除されます。PROは期間末で解約し、期間末に退会処理が実行されます。
          </p>
          <div className="mt-3">
            <Link
              href="/account/withdraw"
              className="inline-flex rounded-xl border border-rose-700/60 bg-rose-950/30 px-4 py-2.5 text-sm text-rose-100 hover:border-rose-300/60"
            >
              退会手続きへ
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
