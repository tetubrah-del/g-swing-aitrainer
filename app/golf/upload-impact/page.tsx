import { Suspense } from "react";
import UploadImpactPageClient from "./UploadImpactPageClient";

export default function UploadImpactPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <UploadImpactPageClient />
    </Suspense>
  );
}

