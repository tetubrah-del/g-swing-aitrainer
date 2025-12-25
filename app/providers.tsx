'use client';

import { ReactNode } from "react";
import { UserStateProvider } from "@/app/golf/state/userState";
import MobileBottomNav from "@/app/components/MobileBottomNav";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <UserStateProvider>
      <div className="min-h-dvh pb-[calc(4.25rem+env(safe-area-inset-bottom))]">{children}</div>
      <MobileBottomNav />
    </UserStateProvider>
  );
}
