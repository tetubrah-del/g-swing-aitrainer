import { Suspense } from "react";
import CoachPageGate from "./CoachPageGate";

export default function CoachPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <CoachPageGate />
    </Suspense>
  );
}
