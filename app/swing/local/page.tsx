"use client";

import { useCallback, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  ClientPhaseFrames,
  extractClientPhaseFrames,
} from "@/app/lib/client/extractClientPhaseFrames";

const phaseOrder: Array<keyof ClientPhaseFrames> = [
  "address",
  "top",
  "downswing",
  "impact",
  "finish",
];

export default function LocalSwingPage() {
  const [file, setFile] = useState<File | null>(null);
  const [frames, setFrames] = useState<ClientPhaseFrames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const phaseList = useMemo(() => {
    if (!frames) return [];
    return phaseOrder.map((phase) => ({ key: phase, frame: frames[phase] }));
  }, [frames]);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files?.[0];
      setFile(selected ?? null);
      setError(null);
      setFrames(null);
    },
    []
  );

  const handleExtract = useCallback(async () => {
    if (!file) {
      setError("動画を選択してください");
      return;
    }

    setIsLoading(true);
    setError(null);
    setFrames(null);

    try {
      const result = await extractClientPhaseFrames(file);
      setFrames(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "抽出に失敗しました");
    } finally {
      setIsLoading(false);
    }
  }, [file]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">クライアント側フェーズ抽出デバッグ</h1>
        <p className="text-sm text-gray-600">
          スマートフォン/ブラウザで動画からアドレス〜フィニッシュの各フェーズを抽出します。
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-gray-700">動画ファイルを選択</label>
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            className="mt-2 block w-full text-sm"
          />
        </div>

        <button
          onClick={handleExtract}
          disabled={isLoading}
          className="inline-flex w-fit items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white shadow disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {isLoading ? "抽出中..." : "クライアント側でフェーズ抽出"}
        </button>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {phaseList.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold">抽出結果</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {phaseList.map(({ key, frame }) => (
              <div key={frame.id} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between text-sm font-medium">
                  <span className="capitalize">{key}</span>
                  <span className="text-gray-500">{(frame.timestampSec ?? 0).toFixed(2)}s</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${frame.mimeType};base64,${frame.base64Image}`}
                  alt={`${key} frame`}
                  className="h-auto w-full rounded"
                />
              </div>
            ))}
          </div>
          {frames?.debug && (
            <div className="rounded border border-gray-200 bg-white p-3 shadow-sm">
              <h3 className="mb-2 text-lg font-semibold">Debug</h3>
              <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(frames.debug, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

