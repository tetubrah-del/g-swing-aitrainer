import { Suspense } from "react";
import CoachPageClient from "./CoachPageClient";

export default function CoachPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <CoachPageClient />
    </Suspense>
  );
}

