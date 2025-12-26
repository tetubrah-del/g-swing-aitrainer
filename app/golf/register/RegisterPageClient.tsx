"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { getAnonymousUserId } from "@/app/golf/utils/historyStorage";
import { resetMeUserStateCache } from "@/app/golf/hooks/useMeUserState";

const sanitizeNext = (next: string | null, fallback: string): string => {
  if (!next || !next.startsWith("/")) return fallback;
  return next;
};

const buildRedirectTarget = (next: string | null, fallback: string): string => {
  const target = sanitizeNext(next, fallback);
  const hasQuery = target.includes("?");
  const separator = hasQuery ? "&" : "?";
  return `${target}${separator}registered=1`;
};

export default function RegisterPage() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [nicknameEdited, setNicknameEdited] = useState(false);
  const [status, setStatus] = useState<"idle" | "email" | "google">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [anonymousUserId, setAnonymousUserId] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    setAnonymousUserId(getAnonymousUserId());
  }, []);

  useEffect(() => {
    if (nicknameEdited) return;
    const trimmed = email.trim();
    if (!trimmed) {
      setNickname("");
      return;
    }
    const local = trimmed.split("@")[0] ?? "";
    const fallback = (local || trimmed).trim();
    setNickname(fallback.slice(0, 24));
  }, [email, nicknameEdited]);

  const handleEmailRegister = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status !== "idle") return;
    setStatus("email");
    setError(null);
    setDevLink(null);
    try {
      await fetch("/api/golf/active-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "email" }),
      });
      const res = await fetch("/api/golf/register/email/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          nickname,
          anonymousUserId: anonymousUserId || getAnonymousUserId(),
          next,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; devLink?: string; error?: string };
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "メール送信に失敗しました。");
      }
      setSent(true);
      if (typeof data.devLink === "string") setDevLink(data.devLink);
    } catch (err) {
      const message = err instanceof Error ? err.message : "メール送信に失敗しました。";
      setError(message);
    } finally {
      setStatus("idle");
    }
  };

  const handleGoogleRegister = async () => {
    if (status !== "idle") return;
    setStatus("google");
    setError(null);
    try {
      await fetch("/api/golf/active-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      });
      const callbackUrl = buildRedirectTarget(next, "/golf/history");
      const url = new URL(callbackUrl, window.location.origin);
      const anon = anonymousUserId || getAnonymousUserId();
      if (anon) {
        url.searchParams.set("anonymousUserId", anon);
      }
      await signIn("google", {
        callbackUrl: url.toString(),
      });
      resetMeUserStateCache();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Google登録に失敗しました。";
      setError(message);
    } finally {
      setStatus("idle");
    }
  };

  const isBusy = status !== "idle";

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-900/20 p-6 sm:p-8 space-y-6">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">Golf AI Trainer</p>
            <h1 className="text-2xl sm:text-3xl font-semibold leading-tight">スイングの履歴を保存して、成長を可視化しよう</h1>
            <p className="text-sm text-slate-300">
              メール登録またはGoogleでの登録で、無料診断を合計3回まで利用でき、診断履歴・スコア推移をいつでも確認できます。
              メール会員（無料）はクレジットカード不要。PROはクレジットカード決済でいつでも解約できます。
            </p>
          </div>

          <div className="grid gap-3 text-sm text-slate-200">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 rounded-full bg-emerald-400" />
              <p>メール登録で無料診断が生涯3回まで利用可能</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 rounded-full bg-emerald-400" />
              <p>過去の診断履歴・スコア推移を確認できます</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 rounded-full bg-emerald-400" />
              <p>無料登録はクレジットカード不要（PROはクレジットカード決済）</p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-rose-300 bg-rose-900/30 border border-rose-700/60 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {sent && !error && (
            <div className="text-sm text-emerald-200 bg-emerald-900/20 border border-emerald-700/40 rounded-lg px-3 py-2 space-y-2">
              <p>確認メールを送信しました。メール内のリンクをクリックして登録を完了してください。</p>
              {devLink && (
                <p className="break-all text-xs text-emerald-200/90">
                  開発用リンク:{" "}
                  <a className="underline underline-offset-4" href={devLink}>
                    {devLink}
                  </a>
                </p>
              )}
            </div>
          )}

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleGoogleRegister}
              disabled={isBusy}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-700 px-4 py-3 font-semibold text-slate-900 transition-colors"
            >
              {status === "google" ? "Googleで登録中…" : "Googleで登録"}
            </button>

            <form onSubmit={handleEmailRegister} className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-200">メールアドレスで登録</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-200">ニックネーム</label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => {
                    setNicknameEdited(true);
                    setNickname(e.target.value);
                  }}
                  placeholder="例) taro"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
                />
                <p className="text-[11px] text-slate-400">初期値はメールアドレスの @ より前が入ります（後から変更できます）</p>
              </div>
              <button
                type="submit"
                disabled={isBusy || !email}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 px-4 py-3 font-semibold text-slate-50 transition-colors"
              >
                {status === "email" ? "送信中…" : sent ? "もう一度送信する" : "認証メールを送信"}
              </button>
            </form>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-400 pt-2">
            <span suppressHydrationWarning>
              匿名ID: {(hydrated && anonymousUserId ? anonymousUserId.slice(0, 8) : "--------")}…
            </span>
            <Link href={next && next.startsWith("/") ? next : "/golf/history"} className="text-emerald-300 underline underline-offset-4">
              戻る
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
