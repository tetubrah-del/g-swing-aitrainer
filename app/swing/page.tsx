"use client";

import { useState, useTransition } from "react";

import { analyzeVideo, type AnalyzeVideoResult } from "../actions/analyzeVideo";

// Simple client page that accepts a video upload and renders the Vision JSON response
export default function SwingAnalyzerPage() {
  const [result, setResult] = useState<AnalyzeVideoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Server Action directly attached to <form action={…}>
  const handleServerAction = async (formData: FormData) => {
    // Guard against empty submissions
    const file = formData.get("video");
    if (!(file instanceof File)) {
      setError("動画ファイルを選択してください");
      return;
    }

    setError(null);
    setResult(null);

    startTransition(() => {
      analyzeVideo(formData)
        .then(setResult)
        .catch((err) => {
          console.error(err);
          setError(err instanceof Error ? err.message : "解析に失敗しました");
        });
    });
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Swing Analyzer (Vision JSON)</h1>
        <p className="text-sm text-gray-600">
          動画をアップロードすると、代表フレームを抽出し Vision API で JSON を生成します。
        </p>
      </header>

      <form
        className="flex flex-col gap-4 rounded-lg border p-4"
        action={handleServerAction}
        encType="multipart/form-data"
      >
        <label className="flex flex-col gap-2 text-sm font-medium text-gray-800">
          アップロードする動画
          <input
            type="file"
            name="video"
            accept="video/*"
            required
            className="rounded border px-3 py-2"
          />
        </label>

        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {isPending ? "解析中..." : "動画を解析する（Server Action）"}
        </button>
      </form>

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
                  <div className="text-xs text-gray-600">timestamp: {frame.timestampSec ? frame.timestampSec.toFixed(2) : "N/A"}s</div>
                  <img
                    src={`data:${frame.mimeType};base64,${frame.base64Image}`}
                    alt={frame.id}
                    className="h-auto w-full rounded"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-600">アップロード後に代表フレームが表示されます。</p>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-2 text-lg font-semibold">Vision JSON</h2>
          <pre className="max-h-[32rem] overflow-auto rounded bg-gray-950 p-3 text-xs text-green-200">
            {result ? JSON.stringify(result.vision, null, 2) : "結果がここに表示されます"}
          </pre>
        </section>
      </div>
    </div>
  );
}

