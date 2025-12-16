'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  CoachCausalImpactExplanation,
  CoachMessage,
  CoachQuickReply,
  CoachThread,
  ThreadSummary,
} from '@/app/coach/types';
import { buildCoachContext } from '@/app/coach/utils/context';
import {
  appendMessages,
  getOrCreateActiveThread,
  hasDismissedQuickReplies,
  loadBootstrapContext,
  loadCausalContext,
  loadMessages,
  loadThreadSummary,
  markQuickRepliesDismissed,
  saveCausalContext,
  saveThreadSummary,
  updateThreadMetadata,
} from '@/app/coach/utils/storage';
import { getAnonymousUserId } from '@/app/golf/utils/historyStorage';
import { getLatestReport, getMostRecentReportWithSequence, getReportById, saveReport } from '@/app/golf/utils/reportStorage';
import type { GolfAnalysisResponse } from '@/app/golf/types';

const QUICK_REPLIES: CoachQuickReply[] = [
  { key: 'cause-detail', label: '原因を詳しく知りたい', value: 'この原因がスコアにどう響くか、もう少し詳しく教えて。' },
  { key: 'practice', label: '練習方法を具体的に知りたい', value: '次の練習で何を1つだけ意識すればいい？具体的なメニューで教えて。' },
  { key: 'checkpoint', label: '次の動画で何ができていればOK？', value: '次に動画を撮るとき、どこができていれば合格か教えて。' },
  { key: 'other-factors', label: '他に考えられる要因は？', value: '他に考えられる要因があれば、優先度順に1つだけ教えて。' },
];

const SYSTEM_PERSONA =
  'あなたは専属のAIゴルフコーチです。診断結果を踏まえ、常に1つの改善テーマに絞って、次の練習・次回動画撮影で確認できる行動を具体的に提示します。';

const confidenceLabel = (value?: number) => {
  if (typeof value !== 'number') return 'medium';
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
};

const confidenceDisplay = (value?: number) => {
  const label = confidenceLabel(value);
  if (label === 'high') return 'high';
  if (label === 'medium') return 'medium';
  return 'low / 参考推定';
};

const chainSummary = (chain?: string[]) => {
  if (!chain || !chain.length) return '因果チェーンを準備中';
  return chain.join(' → ');
};

const resolveAnalysisIdFromMessages = (messages: CoachMessage[]): string | null => {
  const reversed = [...messages].reverse();
  const found = reversed.find((m) => typeof m.analysisId === 'string' && m.analysisId.length > 0);
  return found?.analysisId ?? null;
};

const buildSummaryText = (context: CoachCausalImpactExplanation | null, messages: CoachMessage[]): string => {
  const latestAssistant = [...messages].filter((m) => m.role === 'assistant').slice(-2).map((m) => m.content).join(' / ');
  const latestUser = [...messages].filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' / ');
  return [
    `primary: ${context?.primaryFactor ?? '未設定'}`,
    latestAssistant ? `直近コーチ: ${latestAssistant}` : '',
    latestUser ? `直近ユーザー: ${latestUser}` : '',
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 520);
};

const CoachPage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatRef = useRef<HTMLDivElement | null>(null);
  const seededContextRef = useRef(false);

const swingTypeFromQuery = searchParams?.get('swingType') || '';
const analysisIdFromQuery = searchParams?.get('analysisId') || '';

  const [userId, setUserId] = useState('');
  const [thread, setThread] = useState<CoachThread | null>(null);
  const [analysisContext, setAnalysisContext] = useState<CoachCausalImpactExplanation | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [summary, setSummary] = useState<ThreadSummary | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(40);
  const [showQuickReplies, setShowQuickReplies] = useState(true);
  const sendingRef = useRef(false);
  const ensureReportSavedRef = useRef(false);

  const visibleMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount]);

  const groupedSections = useMemo(() => {
    const sections: Array<{ analysisId?: string; messages: CoachMessage[] }> = [];
    visibleMessages.forEach((msg) => {
      const last = sections[sections.length - 1];
      if (!last || last.analysisId !== (msg.analysisId || last.analysisId)) {
        sections.push({ analysisId: msg.analysisId, messages: [msg] });
      } else {
        last.messages.push(msg);
      }
    });
    return sections;
  }, [visibleMessages]);

  const collapsedState = useMemo(() => {
    const state: Record<string, boolean> = {};
    groupedSections.forEach((section, idx) => {
      const key = section.analysisId || `section-${idx}`;
      const isLatest =
        (analysisContext?.analysisId && section.analysisId === analysisContext.analysisId) ||
        idx === groupedSections.length - 1;
      state[key] = !isLatest;
    });
    return state;
  }, [analysisContext?.analysisId, groupedSections]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsed((prev) => ({ ...collapsedState, ...prev }));
  }, [collapsedState]);

  useEffect(() => {
    const id = getAnonymousUserId();
    setUserId(id || '');
    const activeThread = getOrCreateActiveThread(id);
    setThread(activeThread);
    const storedMessages = loadMessages(activeThread?.threadId ?? null);
    setMessages(storedMessages);
    setSummary(loadThreadSummary(activeThread?.threadId ?? null));
    setShowQuickReplies(!hasDismissedQuickReplies(activeThread?.threadId ?? null));
  }, []);

  useEffect(() => {
    if (!thread || !userId) return;

    const storedContext = loadCausalContext(thread.threadId);
    const bootstrap = loadBootstrapContext(userId);
    const bootstrapReport = bootstrap?.analysisId ? getReportById(bootstrap.analysisId) : null;
    const queryReport = analysisIdFromQuery ? getReportById(analysisIdFromQuery) : null;

    // stored と bootstrap で analysisId が異なる場合は bootstrap を優先して上書き
    if (bootstrap && bootstrap.analysisId && storedContext?.analysisId !== bootstrap.analysisId) {
      saveCausalContext(thread.threadId, bootstrap);
      updateThreadMetadata(thread, { lastAnalysisId: bootstrap.analysisId });
      const ctx = swingTypeFromQuery ? { ...bootstrap, swingTypeHeadline: swingTypeFromQuery } : bootstrap;
      setAnalysisContext(ctx);
      seededContextRef.current = true;
      setIsLoading(false);
      return;
    }

    if (storedContext) {
      const ctx = swingTypeFromQuery ? { ...storedContext, swingTypeHeadline: swingTypeFromQuery } : storedContext;
      setAnalysisContext(ctx);
      seededContextRef.current = true;
      setIsLoading(false);
      return;
    }

    const threadReport = thread.lastAnalysisId ? getReportById(thread.lastAnalysisId) : null;
    const recentMessageId = resolveAnalysisIdFromMessages(messages);
    const recentReport = recentMessageId ? getReportById(recentMessageId) : null;
    const latest = getMostRecentReportWithSequence() || getLatestReport();

    // 優先順位: query指定 → bootstrap（最新診断）→ threadメタ → 直近メッセージ → 最新保存
    const targetReport = queryReport || bootstrapReport || threadReport || recentReport || latest || null;

    if (targetReport?.result) {
      const context = buildCoachContext({
        causal: targetReport.causalImpact,
        displayIssue: targetReport.result.summary,
        chain: targetReport.causalImpact?.chain,
        nextAction: targetReport.causalImpact?.nextAction?.content,
        analysisId: targetReport.analysisId,
        summary: targetReport.result.summary,
        swingTypeHeadline: swingTypeFromQuery || null,
        analyzedAt: targetReport.createdAt ? new Date(targetReport.createdAt).toISOString() : null,
      });
      saveCausalContext(thread.threadId, context);
      if (context.analysisId) {
        updateThreadMetadata(thread, { lastAnalysisId: context.analysisId });
      }
      setAnalysisContext(context);
      seededContextRef.current = true;
    }

    setIsLoading(false);
  }, [messages, swingTypeFromQuery, thread, userId]);

  useEffect(() => {
    const analysisId = analysisContext?.analysisId || thread?.lastAnalysisId;
    if (!analysisId || ensureReportSavedRef.current) return;
    const local = getReportById(analysisId);
    if (local?.result) {
      ensureReportSavedRef.current = true;
      return;
    }
    const save = async () => {
      try {
        const res = await fetch(`/api/golf/result/${analysisId}`, { method: 'GET', cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as GolfAnalysisResponse;
        if (json?.result) {
          saveReport(json);
          ensureReportSavedRef.current = true;
        }
      } catch {
        // ignore
      }
    };
    void save();
  }, [analysisContext?.analysisId]);

  useEffect(() => {
    if (!chatRef.current) return;
    const el = chatRef.current;
    const handler = () => {
      if (el.scrollTop < 40) {
        setVisibleCount((prev) => Math.min(messages.length, prev + 15));
      }
    };
    el.addEventListener('scroll', handler);
    return () => el.removeEventListener('scroll', handler);
  }, [messages.length]);

  useEffect(() => {
    if (!chatRef.current) return;
    const el = chatRef.current;
    const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - 200;
    if (nearBottom) {
      requestAnimationFrame(() => {
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      });
    }
  }, [messages.length, sending]);

  const updateSummary = useCallback(
    (allMessages: CoachMessage[]) => {
      if (!thread) return;
      const summaryText = buildSummaryText(analysisContext, allMessages);
      const record: ThreadSummary = { threadId: thread.threadId, summaryText, updatedAt: new Date().toISOString() };
      saveThreadSummary(record);
      setSummary(record);
    },
    [analysisContext, thread]
  );

  const handleSend = useCallback(
    async (text: string, mode: 'chat' | 'initial' = 'chat', quickKey?: string) => {
      if (!thread || !analysisContext || sendingRef.current) return;
      const content = text.trim();
      const showUserMessage = mode === 'chat' && content.length > 0;

      setError(null);
      sendingRef.current = true;
      setSending(true);

      let baseMessages = loadMessages(thread.threadId);
      if (showUserMessage) {
        const userMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
          analysisId: analysisContext.analysisId,
        };
        baseMessages = appendMessages(thread.threadId, [userMessage]);
        setMessages(baseMessages);
        markQuickRepliesDismissed(thread.threadId);
        setShowQuickReplies(false);
      } else if (baseMessages.length) {
        setMessages(baseMessages);
      }

      try {
        const recent = baseMessages.slice(-12);
        const res = await fetch('/api/coach/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            systemPersona: SYSTEM_PERSONA,
            userProfileSummary: analysisContext.summary
              ? `最新診断の要約: ${analysisContext.summary}`
              : '診断サマリ未設定',
            analysisContext,
            summaryText: summary?.summaryText ?? null,
            recentMessages: recent,
            userMessage: showUserMessage ? content : undefined,
            quickKey,
          }),
        });
        const data = (await res.json()) as { message?: string };
        const assistantMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'assistant',
          content: data?.message || '次のステップを準備中です。',
          createdAt: new Date().toISOString(),
          analysisId: analysisContext.analysisId,
        };
        const merged = appendMessages(thread.threadId, [assistantMessage]);
        setMessages(merged);
        if (merged.length >= 4 && merged.length % 8 === 0) {
          updateSummary(merged);
        }
      } catch (err) {
        console.error('[coach] send failed', err);
        setError('AIコーチへの送信に失敗しました。時間をおいて再度お試しください。');
      } finally {
        sendingRef.current = false;
        setSending(false);
        setInput('');
      }
    },
    [analysisContext, summary?.summaryText, thread, updateSummary]
  );

  useEffect(() => {
    if (!thread || !analysisContext) return;
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    if (messages.length === 0 && !hasAssistant && !sendingRef.current) {
      void handleSend('', 'initial');
    }
  }, [analysisContext, handleSend, messages, thread]);

  const latestAssistantExists = messages.some((m) => m.role === 'assistant');
  const hasUserMessage = messages.some((m) => m.role === 'user');
  const quickReplyVisible = showQuickReplies && latestAssistantExists && !hasUserMessage;

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center">
        <p className="text-sm text-slate-200">AIコーチの準備をしています…</p>
      </main>
    );
  }

  if (!analysisContext || !thread) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-50 flex flex-col items-center justify-center space-y-4 px-4">
        <p className="text-sm text-slate-200">診断コンテキストが見つかりませんでした。最新の診断結果からアクセスしてください。</p>
        <div className="flex gap-2">
          <button
            onClick={() => router.push('/golf/upload')}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400"
          >
            新しく診断する
          </button>
          <button
            onClick={() => {
              const latestId = getLatestReport()?.analysisId;
              if (latestId) {
                router.push(`/golf/result/${latestId}`);
              } else {
                router.push('/golf/upload');
              }
            }}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-200 border border-slate-700 hover:bg-slate-700"
          >
            診断結果に戻る
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 space-y-4">
        <header className="sticky top-0 z-10 rounded-2xl border border-slate-800 bg-slate-900/80 backdrop-blur px-4 py-3 shadow-lg shadow-emerald-500/10">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <p className="text-xs text-slate-400">🎯 現在の最重要テーマ</p>
              <p className="text-lg font-semibold text-emerald-100">{analysisContext.primaryFactor}</p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-1">
                <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
                  🧠 推定信頼度: {confidenceDisplay(analysisContext.confidence)}
                </span>
                <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
                  スレッドID: {thread.threadId.slice(0, 8)}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const recentId = resolveAnalysisIdFromMessages(messages);
                  const latestSeqId = getMostRecentReportWithSequence()?.analysisId;
                  const latestId = latestSeqId || getLatestReport()?.analysisId;
                  const navId = analysisContext.analysisId || thread.lastAnalysisId || recentId || latestSeqId || latestId;
                  if (navId) router.push(`/golf/result/${navId}`);
                }}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-emerald-400/60 hover:text-emerald-100 transition-colors disabled:opacity-50"
                disabled={
                  !analysisContext.analysisId &&
                  !thread.lastAnalysisId &&
                  !resolveAnalysisIdFromMessages(messages) &&
                  !getMostRecentReportWithSequence()?.analysisId &&
                  !getLatestReport()?.analysisId
                }
              >
                <span>📊</span>
                <span>今回の診断を見る</span>
              </button>
              <button
                type="button"
                onClick={() => router.push('/golf/upload')}
                className="flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-emerald-400 transition-colors"
              >
                <span>🔄</span>
                <span>再診断する</span>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-sm">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-1">
              <p className="text-xs text-slate-400">📉 スコアへの影響</p>
              <p className="text-slate-100 leading-relaxed">{chainSummary(analysisContext.chain)}</p>
            </div>
            <div className="rounded-xl border border-emerald-700/50 bg-emerald-900/20 p-3 space-y-1">
              <p className="text-xs text-emerald-200">▶ 次の練習で意識</p>
              <p className="text-slate-50 leading-relaxed">{analysisContext.nextAction}</p>
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-emerald-500/10">
          <div className="px-4 pt-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>専属AIコーチとのスレッド</span>
              {summary?.updatedAt && <span>要約更新: {new Date(summary.updatedAt).toLocaleString('ja-JP')}</span>}
            </div>
            {analysisContext.swingTypeHeadline && (
              <p className="mt-1 text-[11px] text-emerald-200">狙うスイングタイプ: {analysisContext.swingTypeHeadline}</p>
            )}
            {quickReplyVisible && (
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_REPLIES.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => handleSend(item.value, 'chat', item.key)}
                    className="rounded-full border border-emerald-500/40 bg-emerald-900/30 px-3 py-1 text-xs text-emerald-50 hover:bg-emerald-900/50 transition-colors"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 h-[65vh] sm:h-[70vh] overflow-y-auto px-4 pb-4 space-y-3" ref={chatRef}>
            {groupedSections.map((section, idx) => {
              const key = section.analysisId || `section-${idx}`;
              const isCollapsed = collapsed[key] ?? false;
              const headline =
                section.analysisId && section.analysisId !== analysisContext.analysisId
                  ? `過去の診断 (${section.analysisId})`
                  : idx === groupedSections.length - 1
                    ? '現在の診断セクション'
                    : '過去セクション';
              return (
                <div key={key} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))}
                    className="flex w-full items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-200 border border-slate-700 hover:border-emerald-400/50"
                  >
                    <span>{headline}</span>
                    <span className="text-[10px] text-slate-400">{isCollapsed ? '開く' : '折りたたむ'}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-2">
                      {section.messages.map((msg, messageIdx) => (
                        <MessageBubble key={`${msg.createdAt}-${messageIdx}`} message={msg} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-slate-800 bg-slate-900/80 px-4 py-3 rounded-b-2xl">
            {analysisContext.analysisId && (
              <p className="mb-2 text-[11px] text-slate-400">
                この相談は「
                {analysisContext.analyzedAt
                  ? new Date(analysisContext.analyzedAt).toLocaleString('ja-JP')
                  : '最新の診断結果'}
                」をもとにしています →
                <button
                  type="button"
                  onClick={() => router.push(`/golf/result/${analysisContext.analysisId}`)}
                  className="ml-1 text-emerald-300 hover:text-emerald-200 underline"
                >
                  診断結果をもう一度見る
                </button>
              </p>
            )}
            {error && <p className="mb-2 text-xs text-rose-300">{error}</p>}
            <form
              className="flex flex-col sm:flex-row gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim().length === 0) return;
                void handleSend(input, 'chat');
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="次に何を確認したいか入力してください"
                className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none h-20 resize-none"
              />
              <button
                type="submit"
                disabled={sending || input.trim().length === 0}
                className="whitespace-nowrap rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending ? '送信中…' : '送信'}
              </button>
            </form>
            <p className="mt-2 text-[11px] text-slate-500">
              1テーマに絞って相談すると精度が上がります。低信頼度の場合は「参考推定」として次回動画で再確認します。
            </p>
          </div>
        </section>
      </div>
    </main>
  );
};

const MessageBubble = ({ message }: { message: CoachMessage }) => {
  const isAssistant = message.role === 'assistant';
  const isUser = message.role === 'user';
  const tone = isAssistant
    ? 'border-emerald-700/50 bg-slate-900/70 text-emerald-50'
    : isUser
      ? 'border-slate-700 bg-slate-800/70 text-slate-50'
      : 'border-slate-800 bg-slate-900/40 text-slate-400';

  return (
    <div className={`rounded-xl border px-3 py-2 shadow-sm ${tone}`}>
      <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
        <span>{isAssistant ? 'AIコーチ' : isUser ? 'あなた' : 'システム'}</span>
        <span>{new Date(message.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
    </div>
  );
};

export default CoachPage;
