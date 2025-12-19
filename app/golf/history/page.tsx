import { Suspense } from "react";
import HistoryPageClient from "./HistoryPageClient";

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <HistoryPageClient />
    </Suspense>
  );
}

