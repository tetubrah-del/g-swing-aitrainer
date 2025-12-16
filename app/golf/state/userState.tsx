'use client';

import { createContext, ReactNode, useContext, useMemo, useState } from "react";
import { UserUsageState } from "@/app/golf/types";

type UserStateContextValue = {
  state: UserUsageState;
  setUserState: (next: UserUsageState) => void;
};

const DEFAULT_STATE: UserUsageState = {
  isAuthenticated: false,
  hasProAccess: false,
  isMonitor: false,
  plan: "anonymous",
  email: null,
  userId: null,
  anonymousUserId: null,
  freeAnalysisCount: 0,
  authProvider: null,
  monthlyAnalysis: undefined,
};

const STORAGE_KEY = "golf_user_state";

const UserStateContext = createContext<UserStateContextValue>({
  state: DEFAULT_STATE,
  setUserState: () => {},
});

const normalizeState = (value: UserUsageState | null | undefined): UserUsageState => {
  if (!value || typeof value !== "object") return DEFAULT_STATE;
  const monthly = value.monthlyAnalysis;
  const normalizedProvider =
    value.authProvider === "google" || value.authProvider === "email" ? value.authProvider : null;
  return {
    isAuthenticated: !!value.isAuthenticated,
    hasProAccess: !!value.hasProAccess,
    isMonitor: value.hasProAccess ? value.isMonitor === true : false,
    plan:
      value.plan === "pro" || value.plan === "free" || value.plan === "anonymous"
        ? value.plan
      : value.hasProAccess
        ? "pro"
        : value.isAuthenticated
          ? "free"
          : "anonymous",
    email: typeof value.email === "string" ? value.email : null,
    userId: typeof value.userId === "string" ? value.userId : null,
    anonymousUserId: typeof value.anonymousUserId === "string" ? value.anonymousUserId : null,
    freeAnalysisCount: Number.isFinite(value.freeAnalysisCount) ? Number(value.freeAnalysisCount) : 0,
    authProvider: normalizedProvider,
    monthlyAnalysis:
      monthly && typeof monthly === "object"
        ? {
            used: Number.isFinite(monthly.used) ? Number(monthly.used) : 0,
            limit: monthly.limit === null ? null : Number.isFinite(monthly.limit) ? Number(monthly.limit) : null,
            remaining:
              monthly.remaining === null ? null : Number.isFinite(monthly.remaining) ? Number(monthly.remaining) : null,
          }
        : undefined,
  };
};

const loadState = (): UserUsageState => {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as unknown;
    return normalizeState(parsed as UserUsageState);
  } catch {
    return DEFAULT_STATE;
  }
};

const persistState = (state: UserUsageState) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
};

export const UserStateProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<UserUsageState>(() => loadState());

  const value = useMemo<UserStateContextValue>(
    () => ({
      state,
      setUserState: (next) => {
        const normalized = normalizeState(next);
        setState(normalized);
        persistState(normalized);
      },
    }),
    [state]
  );

  return <UserStateContext.Provider value={value}>{children}</UserStateContext.Provider>;
};

export const useUserState = (): UserStateContextValue => useContext(UserStateContext);
