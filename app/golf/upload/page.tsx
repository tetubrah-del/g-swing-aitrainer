import { Suspense } from "react";
import UploadPageClient from "./UploadPageClient";

export default function UploadPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
      <UploadPageClient />
    </Suspense>
  );
}

