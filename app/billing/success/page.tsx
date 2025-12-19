import { Suspense } from "react";
import BillingSuccessClient from "./successClient";

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 text-slate-100" />}>
      <BillingSuccessClient />
    </Suspense>
  );
}
