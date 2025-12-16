"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useUserState } from "@/app/golf/state/userState";
import { getAnonymousUserId } from "@/app/golf/utils/historyStorage";
import type { UserUsageState } from "@/app/golf/types";
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const { setUserState } = useUserState();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "email" | "google">("idle");
  const [error, setError] = useState<string | null>(null);
  const anonymousUserId = useMemo(() => getAnonymousUserId(), []);

  const redirectBack = () => {
    const target = buildRedirectTarget(next, "/golf/history");
    router.push(target);
  };

  const handleEmailRegister = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status !== "idle") return;
    setStatus("email");
    setError(null);
    try {
      const res = await fetch("/api/golf/register/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, anonymousUserId }),
      });
      const data = (await res.json().catch(() => ({}))) as { userState?: unknown; error?: string };
      if (!res.ok || !data?.userState || typeof data.userState !== "object") {
        throw new Error(data?.error || "登録に失敗しました。");
      }
      setUserState(data.userState as UserUsageState);
      redirectBack();
    } catch (err) {
      const message = err instanceof Error ? err.message : "登録に失敗しました。";
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
      const callbackUrl = buildRedirectTarget(next, "/golf/history");
      const url = new URL(callbackUrl, window.location.origin);
      if (anonymousUserId) {
        url.searchParams.set("anonymousUserId", anonymousUserId);
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
              クレジットカードは不要です。
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
              <p>クレジットカード登録は不要</p>
            </div>
          </div>

          {error && <p className="text-sm text-rose-300 bg-rose-900/30 border border-rose-700/60 rounded-lg px-3 py-2">{error}</p>}

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
              <button
                type="submit"
                disabled={isBusy || !email}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 px-4 py-3 font-semibold text-slate-50 transition-colors"
              >
                {status === "email" ? "登録中…" : "メールアドレスで登録"}
              </button>
            </form>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-400 pt-2">
            <span>匿名ID: {anonymousUserId.slice(0, 8)}…</span>
            <Link href={next && next.startsWith("/") ? next : "/golf/history"} className="text-emerald-300 underline underline-offset-4">
              戻る
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
