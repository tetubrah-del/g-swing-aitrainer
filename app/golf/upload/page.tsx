import { Suspense } from "react";
import UploadImpactPageClient from "../upload-impact/UploadImpactPageClient";

export default function UploadPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <UploadImpactPageClient />
    </Suspense>
  );
}
