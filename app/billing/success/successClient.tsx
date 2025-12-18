"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { resetMeUserStateCache } from "@/app/golf/hooks/useMeUserState";

export default function BillingSuccessClient() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params?.get("session_id") ?? null;
  const [status, setStatus] = useState<"syncing" | "done" | "error">("syncing");

  const label = useMemo(() => {
    if (status === "done") return "反映しました。画面を更新します…";
    if (status === "error") return "反映に失敗しました。しばらくして再読み込みしてください。";
    return "決済を確認しています…";
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sessionId) {
        setStatus("error");
        return;
      }
      try {
        const res = await fetch("/api/billing/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (!res.ok) throw new Error("sync_failed");
        if (cancelled) return;
        setStatus("done");
        resetMeUserStateCache();
        router.replace("/account/billing");
        router.refresh();
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, sessionId]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-xl font-semibold">購入完了</h1>
        <p className="mt-3 text-sm text-slate-300">{label}</p>
      </div>
    </main>
  );
}

