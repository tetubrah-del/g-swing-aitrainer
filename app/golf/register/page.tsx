import { Suspense } from "react";
import RegisterPageClient from "./RegisterPageClient";

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <RegisterPageClient />
    </Suspense>
  );
}

