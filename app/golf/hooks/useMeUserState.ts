import { useEffect } from "react";
import { useUserState } from "@/app/golf/state/userState";
import type { UserUsageState } from "@/app/golf/types";

let cachedUserState: UserUsageState | null = null;
let pendingMePromise: Promise<UserUsageState | null> | null = null;

const fetchMeOnce = async (): Promise<UserUsageState | null> => {
  if (cachedUserState) return cachedUserState;
  if (pendingMePromise) return pendingMePromise;
  pendingMePromise = (async () => {
    try {
      const res = await fetch("/api/golf/me", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { userState?: UserUsageState };
      cachedUserState = data?.userState ?? null;
      return cachedUserState;
    } catch {
      return null;
    } finally {
      pendingMePromise = null;
    }
  })();
  return pendingMePromise;
};

export const useMeUserState = () => {
  const { setUserState } = useUserState();

  useEffect(() => {
    let cancelled = false;
    fetchMeOnce().then((userState) => {
      if (!cancelled && userState) {
        setUserState(userState);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setUserState]);
};

// utility to clear cache (e.g., after registration redirect)
export const resetMeUserStateCache = () => {
  cachedUserState = null;
  pendingMePromise = null;
};
