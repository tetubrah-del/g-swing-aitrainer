/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
import type { AnalyzeVideoResult } from "../actions/analyzeVideo";

// 🔥 Client Component（結果表示専用）
export default function SwingAnalyzerClient() {
  const [result, setResult] = useState<AnalyzeVideoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Next.js Server Actions の結果を受け取る仕組み
  if (typeof window !== "undefined") {
    // @ts-expect-error Next.js 内部で仕込まれる Action 結果を拾う
    window.__ACTION_RESULT__?.then?.((data: any) => {
      if (!data) return;

      if (data.error) setError(data.error);
      else setResult(data);

      // eslint-disable-next-line react-hooks/immutability
      window.__ACTION_RESULT__ = null; // 一度だけ
    });
  }

  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 text-lg font-semibold">代表フレーム (PhaseFrame[])</h2>

          {result?.frames?.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {result.frames.map((frame) => (
                <li key={frame.id} className="space-y-1 rounded border p-2 text-sm">
                  <div className="font-semibold">{frame.id}</div>
                  <div className="text-xs text-gray-600">{frame.mimeType}</div>
                  <div className="text-xs text-gray-600">
                    timestamp:{" "}
                    {frame.timestampSec
                      ? frame.timestampSec.toFixed(2)
                      : "N/A"}
                    s
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${frame.mimeType};base64,${frame.base64Image}`}
                    alt={frame.id}
                    className="h-auto w-full rounded"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-600">
              アップロード後に代表フレームが表示されます。
            </p>
          )}
        </section>
      </div>
    </>
  );
}
