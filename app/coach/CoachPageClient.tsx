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
  isContextDisabled,
  loadDetailMode,
  loadBootstrapContext,
  loadCausalContext,
  loadMessages,
  loadThreadSummary,
  markQuickRepliesDismissed,
  saveDetailMode,
  saveCausalContext,
  saveThreadSummary,
  saveVisionMode,
  setContextDisabled,
  updateThreadMetadata,
} from '@/app/coach/utils/storage';
import { getAnonymousUserId } from '@/app/golf/utils/historyStorage';
import {
  getActiveAnalysisPointer,
  getLatestReport,
  getMostRecentReportWithSequence,
  getReportById,
  saveReport,
  setActiveAnalysisPointer,
} from '@/app/golf/utils/reportStorage';
import type { GolfAnalysisResponse } from '@/app/golf/types';
import { useMeUserState } from '@/app/golf/hooks/useMeUserState';
import { useUserState } from '@/app/golf/state/userState';
import { loadPhaseOverride } from '@/app/golf/utils/phaseOverrideStorage';

const QUICK_REPLIES: CoachQuickReply[] = [
  { key: 'cause-detail', label: '原因を詳しく知りたい', value: 'この原因がスコアにどう響くか、もう少し詳しく教えて。' },
  { key: 'practice', label: '練習方法を具体的に知りたい', value: '次の練習で何を1つだけ意識すればいい？具体的なメニューで教えて。' },
  { key: 'checkpoint', label: '次の動画で何ができていればOK？', value: '次に動画を撮るとき、どこができていれば合格か教えて。' },
  { key: 'other-factors', label: '他に考えられる要因は？', value: '他に考えられる要因があれば、優先度順に1つだけ教えて。' },
];

const SYSTEM_PERSONA =
  'あなたはPGAティーチングプロ相当の専属AIゴルフコーチです。常に前向きで「褒めて伸ばす」スタンスで、まず良い点を1つ短く認めたうえで、改善テーマを1つに絞って指導してください。診断結果を踏まえ、専門用語（フェースtoパス、ダイナミックロフト、アタックアングル、シャローイング、Pポジション等）を積極的に使い、再現性の根拠（クラブパス/フェース/体の回旋/地面反力/リリース機序）まで踏み込んで説明してください。メインの改善テーマは1つに絞るが、そのテーマを深掘りして「なぜ起きるか」「どう確認するか」「どう矯正するか」を具体的に示します。';

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


const compactTheme = (value: string) => {
  const raw = (value || '').trim();
  if (!raw) return 'スイング全般の改善';
  const firstSentence = raw.split('。')[0] || raw;
  const trimmed = firstSentence.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 44) return trimmed;
  return `${trimmed.slice(0, 44)}…`;
};

const pickVisionFrames = (
  report: GolfAnalysisResponse | null,
  max: number,
  focusPhase?: 'address' | 'backswing' | 'top' | 'downswing' | 'impact' | 'finish' | null
): Array<{ url: string; timestampSec?: number; label?: string; frameIndex?: number }> => {
  const frames = report?.result?.sequence?.frames ?? [];
  if (!frames.length || max <= 0) return [];

  const manual = report?.analysisId ? loadPhaseOverride(report.analysisId) : null;

  const stageByIndex = new Map<number, string>();
  const phaseFrameRange1Based: Record<NonNullable<typeof focusPhase>, [number, number]> = {
    address: [1, 2],
    backswing: [2, 4],
    top: [4, 6],
    downswing: [8, 8],
    impact: [9, 9],
    finish: [10, 16],
  };
  const phaseStageMap: Record<NonNullable<typeof focusPhase>, string[]> = {
    address: ['address', 'address_to_backswing'],
    backswing: ['address_to_backswing', 'backswing_to_top', 'top'],
    top: ['backswing_to_top', 'top', 'top_to_downswing'],
    downswing: ['top_to_downswing', 'downswing', 'downswing_to_impact'],
    impact: ['downswing_to_impact', 'impact'],
    finish: ['finish'],
  };
  const phasePreferredOrder: Record<NonNullable<typeof focusPhase>, string[]> = {
    address: ['address', 'address_to_backswing'],
    backswing: ['address_to_backswing', 'backswing_to_top', 'top'],
    top: ['backswing_to_top', 'top', 'top_to_downswing'],
    downswing: ['top_to_downswing', 'downswing_to_impact', 'downswing'],
    impact: ['impact', 'downswing_to_impact'],
    finish: ['finish'],
  };

  const preferredOrder = [
    "downswing_to_impact",
    "top_to_downswing",
    "impact",
    "finish",
    "backswing_to_top",
    "address",
  ];

  const stages = report?.result?.sequence?.stages ?? [];
  const keyIdx: number[] = [];
  stages.forEach((s) => {
    (s.keyFrameIndices ?? []).forEach((i) => {
      if (!Number.isFinite(i)) return;
      const raw = Number(i);
      // keyFrameIndices may be 1-based (UI表示 #1..N) or 0-based. Prefer 1-based when possible.
      const idx =
        raw >= 1 && raw <= frames.length ? raw - 1 : raw >= 0 && raw < frames.length ? raw : null;
      if (idx == null) return;
      keyIdx.push(idx);
      if (!stageByIndex.has(idx)) stageByIndex.set(idx, s.stage);
    });
  });

  const unique = Array.from(new Set(keyIdx));
  const byStage: Record<string, number[]> = {};
  unique.forEach((i) => {
    const stage = stageByIndex.get(i) ?? "unknown";
    byStage[stage] = byStage[stage] ?? [];
    byStage[stage]!.push(i);
  });

  const picked: number[] = [];
  const stageOrder =
    focusPhase && phasePreferredOrder[focusPhase] ? phasePreferredOrder[focusPhase] : preferredOrder;
  stageOrder.forEach((stage) => {
    const candidates = (byStage[stage] ?? []).sort((a, b) => a - b);
    for (const idx of candidates) {
      if (picked.length >= max) break;
      if (!picked.includes(idx)) picked.push(idx);
    }
  });

  // When focusPhase is specified, never fill with unrelated stages.
  if (focusPhase) {
    const manualIndex1Based =
      focusPhase === 'downswing' ? manual?.downswing : focusPhase === 'impact' ? manual?.impact : undefined;
    if (typeof manualIndex1Based === 'number') {
      const idx = manualIndex1Based - 1;
      if (idx >= 0 && idx < frames.length) {
        return [
          {
            ...(frames[idx] as { url: string; timestampSec?: number }),
            frameIndex: idx + 1,
            label: `manual:${focusPhase}`,
          },
        ].filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
      }
    }

    const [start1, end1] = phaseFrameRange1Based[focusPhase] ?? [1, Math.min(2, frames.length)];
    const start = Math.max(0, start1 - 1);
    const end = Math.min(frames.length - 1, end1 - 1);

    const buildRangePick = () => {
      if (end < start) return [];
      const span = end - start + 1;
      const count = Math.min(max, span);
      if (count <= 0) return [];
      if (count === span) return Array.from({ length: span }, (_, k) => start + k);
      const stride = span <= 1 ? 1 : (span - 1) / Math.max(count - 1, 1);
      const idxs: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const idx = Math.round(start + i * stride);
        if (!idxs.includes(idx)) idxs.push(idx);
      }
      return idxs;
    };

    // Prefer frames within the phase range; never pick outside the range for focusPhase.
    const phaseRangePick = buildRangePick();

    // If stage metadata exists and aligns, prefer those indices within the phase range.
    const allowedStages = new Set(phaseStageMap[focusPhase] ?? []);
    const stageAlignedInRange = phaseRangePick.filter((idx) => allowedStages.has(stageByIndex.get(idx) ?? 'unknown'));
    const base = stageAlignedInRange.length ? stageAlignedInRange : phaseRangePick;

    // If the report has fewer frames than the expected range, fall back to the last frames (closest to downswing/impact).
    const safeBase =
      base.length > 0
        ? base
        : Array.from({ length: Math.min(max, frames.length) }, (_, k) => Math.max(0, frames.length - 1 - k)).reverse();

    return safeBase
      .slice(0, max)
      .sort((a, b) => a - b)
      .map((i) => ({
        ...(frames[i] as { url: string; timestampSec?: number }),
        frameIndex: i + 1,
        label: stageByIndex.get(i) ?? `phase:${focusPhase}`,
      }))
      .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
  }

  // Fill remaining with evenly spaced frames
  const remainingSlots = Math.max(Math.min(max, frames.length) - picked.length, 0);
  if (remainingSlots > 0) {
    const stride = frames.length <= 1 ? 1 : (frames.length - 1) / Math.max(remainingSlots - 1, 1);
    for (let i = 0; i < remainingSlots; i += 1) {
      const idx = Math.round(i * stride);
      if (picked.length >= max) break;
      if (!picked.includes(idx)) picked.push(idx);
    }
  }

  return picked
    .slice(0, max)
    .sort((a, b) => a - b)
    .map((i) => ({
      ...(frames[i] as { url: string; timestampSec?: number }),
      frameIndex: i + 1,
      label: stageByIndex.get(i) ?? undefined,
    }))
    .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
};

const detectFocusPhase = (text: string): 'address' | 'backswing' | 'top' | 'downswing' | 'impact' | 'finish' | null => {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;
  // Hand/handle position questions are typically about downswing slot/plane unless explicitly tied to another phase.
  if (/(手元|グリップ|ハンド)/i.test(text) && /(低|高|高さ|位置)/i.test(text)) {
    if (/(アドレス|構え|setup|address)/i.test(text)) return 'address';
    if (/(トップ|top|テークバック|テイクバック|backswing|バックスイング)/i.test(text)) return 'top';
    if (/(インパクト|impact|当たり|ミート|打点)/i.test(text)) return 'impact';
    if (/(フィニッシュ|finish|フォロー|follow)/i.test(text)) return 'finish';
    return 'downswing';
  }
  if (/(アドレス|セットアップ|構え|setup|address)/i.test(text)) return 'address';
  // Treat backswing/ takeaway as a distinct phase unless the user explicitly asks about "top".
  if (/(バックスイング|backswing|テークバック|テイクバック|takeaway)/i.test(text) && !/(トップ|top)/i.test(text)) {
    return 'backswing';
  }
  if (/(トップ|top|切り返し直前|捻転)/i.test(text)) return 'top';
  if (/(ダウン|downswing|切り返し|下ろし|シャロー|シャロ|タメ|タメを作|リリースが早|力の開放)/i.test(text)) return 'downswing';
  if (/(インパクト|impact|当たり|ミート|打点|フェース|face|ロフト|ハンドファースト)/i.test(text)) return 'impact';
  if (/(フィニッシュ|finish|フォロー|follow|振り抜き|回転が止|左肘|左肩|体が起き)/i.test(text)) return 'finish';
  return null;
};

const phaseLabelJa = (phase: NonNullable<ReturnType<typeof detectFocusPhase>>): string => {
  switch (phase) {
    case 'address':
      return 'アドレス';
    case 'backswing':
      return 'バックスイング';
    case 'top':
      return 'トップ';
    case 'downswing':
      return 'ダウンスイング';
    case 'impact':
      return 'インパクト';
    case 'finish':
      return 'フィニッシュ';
  }
};

const buildPhaseContextText = (report: GolfAnalysisResponse | null, phase: ReturnType<typeof detectFocusPhase>): string | null => {
  if (!phase) return null;
  const phases = report?.result?.phases;
  if (!phases) return null;
  const p =
    (phases as Record<string, { score?: number; good?: string[]; issues?: string[]; advice?: string[] } | undefined>)[phase] ??
    // Backward-compat: old analyses may not include backswing.
    (phase === 'backswing'
      ? (phases as Record<string, { score?: number; good?: string[]; issues?: string[]; advice?: string[] } | undefined>).top
      : undefined);
  if (!p) return null;
  const note =
    phase === 'backswing' && !(phases as Record<string, unknown>).backswing ? ' ※旧データのためトップ評価を参照' : '';
  const lines: string[] = [];
  lines.push(`フェーズ: ${phaseLabelJa(phase)}（score: ${p.score ?? 'N/A'}/20）${note}`);
  if (p.good?.length) lines.push(`良い点: ${(p.good ?? []).slice(0, 3).join(' / ')}`);
  if (p.issues?.length) lines.push(`改善点: ${(p.issues ?? []).slice(0, 3).join(' / ')}`);
  if (p.advice?.length) lines.push(`アドバイス: ${(p.advice ?? []).slice(0, 3).join(' / ')}`);
  return lines.join('\n');
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
  useMeUserState();
  const { state: userState } = useUserState();
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatRef = useRef<HTMLDivElement | null>(null);
  const seededContextRef = useRef(false);

  const swingTypeFromQuery = searchParams?.get('swingType') || '';
  const analysisIdFromQuery = searchParams?.get('analysisId') || '';

  const [userId, setUserId] = useState('');
  const [thread, setThread] = useState<CoachThread | null>(null);
  const [analysisContext, setAnalysisContext] = useState<CoachCausalImpactExplanation | null>(null);
  const [, setContextDisabledState] = useState(false);
  const [contextReport, setContextReport] = useState<GolfAnalysisResponse | null>(null);
  const [detailMode, setDetailMode] = useState(false);
  const [visionMode, setVisionMode] = useState(false);
  const [lastDebug, setLastDebug] = useState<{ model?: string; framesSent?: number; detailMode?: boolean } | null>(null);
  const [lastVisionFrames, setLastVisionFrames] = useState<Array<{ label?: string; timestampSec?: number; frameIndex?: number }>>(
    []
  );
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [summary, setSummary] = useState<ThreadSummary | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(40);
  const [showQuickReplies, setShowQuickReplies] = useState(true);
  const sendingRef = useRef(false);
  const ensuredReportIdRef = useRef<string | null>(null);

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
      const key = `${section.analysisId ?? "section"}-${idx}`;
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

  // Always prioritize query指定の analysisId を「現在のアクティブ診断」として記録
  useEffect(() => {
    if (!analysisIdFromQuery) return;
    const active = getActiveAnalysisPointer();
    if (active?.analysisId === analysisIdFromQuery) return;
    setActiveAnalysisPointer(analysisIdFromQuery, Date.now());
  }, [analysisIdFromQuery]);

  useEffect(() => {
    const identityKey = userState.userId ? `user:${userState.userId}` : `anon:${getAnonymousUserId() || ''}`;
    const resolvedUserId = identityKey;
    if (!resolvedUserId) return;
    setUserId(resolvedUserId);
    const activeThread = getOrCreateActiveThread(resolvedUserId, analysisIdFromQuery || undefined);
    setThread(activeThread);
    const storedMessages = loadMessages(activeThread?.threadId ?? null);
    setMessages(storedMessages);
    setSummary(loadThreadSummary(activeThread?.threadId ?? null));
    setShowQuickReplies(!hasDismissedQuickReplies(activeThread?.threadId ?? null));
    setDetailMode(loadDetailMode(activeThread?.threadId ?? null));
    // Always keep vision mode ON for product behavior; images improve grounding and manual DS/IMP selection boosts trust.
    setVisionMode(true);
    if (activeThread?.threadId) saveVisionMode(activeThread.threadId, true);
  }, [userState.userId, analysisIdFromQuery]);

  useEffect(() => {
    if (!thread || !userId) return;

    let cancelled = false;
    const run = async () => {
      const disabled = isContextDisabled(thread.threadId);
      setContextDisabledState(disabled);

      const applyContext = (ctx: CoachCausalImpactExplanation | null, report?: GolfAnalysisResponse | null) => {
        if (!ctx) {
          console.warn('[applyContext] ctx is null or undefined');
          if (!cancelled) setIsLoading(false);
          return;
        }
        try {
          const nextCtx = swingTypeFromQuery ? { ...ctx, swingTypeHeadline: swingTypeFromQuery } : ctx;
          saveCausalContext(thread.threadId, nextCtx);
          if (ctx.analysisId) {
            const nextThread = updateThreadMetadata(thread, { lastAnalysisId: ctx.analysisId });
            if (nextThread && nextThread.lastAnalysisId !== thread.lastAnalysisId) {
              setThread((prev) => {
                if (!prev) return prev;
                if (prev.threadId !== nextThread.threadId) return prev;
                if (prev.lastAnalysisId === nextThread.lastAnalysisId) return prev;
                return nextThread;
              });
            }
          }
          if (cancelled) return;
          setAnalysisContext(nextCtx);
          if (report?.result) setContextReport(report);
          setContextDisabled(thread.threadId, false);
          setContextDisabledState(false);
          seededContextRef.current = true;
        } catch (err) {
          console.error('[applyContext] error:', err, { ctx, report });
          if (!cancelled) setIsLoading(false);
        }
      };

      const buildContextFromReport = (report: GolfAnalysisResponse | null | undefined): CoachCausalImpactExplanation | null => {
        if (!report || !report.result) {
          return null;
        }
        try {
          const displayIssue =
            report.causalImpact?.primaryIssue ||
            report.causalImpact?.issue ||
            report.causalImpact?.relatedMiss ||
            report.result?.summary ||
            'スイングの再現性を高めること';
          
          let analyzedAt: string | null = null;
          if (report.createdAt) {
            try {
              if (typeof report.createdAt === 'number') {
                analyzedAt = new Date(report.createdAt).toISOString();
              } else if (typeof report.createdAt === 'string') {
                analyzedAt = new Date(report.createdAt).toISOString();
              }
            } catch (dateErr) {
              console.warn('[buildContextFromReport] date parsing error:', dateErr, { createdAt: report.createdAt });
            }
          }
          
          return buildCoachContext({
            causal: report.causalImpact ?? null,
            displayIssue,
            chain: report.causalImpact?.chain ?? undefined,
            nextAction: report.causalImpact?.nextAction?.content ?? undefined,
            analysisId: report.analysisId ?? undefined,
            summary: typeof report.result?.summary === 'string' ? report.result.summary : undefined,
            swingTypeHeadline: swingTypeFromQuery || null,
            analyzedAt,
          });
        } catch (err) {
          console.error('[buildContextFromReport] error:', err, { report });
          return null;
        }
      };

      // Query explicitly requests a context: ALWAYS honor it (storedContext may be from another diagnosis).
      if (analysisIdFromQuery) {
        setContextDisabled(thread.threadId, false);
        setContextDisabledState(false);
        setIsLoading(true);

        const storedContext = loadCausalContext(thread.threadId);
        const bootstrap = loadBootstrapContext(userId);
        const bootstrapReport = bootstrap?.analysisId ? getReportById(bootstrap.analysisId) : null;
        const localQueryReport = getReportById(analysisIdFromQuery);

        if (bootstrap && bootstrap.analysisId === analysisIdFromQuery) {
          applyContext(bootstrap, bootstrapReport || localQueryReport);
          setIsLoading(false);
          return;
        }

        if (storedContext && storedContext.analysisId === analysisIdFromQuery) {
          applyContext(storedContext, localQueryReport);
          setIsLoading(false);
          return;
        }

        if (localQueryReport?.result) {
          const ctx = buildContextFromReport(localQueryReport);
          if (ctx) {
            applyContext(ctx, localQueryReport);
            setIsLoading(false);
            return;
          }
        }

        try {
          const res = await fetch(`/api/golf/result/${analysisIdFromQuery}`, { method: 'GET', cache: 'no-store' });
          if (res.ok) {
            const json = (await res.json()) as GolfAnalysisResponse;
            if (json?.result) {
              saveReport(json);
              const ctx = buildContextFromReport(json);
              if (ctx) {
                applyContext(ctx, json);
                setIsLoading(false);
                return;
              }
            }
          }
        } catch {
          // ignore
        }

        // Fallback: keep existing state (do not silently switch to another diagnosis).
        if (!cancelled) setIsLoading(false);
        return;
      }

      if (disabled) {
        setAnalysisContext(null);
        setContextReport(null);
        setIsLoading(false);
        return;
      }

      const storedContext = loadCausalContext(thread.threadId);
      const bootstrap = loadBootstrapContext(userId);
      const bootstrapReport = bootstrap?.analysisId ? getReportById(bootstrap.analysisId) : null;

      // stored と bootstrap で analysisId が異なる場合は bootstrap を優先して上書き
      if (bootstrap && bootstrap.analysisId && storedContext?.analysisId !== bootstrap.analysisId) {
        applyContext(bootstrap, bootstrapReport);
        setIsLoading(false);
        return;
      }

      const activeForContext = getActiveAnalysisPointer();
      const resolveReportById = async (id: string): Promise<GolfAnalysisResponse | null> => {
        const local = getReportById(id);
        if (local?.result) return local;
        try {
          const res = await fetch(`/api/golf/result/${id}`, { method: 'GET', cache: 'no-store' });
          if (!res.ok) return null;
          const json = (await res.json()) as GolfAnalysisResponse;
          if (json?.result) {
            saveReport(json);
            return json;
          }
        } catch {
          // ignore
        }
        return null;
      };

      if (analysisIdFromQuery || activeForContext?.analysisId) {
        const targetId = analysisIdFromQuery || activeForContext?.analysisId || null;
        if (targetId) {
          const targetReport = await resolveReportById(targetId);
          if (targetReport?.result) {
            const ctx = buildContextFromReport(targetReport);
            if (ctx) {
              applyContext(ctx, targetReport);
              if (targetReport.analysisId && typeof targetReport.createdAt === 'number') {
                setActiveAnalysisPointer(targetReport.analysisId, targetReport.createdAt);
              }
              setIsLoading(false);
              return;
            }
          }
        }
      }

      if (storedContext) {
        // If a newer diagnosis exists locally, prefer it over a stale storedContext.
        const latestReport = getMostRecentReportWithSequence() || getLatestReport();
        const storedReport = storedContext.analysisId ? getReportById(storedContext.analysisId) : null;
        const storedAt =
          typeof storedReport?.createdAt === 'number' && Number.isFinite(storedReport.createdAt) ? storedReport.createdAt : -Infinity;
        const latestAt =
          typeof latestReport?.createdAt === 'number' && Number.isFinite(latestReport.createdAt) ? latestReport.createdAt : -Infinity;

        if (latestReport?.result && latestAt > storedAt) {
          const ctx = buildContextFromReport(latestReport);
          if (ctx) {
            applyContext(ctx, latestReport);
            if (latestReport.analysisId && typeof latestReport.createdAt === 'number') {
              setActiveAnalysisPointer(latestReport.analysisId, latestReport.createdAt);
            }
          }
        } else {
          applyContext(storedContext, storedReport);
          if (storedReport?.analysisId && typeof storedReport.createdAt === 'number') {
            setActiveAnalysisPointer(storedReport.analysisId, storedReport.createdAt);
          }
        }
        setIsLoading(false);
        return;
      }

      const threadReport = thread.lastAnalysisId ? getReportById(thread.lastAnalysisId) : null;
      const recentMessageId = resolveAnalysisIdFromMessages(messages);
      const recentReport = recentMessageId ? getReportById(recentMessageId) : null;
      const active = getActiveAnalysisPointer();
      const activeReport = active?.analysisId ? getReportById(active.analysisId) : null;
      const latest = getMostRecentReportWithSequence() || getLatestReport();
      const targetReport = bootstrapReport || activeReport || threadReport || recentReport || latest || null;

      if (targetReport?.result) {
        const ctx = buildContextFromReport(targetReport);
        if (ctx) {
          applyContext(ctx, targetReport);
          if (targetReport.analysisId && typeof targetReport.createdAt === 'number') {
            setActiveAnalysisPointer(targetReport.analysisId, targetReport.createdAt);
          }
        }
      }

      if (!cancelled) setIsLoading(false);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [analysisIdFromQuery, messages, swingTypeFromQuery, thread, userId]);

  useEffect(() => {
    const analysisId = analysisContext?.analysisId || thread?.lastAnalysisId;
    if (!analysisId) return;
    if (ensuredReportIdRef.current === analysisId) return;
    ensuredReportIdRef.current = analysisId;
    const local = getReportById(analysisId);
    if (local?.result) {
      setContextReport(local);
      return;
    }
    const save = async () => {
      try {
        const res = await fetch(`/api/golf/result/${analysisId}`, { method: 'GET', cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as GolfAnalysisResponse;
        if (json?.result) {
          saveReport(json);
          setContextReport(json);
        }
      } catch {
        // ignore
      }
    };
    void save();
  }, [analysisContext?.analysisId, thread?.lastAnalysisId]);

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
      if (!thread || sendingRef.current) return;
      const content = text.trim();
      const showUserMessage = mode === 'chat' && content.length > 0;

      setError(null);
      sendingRef.current = true;
      setSending(true);

      let baseMessages = loadMessages(thread.threadId);
      if (showUserMessage) {
        const effectiveAnalysisId = analysisIdFromQuery || analysisContext?.analysisId;
        const userMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
          analysisId: effectiveAnalysisId || undefined,
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
        let reportForVision = contextReport;
        const focusPhase = showUserMessage ? detectFocusPhase(content) : null;
        if (visionMode) {
          const active = getActiveAnalysisPointer();
          const desiredAnalysisId =
            analysisIdFromQuery || active?.analysisId || analysisContext?.analysisId || thread.lastAnalysisId || null;

          if (desiredAnalysisId && reportForVision?.analysisId !== desiredAnalysisId) {
            const local = getReportById(desiredAnalysisId);
            if (local?.result) {
              reportForVision = local;
              setContextReport(local);
              if (local.analysisId) {
                setActiveAnalysisPointer(local.analysisId, typeof local.createdAt === 'number' ? local.createdAt : undefined);
              }
            } else {
              try {
                const res = await fetch(`/api/golf/result/${desiredAnalysisId}`, { method: 'GET', cache: 'no-store' });
                if (res.ok) {
                  const json = (await res.json()) as GolfAnalysisResponse;
                  if (json?.result) {
                    reportForVision = json;
                    setContextReport(json);
                    saveReport(json);
                    if (json.analysisId) {
                      setActiveAnalysisPointer(json.analysisId, typeof json.createdAt === 'number' ? json.createdAt : undefined);
                    }
                  }
                }
              } catch {
                // ignore
              }
            }
          } else {
            const existing = pickVisionFrames(reportForVision, 6, focusPhase);
            if (!existing.length && desiredAnalysisId) {
              try {
                const res = await fetch(`/api/golf/result/${desiredAnalysisId}`, { method: 'GET', cache: 'no-store' });
                if (res.ok) {
                  const json = (await res.json()) as GolfAnalysisResponse;
                  if (json?.result) {
                    reportForVision = json;
                    setContextReport(json);
                    saveReport(json);
                  }
                }
              } catch {
                // ignore
              }
            }
          }
        }
        const phaseContextText = buildPhaseContextText(reportForVision, focusPhase);
        const visionFrames = visionMode ? pickVisionFrames(reportForVision, 6, focusPhase) : [];
        if (visionMode) {
          setLastVisionFrames(
            visionFrames.map((f) => ({ label: f.label, timestampSec: f.timestampSec, frameIndex: f.frameIndex }))
          );
        }
        const res = await fetch('/api/coach/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            systemPersona: SYSTEM_PERSONA,
            detailMode,
            visionFrames,
            focusPhase,
            phaseContextText,
            userProfileSummary: analysisContext?.summary
              ? `最新診断の要約: ${analysisContext.summary}`
              : '診断コンテキストなし（一般相談モード）',
            analysisContext: analysisContext ?? null,
            summaryText: summary?.summaryText ?? null,
            recentMessages: recent,
            userMessage: showUserMessage ? content : undefined,
            quickKey,
          }),
        });
        const data = (await res.json()) as { message?: string; debug?: { model?: string; framesSent?: number; detailMode?: boolean } };
        if (data?.debug) setLastDebug(data.debug);
        const assistantMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'assistant',
          content: data?.message || '次のステップを準備中です。',
          createdAt: new Date().toISOString(),
          analysisId: (analysisIdFromQuery || analysisContext?.analysisId) || undefined,
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
    [analysisContext, analysisIdFromQuery, contextReport, detailMode, summary?.summaryText, thread, updateSummary, visionMode]
  );

  useEffect(() => {
    if (!thread) return;
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    if (messages.length === 0 && !hasAssistant && !sendingRef.current) {
      void handleSend('', 'initial');
    }
  }, [handleSend, messages, thread]);

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

  if (!thread) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-50 flex flex-col items-center justify-center space-y-4 px-4">
        <p className="text-sm text-slate-200">AIコーチのスレッドを準備できませんでした。ページを再読み込みしてください。</p>
        <div className="flex gap-2">
          <button
            onClick={() => router.push('/golf/upload')}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-400"
          >
            新しく診断する
          </button>
          <button
            onClick={() => {
              const navId = analysisIdFromQuery || getLatestReport()?.analysisId;
              if (navId) {
                router.push(`/golf/result/${navId}`);
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

  const primaryFactor = analysisContext?.primaryFactor ?? 'スイング全般の改善';
  const primaryFactorDisplay = compactTheme(primaryFactor);
  const meta = contextReport?.meta ?? null;
  const metaHandedness = meta?.handedness === 'right' ? '右打ち' : meta?.handedness === 'left' ? '左打ち' : null;
  const metaClub = meta?.clubType ?? null;
  const metaLevel = meta?.level ?? null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 space-y-4">
        <header className="sticky top-0 z-10 rounded-2xl border border-slate-800 bg-slate-900/80 backdrop-blur px-4 py-3 shadow-lg shadow-emerald-500/10">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <p className="text-xs text-slate-400">🎯 現在の最重要テーマ</p>
              <p
                className="text-lg font-semibold text-emerald-100"
                title={primaryFactor}
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {primaryFactorDisplay}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-1">
                <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
                  🧠 推定信頼度: {confidenceDisplay(analysisContext?.confidence)}
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
                  const next = !detailMode;
                  setDetailMode(next);
                  saveDetailMode(thread.threadId, next);
                }}
                className={`flex items-center gap-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                  detailMode
                    ? 'border-emerald-500/60 bg-emerald-900/25 text-emerald-100 hover:bg-emerald-900/35'
                    : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:border-emerald-400/60 hover:text-emerald-100'
                }`}
                title={detailMode ? '精密（gpt-4o）で回答します' : '通常（gpt-4o-mini）で回答します'}
              >
                <span>{detailMode ? '🧠' : '💸'}</span>
                <span>{detailMode ? '精密モード（gpt-4o / コスト↑）' : '通常モード（gpt-4o-mini / コスパ）'}</span>
              </button>
              <button
                type="button"
                disabled
                className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-900/15 px-3 py-2 text-xs text-emerald-100/90 cursor-not-allowed"
                title="フレーム参照は常時ONです（最大6枚）"
              >
                <span>🖼️</span>
                <span>フレーム参照ON（常時）</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const recentId = resolveAnalysisIdFromMessages(messages);
                  const latestSeqId = getMostRecentReportWithSequence()?.analysisId;
                  const latestId = latestSeqId || getLatestReport()?.analysisId;
                  const navId =
                    analysisContext?.analysisId || analysisIdFromQuery || thread.lastAnalysisId || recentId || latestSeqId || latestId;
                  if (navId) router.push(`/golf/result/${navId}`);
                }}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200 hover:border-emerald-400/60 hover:text-emerald-100 transition-colors disabled:opacity-50"
                disabled={
                  !analysisContext?.analysisId &&
                  !analysisIdFromQuery &&
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
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <div className="flex flex-wrap items-center gap-2">
              <span>
                現在のコンテキスト:{' '}
                {analysisContext?.analysisId
                  ? `${analysisContext.analysisId}${analysisContext.analyzedAt ? ` / ${new Date(analysisContext.analyzedAt).toLocaleString('ja-JP')}` : ''}`
                  : 'なし（一般相談モード）'}
              </span>
              {(metaHandedness || metaClub || metaLevel) && (
                <span className="text-slate-500">
                  {metaHandedness ? `${metaHandedness}` : ''}
                  {metaClub ? `${metaHandedness ? ' / ' : ''}${metaClub}` : ''}
                  {metaLevel ? `${metaHandedness || metaClub ? ' / ' : ''}${metaLevel}` : ''}
                </span>
              )}
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-emerald-500/10">
          <div className="px-4 pt-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>専属AIコーチとのスレッド</span>
              {summary?.updatedAt && <span>要約更新: {new Date(summary.updatedAt).toLocaleString('ja-JP')}</span>}
            </div>
            {analysisContext?.swingTypeHeadline && (
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
              const key = `${section.analysisId ?? "section"}-${idx}`;
              const isCollapsed = collapsed[key] ?? false;
              const headline =
                section.analysisId && section.analysisId !== analysisContext?.analysisId
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
            {analysisContext?.analysisId && (
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
            {visionMode && lastVisionFrames.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-500">
                送信フレーム:{' '}
                {lastVisionFrames
                  .map((f) => {
                    const ts = typeof f.timestampSec === 'number' ? `${f.timestampSec.toFixed(2)}s` : 'ts:N/A';
                    const stage = f.label ? `${f.label}` : 'stage:N/A';
                    const idx = typeof f.frameIndex === 'number' ? `#${f.frameIndex}` : '';
                    return `${stage}${idx}@${ts}`;
                  })
                  .join(' / ')}
              </p>
            )}
            {process.env.NODE_ENV !== 'production' && lastDebug && (
              <p className="mt-1 text-[10px] text-slate-600">
                debug: model={lastDebug.model ?? 'n/a'} framesSent={String(lastDebug.framesSent ?? 'n/a')} detailMode={String(lastDebug.detailMode ?? 'n/a')}
              </p>
            )}
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
