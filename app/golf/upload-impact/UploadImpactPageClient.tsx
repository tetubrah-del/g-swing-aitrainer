"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { UserUsageState } from "@/app/golf/types";
import { getAnonymousUserId } from "@/app/golf/utils/historyStorage";
import { setActiveAnalysisPointer } from "@/app/golf/utils/reportStorage";
import { useUserState } from "@/app/golf/state/userState";
import { primeMeUserStateCache, resetMeUserStateCache, useMeUserState } from "@/app/golf/hooks/useMeUserState";

type SequenceFrameInput = { url: string; timestampSec?: number };

type PreviewResponse = {
  previewFrames?: SequenceFrameInput[];
  userState?: UserUsageState;
  error?: string;
  message?: string;
};

type AnalyzeResponse = {
  analysisId?: string;
  note?: string;
  userState?: UserUsageState;
  error?: string;
  message?: string;
};

export default function UploadImpactPageClient() {
  useMeUserState();
  const router = useRouter();
  const pathname = usePathname();
  const { state: userState, setUserState } = useUserState();

  const [file, setFile] = useState<File | null>(null);
  const [handedness, setHandedness] = useState<"right" | "left">("right");
  const [clubType, setClubType] = useState<"driver" | "iron" | "wedge">("driver");
  const [previewFrames, setPreviewFrames] = useState<SequenceFrameInput[] | null>(null);
  const [impactIndex, setImpactIndex] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [limitInfo, setLimitInfo] = useState<UserUsageState["monthlyAnalysis"] | null>(null);

  const anonymousUserId = useMemo(() => getAnonymousUserId(), []);
  const registerUrl = `/golf/register?next=${encodeURIComponent(pathname || "/golf/upload")}`;
  const isLoggedIn = !!(userState.isAuthenticated || userState.email || userState.userId);

  const headers = useMemo(() => {
    const out: Record<string, string> = {};
    if (userState.userId) out["x-user-id"] = userState.userId;
    if (userState.email) out["x-user-email"] = userState.email;
    if (userState.authProvider) out["x-auth-provider"] = userState.authProvider;
    return out;
  }, [userState.authProvider, userState.email, userState.userId]);

  useEffect(() => {
    if (!userState.hasProAccess && userState.monthlyAnalysis) {
      setLimitInfo(userState.monthlyAnalysis ?? null);
    } else if (userState.hasProAccess) {
      setLimitInfo(null);
    }
  }, [userState]);

  const resetSelection = () => {
    setPreviewFrames(null);
    setImpactIndex(null);
    setError(null);
    setQuotaExceeded(false);
  };

  const handleGeneratePreview = async () => {
    if (!file) {
      setError("スイング動画（または画像）を選択してください。");
      return;
    }
    setError(null);
    setQuotaExceeded(false);
    setLoadingPreview(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("previewOnly", "1");
      formData.append("previewMaxFrames", "60");
      if (anonymousUserId) formData.append("anonymousUserId", anonymousUserId);

      const res = await fetch("/api/golf/analyze", { method: "POST", body: formData, headers });
      const data = (await res.json().catch(() => ({}))) as PreviewResponse;
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "プレビューの生成に失敗しました。");
      }

      if (data.userState) {
        setUserState(data.userState);
        primeMeUserStateCache(data.userState);
      }

      const frames = Array.isArray(data.previewFrames) ? data.previewFrames.filter((f) => f && typeof f.url === "string") : [];
      if (!frames.length) throw new Error("プレビュー画像が取得できませんでした。");
      setPreviewFrames(frames);
      setImpactIndex(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "プレビューの生成に失敗しました。";
      setError(message);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setQuotaExceeded(false);

    if (!file) {
      setError("スイング動画（または画像）を選択してください。");
      return;
    }
    if (!previewFrames) {
      setError("先にプレビューを生成してください。");
      return;
    }
    if (impactIndex == null) {
      setError("ボールに当たった瞬間（インパクト）を1枚タップしてください。");
      return;
    }

    try {
      setSubmitting(true);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("handedness", handedness);
      formData.append("clubType", clubType);
      formData.append("level", "intermediate");
      formData.append("mode", "default");
      formData.append("impactIndex", String(impactIndex));
      if (anonymousUserId) formData.append("anonymousUserId", anonymousUserId);

      const res = await fetch("/api/golf/analyze", { method: "POST", body: formData, headers });
      const data = (await res.json().catch(() => ({}))) as AnalyzeResponse;

      if (!res.ok) {
        if (res.status === 429) {
          if (data?.userState) {
            setUserState(data.userState);
            primeMeUserStateCache(data.userState);
            if (!data.userState.hasProAccess && data.userState.monthlyAnalysis) {
              setLimitInfo(data.userState.monthlyAnalysis ?? null);
            }
          }
          setQuotaExceeded(true);
          const reason = data?.error;
          const quotaMessage =
            reason === "anonymous_limit"
              ? "無料診断の利用回数（未登録）は上限に達しました。続けるにはメール会員登録（無料）またはPROをご利用ください。"
              : reason === "free_limit"
                ? "無料診断の利用回数（メール会員）は上限に達しました。続けるにはPROをご利用ください。"
                : data?.message || data?.error || "利用回数超過により利用できません。";
          setError(quotaMessage);
          return;
        }
        throw new Error(data?.message || data?.error || "診断の実行に失敗しました。");
      }

      if (data.userState) {
        resetMeUserStateCache();
        setUserState(data.userState);
        primeMeUserStateCache(data.userState);
      }

      if (!data.analysisId) throw new Error("analysisId がレスポンスに含まれていません。");
      setActiveAnalysisPointer(data.analysisId, Date.now());
      router.push(`/golf/result/${encodeURIComponent(data.analysisId)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "診断の実行に失敗しました。";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex justify-center items-center bg-slate-950 text-slate-50">
      <div className="w-full max-w-5xl rounded-2xl bg-slate-900/70 border border-slate-700 p-6 space-y-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AIゴルフスイング診断</h1>
            <p className="text-xs text-slate-400 mt-1">プレビューから「ボールに当たった瞬間」を1枚タップ → その周辺16枚で解析します。</p>
          </div>
        </header>

        {!userState.hasProAccess && limitInfo && (
          <div className="rounded-lg border border-amber-400/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-amber-200">無料診断の利用状況（今月）</div>
                <div className="mt-1 font-medium">
                  {limitInfo.used ?? 0} / {limitInfo.limit ?? "-"} 回（残り {limitInfo.remaining ?? "-"} 回）
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!isLoggedIn && (
                  <button
                    type="button"
                    className="rounded-md border border-amber-200/60 bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/15"
                    onClick={() => router.push(registerUrl)}
                  >
                    メール会員登録（無料）
                  </button>
                )}
                {(limitInfo.remaining ?? 0) === 0 && (
                  <button
                    type="button"
                    className="rounded-md border border-emerald-200/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/25"
                    onClick={() => router.push("/pricing")}
                  >
                    PROにアップグレード
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${quotaExceeded ? "border-amber-400/60 bg-amber-500/10 text-amber-50" : "border-rose-400/60 bg-rose-500/10 text-rose-50"}`}>
            <div>{error}</div>
            {quotaExceeded && (
              <div className="mt-3 flex flex-wrap gap-2">
                {!isLoggedIn && (
                  <Link
                    href={registerUrl}
                    className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    メール会員登録（無料）
                  </Link>
                )}
                <Link
                  href="/pricing"
                  className="rounded-md border border-emerald-200/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/25"
                >
                  PROにアップグレード
                </Link>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
              <div className="text-sm font-semibold">ファイル</div>
              <input
                type="file"
                accept="video/*,image/*"
                className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-slate-100 hover:file:bg-slate-700"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  resetSelection();
                }}
              />
            </label>

            <label className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
              <div className="text-sm font-semibold">利き手</div>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm"
                value={handedness}
                onChange={(e) => setHandedness(e.target.value === "left" ? "left" : "right")}
              >
                <option value="right">右打ち</option>
                <option value="left">左打ち</option>
              </select>
            </label>

            <label className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
              <div className="text-sm font-semibold">クラブ</div>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm"
                value={clubType}
                onChange={(e) => {
                  const v = e.target.value;
                  setClubType(v === "iron" || v === "wedge" ? v : "driver");
                }}
              >
                <option value="driver">ドライバー</option>
                <option value="iron">アイアン</option>
                <option value="wedge">ウェッジ</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-slate-700 bg-slate-950/40 px-4 py-2 text-sm font-semibold hover:border-emerald-400 disabled:opacity-50"
              disabled={!file || loadingPreview || submitting}
              onClick={handleGeneratePreview}
            >
              {loadingPreview ? "プレビュー生成中…" : "プレビュー生成（40〜60枚）"}
            </button>

            <button
              type="submit"
              className="rounded-md border border-emerald-400/70 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-500/25 disabled:opacity-50"
              disabled={!file || !previewFrames || impactIndex == null || submitting || loadingPreview}
            >
              {submitting ? "解析中…" : "この周辺を解析する（16枚）"}
            </button>

            {previewFrames && (
              <button
                type="button"
                className="rounded-md border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
                onClick={resetSelection}
                disabled={loadingPreview || submitting}
              >
                リセット
              </button>
            )}
          </div>

          {previewFrames && (
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm text-slate-200">
                  ボールに当たった瞬間を1回タップしてください（index: {impactIndex ?? "-"} / {previewFrames.length - 1}）
                </div>
                <div className="text-xs text-slate-500">※ 解析はプレビュー全体ではなく、選択周辺の16枚のみ</div>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                {previewFrames.map((f, idx) => {
                  const selected = idx === impactIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`relative overflow-hidden rounded-md border ${selected ? "border-emerald-400" : "border-slate-800"} bg-slate-950/40 hover:border-slate-500`}
                      onClick={() => setImpactIndex(idx)}
                      title={`index=${idx}`}
                    >
                      <Image
                        src={f.url}
                        alt={`frame-${idx}`}
                        width={160}
                        height={120}
                        unoptimized
                        className="block w-full h-auto"
                      />
                      <div className={`absolute bottom-0 right-0 px-1.5 py-0.5 text-[10px] ${selected ? "bg-emerald-500/80 text-emerald-50" : "bg-slate-900/70 text-slate-200"}`}>
                        {idx}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </form>
      </div>
    </main>
  );
}
