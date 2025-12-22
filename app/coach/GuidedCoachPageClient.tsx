"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMeUserState } from "@/app/golf/hooks/useMeUserState";
import { useUserState } from "@/app/golf/state/userState";
import { getActiveAnalysisPointer, getLatestReport } from "@/app/golf/utils/reportStorage";
import ProUpsellModal from "@/app/components/ProUpsellModal";

type GuidedCoachResponse = {
  keyImprovement: string;
  recommendedDrill: string;
  nextQuestions: [string, string, string];
};

type GuidedCoachReplyResponse = {
  reply: string;
};

const NO_DIAGNOSIS_MESSAGE =
  "まずはスイング診断をしてください。「診断する」から動画をアップロードして、診断結果が出たらここで改善点を確認できます。";

type LocalState = {
  initial?: GuidedCoachResponse;
  question?: string;
  reply?: string;
  used?: boolean;
};

const safeParse = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export default function GuidedCoachPageClient() {
  useMeUserState();
  const { state: userState } = useUserState();
  const searchParams = useSearchParams();

  const analysisIdFromQuery = searchParams?.get("analysisId");
  const [analysisId, setAnalysisId] = useState<string | null>(analysisIdFromQuery ?? null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GuidedCoachResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (analysisIdFromQuery) {
      setAnalysisId(analysisIdFromQuery);
      return;
    }

    const pointer = getActiveAnalysisPointer();
    if (pointer?.analysisId) {
      setAnalysisId(pointer.analysisId);
      return;
    }

    const latest = getLatestReport();
    if (latest?.analysisId) {
      setAnalysisId(latest.analysisId);
      return;
    }

    setAnalysisId(null);
  }, [analysisIdFromQuery]);

  useEffect(() => {
    let cancelled = false;
    if (!analysisId) return;

    const run = async () => {
      try {
        setLoading(true);
        setError(null);
        setData(null);

        const actorId = userState.userId ? `user:${userState.userId}` : userState.anonymousUserId ? `anon:${userState.anonymousUserId}` : "unknown";
        const storageKey = `free_coach_state:${actorId}:${analysisId}`;
        const cached = safeParse<LocalState>(typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null);
        if (cached?.initial) {
          setData(cached.initial);
          setQuestion(cached.question ?? "");
          setReply(cached.reply ?? null);
          setUsed(!!cached.used || !!cached.reply);
          return;
        }

        const res = await fetch("/api/coach/guided", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ analysisId, mode: "init" }),
        });
        const json = (await res.json().catch(() => null)) as GuidedCoachResponse | { error?: string } | null;
        if (!res.ok) {
          const message = (json && typeof json === "object" && "error" in json && json.error) || "AIコーチの取得に失敗しました";
          throw new Error(message);
        }
        if (!json || typeof json !== "object") throw new Error("invalid response");
        const parsed = json as GuidedCoachResponse;
        if (!cancelled) {
          setData(parsed);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(storageKey, JSON.stringify({ initial: parsed } satisfies LocalState));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "AIコーチの取得に失敗しました";
        if (!cancelled) setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [analysisId, userState.anonymousUserId, userState.userId]);

  const hasDiagnosis = !!analysisId;
  const showUpgrade = userState.isAuthenticated;

  const bubbles = useMemo(() => {
    if (!hasDiagnosis) {
      return [{ role: "assistant" as const, text: NO_DIAGNOSIS_MESSAGE }];
    }
    if (loading) {
      return [{ role: "assistant" as const, text: "AIコーチが診断内容を整理しています…" }];
    }
    if (error) {
      return [{ role: "assistant" as const, text: `エラー: ${error}` }];
    }
    if (!data) {
      return [{ role: "assistant" as const, text: "AIコーチの回答を準備しています…" }];
    }
    const out: Array<{ role: "assistant" | "user"; text: string }> = [
      {
        role: "assistant",
        text: `最優先の改善ポイント: ${data.keyImprovement}\n\nおすすめドリル: ${data.recommendedDrill}`,
      },
    ];
    if (question.trim()) {
      out.push({ role: "user", text: question.trim() });
    }
    if (reply) {
      out.push({ role: "assistant", text: reply });
    }
    return out;
  }, [data, error, hasDiagnosis, loading, question, reply]);

  const canAsk = hasDiagnosis && !!data && !loading && !error && !used;

  const sendOnce = async (text: string) => {
    if (!analysisId) return;
    if (!data) return;
    const message = text.trim();
    if (!message) return;
    if (sending || used) return;

    const actorId = userState.userId ? `user:${userState.userId}` : userState.anonymousUserId ? `anon:${userState.anonymousUserId}` : "unknown";
    const storageKey = `free_coach_state:${actorId}:${analysisId}`;

    setSending(true);
    setError(null);
    setQuestion(message);

    try {
      const res = await fetch("/api/coach/guided", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisId, mode: "reply", message }),
      });

      const json = (await res.json().catch(() => null)) as GuidedCoachReplyResponse | { error?: string } | null;

      if (!res.ok) {
        const errCode = json && typeof json === "object" && "error" in json ? json.error : null;
        if (res.status === 403 && errCode === "free_coach_chat_used") {
          setUsed(true);
          if (typeof window !== "undefined") {
            const prev = safeParse<LocalState>(window.localStorage.getItem(storageKey)) ?? {};
            window.localStorage.setItem(storageKey, JSON.stringify({ ...prev, initial: prev.initial ?? data, question: message, used: true }));
          }
          return;
        }
        throw new Error(errCode || "送信に失敗しました");
      }

      const replyText = json && typeof json === "object" && "reply" in json && typeof json.reply === "string" ? json.reply : "";
      setReply(replyText);
      setUsed(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ initial: data, question: message, reply: replyText, used: true } satisfies LocalState),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "送信に失敗しました";
      setError(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-3xl px-4 py-8 space-y-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AIコーチ（体験版）</h1>
            <p className="text-xs text-slate-400 mt-1">初期メッセージ + 質問1回 + 回答1回（以降ロック）</p>
            <p className="text-[11px] text-slate-500 mt-1">※体験版は診断サマリから回答します（動画/画像の直接判定はPRO）</p>
          </div>
          <Link
            href={analysisId ? `/golf/result/${encodeURIComponent(analysisId)}` : "/golf/upload"}
            className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-200"
          >
            診断結果へ
          </Link>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4 space-y-3">
          {bubbles.map((b, idx) => (
            <div key={idx} className={`flex ${b.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm ${
                  b.role === "user" ? "bg-emerald-900/30 border border-emerald-700/30 text-emerald-50" : "bg-slate-800/70 text-slate-100"
                }`}
              >
                {b.text}
              </div>
            </div>
          ))}
        </section>

        {data?.nextQuestions?.length ? (
          <section className="space-y-2">
            <p className="text-xs text-slate-400">質問候補（体験版では1回のみ質問できます）</p>
            <div className="flex flex-wrap gap-2">
              {data.nextQuestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!canAsk || sending}
                  onClick={() => setQuestion(q)}
                  className="rounded-full border border-slate-700 bg-slate-900/30 px-3 py-2 text-xs text-slate-100 hover:border-emerald-400/70 hover:bg-slate-900/50 disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold">質問（1回のみ）</div>
            <div className="text-xs text-slate-400">※体験版では1回のみ質問できます</div>
          </div>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={!canAsk || sending}
            rows={3}
            className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-60"
            placeholder="改善点について質問してください（例：自宅練習でもできますか？）"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!canAsk || sending || !question.trim()}
              onClick={() => void sendOnce(question)}
              className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
            >
              {sending ? "送信中..." : "送信"}
            </button>
          </div>
        </section>

        {used && (
          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-900/10 p-4 space-y-2">
            <p className="text-sm text-emerald-50">
              ここから先は、あなたの履歴を踏まえた継続コーチングになります。PROでAIコーチと会話を続けましょう。
            </p>
            <p className="text-xs text-emerald-100/90">
              PROなら診断結果の動画/画像も参照しながら、スイングに合わせた具体フィードバックができます。
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setUpsellOpen(true)}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
              >
                PROで続ける
              </button>
            </div>
          </section>
        )}

        <ProUpsellModal
          open={upsellOpen}
          onClose={() => setUpsellOpen(false)}
          title="ここから先はPROで相談できます"
          message={showUpgrade ? "PROならフリーチャットで深掘りできます。" : "メール登録後にPROへアップグレードできます。"}
          ctaHref={showUpgrade ? "/pricing" : `/golf/register?next=${encodeURIComponent("/pricing")}`}
          ctaLabel={showUpgrade ? "PROにアップグレード" : "登録してPROを見る"}
        />
      </div>
    </main>
  );
}
