"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import dynamic from "next/dynamic";
import { useUserState, DEFAULT_USER_USAGE_STATE } from "@/app/golf/state/userState";
import { resetMeUserStateCache } from "@/app/golf/hooks/useMeUserState";

function AccountMenuInner() {
  const router = useRouter();
  const pathname = usePathname();
  const { state: userState, setUserState } = useUserState();
  const [open, setOpen] = useState(false);

  const label = useMemo(() => {
    if (userState.email) return userState.email;
    if (userState.isAuthenticated) return "ログイン中";
    return "ゲスト";
  }, [userState.email, userState.isAuthenticated]);

  const close = useCallback(() => setOpen(false), []);

  const handleLogout = useCallback(async () => {
    close();
    resetMeUserStateCache();
    setUserState(DEFAULT_USER_USAGE_STATE);
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
    if (pathname?.startsWith("/golf") || pathname?.startsWith("/coach")) {
      router.refresh();
    }
  }, [close, pathname, router, setUserState]);

  const showLogout = userState.isAuthenticated || userState.email || userState.userId;

  return (
    <div className="fixed right-4 top-4 z-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-slate-700 bg-slate-950/80 backdrop-blur px-3 py-2 text-xs text-slate-100 hover:border-emerald-400/60"
      >
        {label}
      </button>

      {open && (
        <div className="mt-2 w-56 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur shadow-xl">
          <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-800">
            {userState.plan ? `プラン: ${userState.plan}` : "プラン: -"}
          </div>
          <nav className="flex flex-col">
            <Link onClick={close} href="/golf/upload" className="px-3 py-2 text-sm text-slate-100 hover:bg-slate-900/60">
              診断する
            </Link>
            <Link onClick={close} href="/golf/history" className="px-3 py-2 text-sm text-slate-100 hover:bg-slate-900/60">
              履歴
            </Link>
            <Link onClick={close} href="/coach" className="px-3 py-2 text-sm text-slate-100 hover:bg-slate-900/60">
              AIコーチ
            </Link>
            <Link
              onClick={close}
              href="/account/billing"
              className="px-3 py-2 text-sm text-slate-100 hover:bg-slate-900/60"
            >
              お支払い・解約
            </Link>
            {!showLogout ? (
              <Link
                onClick={close}
                href={`/golf/register?next=${encodeURIComponent(pathname || "/golf/upload")}`}
                className="px-3 py-2 text-sm text-emerald-200 hover:bg-slate-900/60"
              >
                ログイン/登録
              </Link>
            ) : (
              <button
                type="button"
                onClick={handleLogout}
                className="text-left px-3 py-2 text-sm text-rose-200 hover:bg-slate-900/60"
              >
                ログアウト
              </button>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}

// Disable SSR to avoid hydration mismatches caused by client-only state (open menu, user state)
const AccountMenu = dynamic(() => Promise.resolve(AccountMenuInner), { ssr: false });

export default AccountMenu;
