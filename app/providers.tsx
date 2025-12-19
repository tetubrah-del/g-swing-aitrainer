'use client';

import { ReactNode } from "react";
import { UserStateProvider } from "@/app/golf/state/userState";
import AccountMenu from "@/app/components/AccountMenu";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <UserStateProvider>
      <AccountMenu />
      {children}
    </UserStateProvider>
  );
}
