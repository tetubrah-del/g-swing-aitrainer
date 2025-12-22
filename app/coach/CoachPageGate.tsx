"use client";

import { useMemo } from "react";
import CoachPageClient from "./CoachPageClient";
import GuidedCoachPageClient from "./GuidedCoachPageClient";
import { useMeUserState } from "@/app/golf/hooks/useMeUserState";
import { useUserState } from "@/app/golf/state/userState";
import { getFeatures } from "@/app/lib/features";

export default function CoachPageGate() {
  useMeUserState();
  const { state: userState } = useUserState();

  const features = useMemo(
    () => getFeatures({ remainingCount: userState.monthlyAnalysis?.remaining ?? null, isPro: userState.hasProAccess }),
    [userState.hasProAccess, userState.monthlyAnalysis?.remaining],
  );

  if (features.coach === "guided") {
    return <GuidedCoachPageClient />;
  }

  return <CoachPageClient />;
}

