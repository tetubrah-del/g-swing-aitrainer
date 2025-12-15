'use client';

import { ReactNode } from "react";
import { UserStateProvider } from "@/app/golf/state/userState";

export default function Providers({ children }: { children: ReactNode }) {
  return <UserStateProvider>{children}</UserStateProvider>;
}
