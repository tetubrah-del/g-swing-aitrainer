"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { signOut } from "next-auth/react";
import { DEFAULT_USER_USAGE_STATE, useUserState } from "@/app/golf/state/userState";
import { resetMeUserStateCache } from "@/app/golf/hooks/useMeUserState";

function MobileBottomNavInner() {
  const router = useRouter();
  const pathname = usePathname();
  const { state: userState, setUserState } = useUserState();
  const [moreOpen, setMoreOpen] = useState(false);

  const showLogout = userState.isAuthenticated || userState.email || userState.userId;
  const accountLabel = userState.email || (userState.isAuthenticated ? "ログイン中" : "ゲスト");
  const planLabel = userState.plan ? `プラン: ${userState.plan}` : "プラン: -";

  const startsWithAny = useCallback(
    (prefixes: string[]) => {
      if (!pathname) return false;
      return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix));
    },
    [pathname],
  );

  const diagnosisActive = startsWithAny([
    "/golf/upload",
    "/golf/upload-beta",
    "/golf/upload-impact",
    "/golf/result",
    "/golf/result-beta",
    "/golf/swing-type",
    "/golf/register",
  ]);
  const historyActive = startsWithAny(["/golf/history"]);
  const coachActive = startsWithAny(["/coach"]);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  const loginHref = useMemo(() => {
    const next = pathname || "/golf/upload";
    return `/golf/register?next=${encodeURIComponent(next)}`;
  }, [pathname]);

  const handleLogout = useCallback(async () => {
    closeMore();
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
  }, [closeMore, pathname, router, setUserState]);

  return (
    <>
      {moreOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          aria-hidden="true"
          onClick={closeMore}
        />
      )}

      {moreOpen && (
        <div
          id="mobile-more-menu"
          className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[60] px-3"
          role="dialog"
          aria-modal="true"
          aria-label="その他"
        >
          <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/95 backdrop-blur shadow-xl">
            <div className="px-4 py-3 border-b border-slate-800">
              <div className="text-xs text-slate-400">アカウント</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="truncate text-sm text-slate-100" title={accountLabel}>
                  {accountLabel}
                </div>
                <div className="shrink-0 text-xs text-slate-400">{planLabel}</div>
              </div>
            </div>
            <nav className="flex flex-col">
              <Link
                onClick={closeMore}
                href="/account/billing"
                className="px-4 py-3 text-sm text-slate-100 hover:bg-slate-900/60"
              >
                お支払い・解約
              </Link>
              {!showLogout ? (
                <Link
                  onClick={closeMore}
                  href={loginHref}
                  className="px-4 py-3 text-sm text-emerald-200 hover:bg-slate-900/60"
                >
                  ログイン/登録
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-left px-4 py-3 text-sm text-rose-200 hover:bg-slate-900/60"
                >
                  ログアウト
                </button>
              )}
              <button
                type="button"
                onClick={closeMore}
                className="text-left px-4 py-3 text-sm text-slate-200 hover:bg-slate-900/60"
              >
                閉じる
              </button>
            </nav>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-[60]">
        <div className="border-t border-slate-800 bg-slate-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-stretch justify-between px-2 pb-[env(safe-area-inset-bottom)]">
            <TabLink href="/golf/upload" active={diagnosisActive} onNavigate={closeMore}>
              診断
            </TabLink>
            <TabLink href="/golf/history" active={historyActive} onNavigate={closeMore}>
              履歴
            </TabLink>
            <TabLink href="/coach" active={coachActive} onNavigate={closeMore}>
              AIコーチ
            </TabLink>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className={[
                "flex flex-1 flex-col items-center justify-center gap-1 py-3 text-xs",
                moreOpen ? "text-emerald-200" : "text-slate-200",
              ].join(" ")}
              aria-expanded={moreOpen}
              aria-controls="mobile-more-menu"
            >
              アカウント
            </button>
          </div>
        </div>
      </nav>
    </>
  );
}

function TabLink(props: {
  href: string;
  active: boolean;
  onNavigate?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={props.href}
      onClick={props.onNavigate}
      className={[
        "flex flex-1 flex-col items-center justify-center gap-1 py-3 text-xs",
        props.active ? "text-emerald-200" : "text-slate-200",
      ].join(" ")}
    >
      {props.children}
    </Link>
  );
}

// Disable SSR to avoid hydration mismatches caused by client-only state (user state / open menu)
const MobileBottomNav = dynamic(() => Promise.resolve(MobileBottomNavInner), { ssr: false });

export default MobileBottomNav;
