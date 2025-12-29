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
  clearMessages,
  clearQuickRepliesDismissed,
  getOrCreateActiveThread,
  hasDismissedQuickReplies,
  isContextDisabled,
  loadDetailModePreference,
  loadBootstrapContext,
  loadCausalContext,
  loadMessages,
  loadThreadSummary,
  loadVisionEnhanceMode,
  markQuickRepliesDismissed,
  saveDetailMode,
  saveCausalContext,
  saveThreadSummary,
  saveVisionMode,
  saveVisionEnhanceMode,
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
  { key: 'cause-detail', label: 'スイングの課題を知りたい', value: '私のスイングの課題を教えてください。' },
  { key: 'practice', label: '練習方法を具体的に知りたい', value: '次の練習で何を1つだけ意識すればいい？具体的なメニューで教えて。' },
  { key: 'checkpoint', label: '次の動画で何ができていればOK？', value: '次に動画を撮るとき、どこができていれば合格か教えて。' },
];

const NO_DIAGNOSIS_MESSAGE =
  'まずはスイング診断をしてください。「診断する」から動画をアップロードして、診断結果が出たらここで改善点を一緒に詰めましょう。';

const DIAGNOSIS_INITIAL_MESSAGE = 'スイングにおける悩みをご相談ください。';

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
  const phaseFrameRange1Based = (count: number): Record<NonNullable<typeof focusPhase>, [number, number]> => {
    // Fallback when stage metadata is missing. Use proportional ranges rather than fixed "16-frame" assumptions.
    const clamp1 = (v: number) => Math.max(1, Math.min(Math.max(1, count), Math.round(v)));
    const aStart = 1;
    const aEnd = clamp1(Math.max(1, count * 0.12));
    const bStart = clamp1(Math.max(aEnd, count * 0.12));
    const bEnd = clamp1(Math.max(bStart, count * 0.35));
    const tStart = clamp1(Math.max(bEnd, count * 0.35));
    const tEnd = clamp1(Math.max(tStart, count * 0.5));
    const dStart = clamp1(Math.max(tEnd, count * 0.5));
    const dEnd = clamp1(Math.max(dStart, count * 0.72));
    const iStart = clamp1(Math.max(dEnd, count * 0.72));
    const iEnd = clamp1(Math.max(iStart, count * 0.78));
    const fStart = clamp1(Math.max(iEnd, count * 0.78));
    const fEnd = count;
    return {
      address: [aStart, aEnd],
      backswing: [bStart, bEnd],
      top: [tStart, tEnd],
      downswing: [dStart, dEnd],
      impact: [iStart, iEnd],
      finish: [fStart, fEnd],
    };
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
    // Prefer stage-metadata-aligned indices for the requested phase (more reliable than fixed index ranges).
    const allowedStages = new Set(phaseStageMap[focusPhase] ?? []);
    const stageOrderForPhase = phasePreferredOrder[focusPhase] ?? preferredOrder;
    const stageAligned: number[] = [];
    stageOrderForPhase.forEach((stage) => {
      if (!allowedStages.has(stage)) return;
      const candidates = (byStage[stage] ?? []).sort((a, b) => a - b);
      for (const idx of candidates) {
        if (stageAligned.length >= max) break;
        if (!stageAligned.includes(idx)) stageAligned.push(idx);
      }
    });

    const manualIndices1Based =
      focusPhase === 'downswing'
        ? manual?.downswing
        : focusPhase === 'impact'
          ? manual?.impact
          : undefined;
    if (Array.isArray(manualIndices1Based) && manualIndices1Based.length) {
      const pickedManual = manualIndices1Based
        .map((n) => Math.round(n) - 1)
        .filter((idx) => Number.isFinite(idx) && idx >= 0 && idx < frames.length)
        .slice(0, max)
        .map((idx) => ({
          ...(frames[idx] as { url: string; timestampSec?: number }),
          frameIndex: idx + 1,
          label: `manual:${focusPhase}`,
        }))
        .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
      if (pickedManual.length) return pickedManual;
    }

    if (stageAligned.length) {
      return stageAligned
        .slice(0, max)
        .sort((a, b) => a - b)
        .map((i) => ({
          ...(frames[i] as { url: string; timestampSec?: number }),
          frameIndex: i + 1,
          label: stageByIndex.get(i) ?? `phase:${focusPhase}`,
        }))
        .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
    }

    const ranges = phaseFrameRange1Based(frames.length);
    const [start1, end1] = ranges[focusPhase] ?? [1, Math.min(2, frames.length)];
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
    const allowedStages2 = new Set(phaseStageMap[focusPhase] ?? []);
    const stageAlignedInRange = phaseRangePick.filter((idx) => allowedStages2.has(stageByIndex.get(idx) ?? 'unknown'));
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

  // Always include manually-selected downswing/impact frames when available (even without focusPhase).
  // If we already have max frames, manual selections should replace lower-priority picks.
  const manualPriority: number[] = [];
  const manualDownSet = new Set<number>();
  const manualImpactSet = new Set<number>();
  (manual?.downswing ?? []).forEach((n) => {
    if (!Number.isFinite(n)) return;
    const idx = Math.round(n) - 1;
    if (idx >= 0 && idx < frames.length) {
      manualPriority.push(idx);
      manualDownSet.add(idx);
    }
  });
  (manual?.impact ?? []).forEach((n) => {
    if (!Number.isFinite(n)) return;
    const idx = Math.round(n) - 1;
    if (idx >= 0 && idx < frames.length) {
      manualPriority.push(idx);
      manualImpactSet.add(idx);
    }
  });
  const manualUnique = Array.from(new Set(manualPriority));
  const mergedPicked = manualUnique.length ? [...manualUnique, ...picked.filter((i) => !manualUnique.includes(i))] : picked;

  return mergedPicked
    .slice(0, max)
    .sort((a, b) => a - b)
    .map((i) => ({
      ...(frames[i] as { url: string; timestampSec?: number }),
      frameIndex: i + 1,
      label: manualDownSet.has(i)
        ? 'manual:downswing'
        : manualImpactSet.has(i)
          ? 'manual:impact'
          : stageByIndex.get(i) ?? undefined,
    }))
    .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
};

const detectFocusPhase = (text: string): 'address' | 'backswing' | 'top' | 'downswing' | 'impact' | 'finish' | null => {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;

  const matchAddress = /(アドレス|セットアップ|構え|setup|address)/i.test(text);
  const matchBackswing = /(バックスイング|backswing|テークバック|テイクバック|takeaway)/i.test(text);
  const matchTop = /(トップ|top|切り返し直前|捻転)/i.test(text);
  const matchDownswing = /(ダウン|downswing|切り返し|下ろし|シャロー|シャロ|タメ|タメを作|リリースが早|力の開放)/i.test(text);
  const matchImpact = /(インパクト|impact|当たり|ミート|打点|フェース|face|ロフト|ハンドファースト)/i.test(text);
  const matchFinish = /(フィニッシュ|finish|フォロー|follow|振り抜き|回転が止|左肘|左肩|体が起き)/i.test(text);
  const matchCount = [matchAddress, matchBackswing, matchTop, matchDownswing, matchImpact, matchFinish].filter(Boolean).length;

  // If the user mentions multiple phases (e.g., downswing + impact), don't narrow; send a broader set of frames.
  if (matchCount >= 2) return null;

  // Hand/handle position questions are typically about downswing slot/plane unless explicitly tied to another phase.
  if (/(手元|グリップ|ハンド)/i.test(text) && /(低|高|高さ|位置)/i.test(text)) {
    if (matchAddress) return 'address';
    if (matchTop || matchBackswing) return 'top';
    if (matchImpact) return 'impact';
    if (matchFinish) return 'finish';
    return 'downswing';
  }

  if (matchAddress) return 'address';
  // Treat backswing/ takeaway as a distinct phase unless the user explicitly asks about "top".
  if (matchBackswing && !matchTop) return 'backswing';
  if (matchTop) return 'top';
  if (matchDownswing) return 'downswing';
  if (matchImpact) return 'impact';
  if (matchFinish) return 'finish';
  return null;
};

const cropVisionFrame = async (
  url: string,
  crop: { x: number; y: number; w: number; h: number },
  maxOutWidth: number
): Promise<string> => {
  if (!url.startsWith('data:image/')) return url;
  if (typeof window === 'undefined') return url;
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('failed_to_load_image'));
    });
    img.src = url;
    await loaded;

    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return url;

    const sx = Math.max(0, Math.min(iw - 1, Math.round(crop.x * iw)));
    const sy = Math.max(0, Math.min(ih - 1, Math.round(crop.y * ih)));
    const sw = Math.max(1, Math.min(iw - sx, Math.round(crop.w * iw)));
    const sh = Math.max(1, Math.min(ih - sy, Math.round(crop.h * ih)));

    // Preserve native crop resolution when possible (avoid upscaling that can look "blurred").
    const targetW = Math.min(sw, Math.max(256, Math.round(maxOutWidth)));
    const shouldScale = sw > targetW;
    const ow = shouldScale ? targetW : sw;
    const oh = shouldScale ? Math.round((sh * ow) / sw) : sh;

    const canvas = document.createElement('canvas');
    canvas.width = ow;
    canvas.height = oh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return url;
    ctx.imageSmoothingEnabled = shouldScale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
    // Keep quality high; avoid aggressive compression artifacts on small features like hands/clubface.
    return canvas.toDataURL('image/jpeg', 0.95);
  } catch {
    return url;
  }
};

const enhanceVisionFrames = async (
  frames: Array<{ url: string; timestampSec?: number; label?: string; frameIndex?: number }>
): Promise<Array<{ url: string; timestampSec?: number; label?: string; frameIndex?: number }>> => {
  // Heuristic crop to remove side bars and increase effective pixel density around the golfer.
  // Keep it slightly wider to avoid cutting arms/club on off-center recordings.
  const crop = { x: 0.15, y: 0.0, w: 0.7, h: 1.0 };
  const maxOutWidth = 1024;
  return Promise.all(
    frames.map(async (f) => ({
      ...f,
      url: await cropVisionFrame(f.url, crop, maxOutWidth),
      label: f.label ? `${f.label}:crop` : 'crop',
    }))
  );
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

const hasMessageForAnalysisId = (messages: CoachMessage[], analysisId: string): boolean => {
  if (!analysisId) return false;
  return messages.some((m) => m.analysisId === analysisId);
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

const stripVisionDebugBlocks = (text: string): string => {
  if (!text) return text;
  const lines = String(text).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('送信フレーム:')) continue;
    if (trimmed.startsWith('画像参照ログ')) {
      // Skip until the first blank line after the block.
      i += 1;
      while (i < lines.length) {
        if ((lines[i] ?? '').trim() === '') break;
        i += 1;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const replaceFrameIndexRefs = (
  text: string,
  frames: Array<{ frameIndex?: number; timestampSec?: number }>
): string => {
  if (!text) return text;
  const tsMap = new Map<number, string>();
  frames.forEach((f) => {
    if (typeof f.frameIndex !== 'number') return;
    const sec = typeof f.timestampSec === 'number' ? `${f.timestampSec.toFixed(2)}秒` : '';
    tsMap.set(f.frameIndex, sec);
  });
  const toDisplay = (nStr: string) => {
    const n = Number(nStr);
    const sec = Number.isFinite(n) ? tsMap.get(n) : undefined;
    return sec ? `#${n}(${sec})` : `#${nStr}`;
  };
  return String(text)
    .replace(/frameIndex\(#(\d+)\)/g, (_, n) => toDisplay(String(n)))
    .replace(/frameIndex（#(\d+)）/g, (_, n) => toDisplay(String(n)));
};

const extractReferencedFrames = (
  text: string,
  sequenceFrames: Array<{ url: string; timestampSec?: number }>
): Array<{ index: number; url: string; timestampSec?: number }> => {
  const raw = (text || '').trim();
  if (!raw) return [];
  const frames = Array.isArray(sequenceFrames) ? sequenceFrames : [];
  if (!frames.length) return [];

  // Ignore debug meta line if present.
  const cleaned = raw.replace(/^送信フレーム:.*$/gim, '');

  const maxIndex = Math.min(frames.length, 16);
  const indices = new Set<number>();
  const explicitIndexHasTimestamp = new Set<number>();

  const findClosestByTimestamp = (sec: number): number | null => {
    if (!Number.isFinite(sec)) return null;
    let bestIdx = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < Math.min(frames.length, 16); i += 1) {
      const t = frames[i]?.timestampSec;
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      const diff = Math.abs(t - sec);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    // If it's too far, don't trust the match.
    if (bestIdx < 0 || bestDiff > 0.35) return null;
    return bestIdx + 1; // 1-based
  };

  // Prefer timestamp-based refs: "#1(2.62秒)" or "#1(2.62s)" etc.
  const tsRe = /#(\d{1,2})\s*(?:\(|（)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*(?:\)|）)/g;
  let m: RegExpExecArray | null;
  while ((m = tsRe.exec(cleaned))) {
    const rawIdx = Number(m[1]);
    const sec = Number(m[2]);
    const resolved = findClosestByTimestamp(sec);
    if (resolved && resolved >= 1 && resolved <= maxIndex) indices.add(resolved);
    if (Number.isFinite(rawIdx) && rawIdx >= 1 && rawIdx <= 16) explicitIndexHasTimestamp.add(rawIdx);
  }

  // Fallback: direct "#n" refs as sequence indices.
  const idxRe = /#(\d{1,2})\b/g;
  while ((m = idxRe.exec(cleaned))) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    // If the same "#n" was used as a timestamp reference, don't also treat it as a direct sequence index.
    if (explicitIndexHasTimestamp.has(n)) continue;
    if (n < 1 || n > maxIndex) continue;
    indices.add(n);
  }

  return Array.from(indices)
    .sort((a, b) => a - b)
    .map((idx1) => {
      const f = frames[idx1 - 1];
      if (!f || typeof f.url !== "string" || !f.url.startsWith("data:image/")) return null;
      return { index: idx1, url: f.url, timestampSec: f.timestampSec };
    })
    .filter((v): v is { index: number; url: string; timestampSec?: number } => !!v);
};

const CoachPage = () => {
  useMeUserState();
  const { state: userState } = useUserState();
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatRef = useRef<HTMLDivElement | null>(null);
  const seededContextRef = useRef(false);
  const loadedThreadIdRef = useRef<string | null>(null);

  const swingTypeFromQuery = searchParams?.get('swingType') || '';
  const analysisIdFromQuery = searchParams?.get('analysisId') || '';
  const debugUI = searchParams?.get('debug') === '1' || searchParams?.get('debugVision') === '1';
  const debugVision = searchParams?.get('debugVision') === '1';

  const [userId, setUserId] = useState('');
  const [thread, setThread] = useState<CoachThread | null>(null);
  const [analysisContext, setAnalysisContext] = useState<CoachCausalImpactExplanation | null>(null);
  const [, setContextDisabledState] = useState(false);
  const [contextReport, setContextReport] = useState<GolfAnalysisResponse | null>(null);
  const [detailMode, setDetailMode] = useState(false);
  const [visionMode, setVisionMode] = useState(false);
  const [visionEnhanceMode, setVisionEnhanceMode] = useState(false);
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
  const [serverHistoryIds, setServerHistoryIds] = useState<Set<string> | null>(null);

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
    // PRO default is always "detailMode=true" (gpt-4o) for product experience.
    // Only allow overriding via local preference when the debug UI is enabled.
    const storedDetail = debugUI ? loadDetailModePreference(activeThread?.threadId ?? null) : null;
    const nextDetailMode = debugUI ? storedDetail ?? true : true;
    setDetailMode(nextDetailMode);
    if (debugUI && activeThread?.threadId && storedDetail == null) {
      saveDetailMode(activeThread.threadId, nextDetailMode);
    }
    // Always keep vision mode ON for product behavior; images improve grounding and manual DS/IMP selection boosts trust.
    setVisionMode(true);
    if (activeThread?.threadId) saveVisionMode(activeThread.threadId, true);

    // Vision enhance/crop mode: default OFF to match legacy behavior; can be toggled for experimentation.
    const storedEnhance = loadVisionEnhanceMode(activeThread?.threadId ?? null);
    setVisionEnhanceMode(storedEnhance);
  }, [userState.userId, userState.hasProAccess, analysisIdFromQuery, debugUI]);

  useEffect(() => {
    // Keep a server-truth set of diagnosis IDs for member accounts, and use it to filter stale local histories.
    let cancelled = false;
    if (!thread || !userId.startsWith('user:')) {
      setServerHistoryIds(null);
      return;
    }
    const run = async () => {
      try {
        const res = await fetch('/api/golf/history', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as { items?: Array<{ id?: string }> } | null;
        const ids = new Set<string>();
        (json?.items ?? []).forEach((item) => {
          if (typeof item?.id === 'string' && item.id.length > 0) ids.add(item.id);
        });
        if (!cancelled) setServerHistoryIds(ids);
      } catch {
        // ignore
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [thread, userId]);

  useEffect(() => {
    // If the account has a known server history set, hide (and delete) local chat messages for diagnoses not in that set.
    if (!thread || !userId.startsWith('user:') || !serverHistoryIds) return;
    const current = loadMessages(thread.threadId);
    const filtered = current.filter((m) => !m.analysisId || serverHistoryIds.has(m.analysisId));
    if (filtered.length === current.length) return;
    clearMessages(thread.threadId);
    const merged = filtered.length ? appendMessages(thread.threadId, filtered) : [];
    setMessages(merged);
  }, [serverHistoryIds, thread, userId]);

  useEffect(() => {
    if (!thread || !userId) return;

    let cancelled = false;
    const run = async () => {
      // When switching identity/thread, clear previous diagnosis context immediately to avoid cross-account bleed.
      if (loadedThreadIdRef.current !== thread.threadId) {
        loadedThreadIdRef.current = thread.threadId;
        seededContextRef.current = false;
        ensuredReportIdRef.current = null;
        setAnalysisContext(null);
        setContextReport(null);
        setError(null);
        setIsLoading(true);
      }

      const disabled = isContextDisabled(thread.threadId);
      setContextDisabledState(disabled);

      const applyContext = (ctx: CoachCausalImpactExplanation | null, report?: GolfAnalysisResponse | null) => {
        if (!ctx) {
          console.warn('[applyContext] ctx is null or undefined');
          setAnalysisContext(null);
          setContextReport(null);
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

      const isMemberIdentity = userId.startsWith('user:');
      const fetchMemberHistoryIds = async (): Promise<Set<string> | null> => {
        if (!isMemberIdentity) return null;
        try {
          const res = await fetch('/api/golf/history', { cache: 'no-store' });
          if (!res.ok) return null;
          const json = (await res.json()) as { items?: Array<{ id?: string }> };
          const ids = new Set<string>();
          (json.items ?? []).forEach((item) => {
            if (typeof item?.id === 'string' && item.id.length > 0) ids.add(item.id);
          });
          return ids;
        } catch {
          return null;
        }
      };

      // stored と bootstrap で analysisId が異なる場合は bootstrap を優先して上書き
      if (bootstrap && bootstrap.analysisId && storedContext?.analysisId !== bootstrap.analysisId) {
        applyContext(bootstrap, bootstrapReport);
        setIsLoading(false);
        return;
      }

      const memberHistoryIds = await fetchMemberHistoryIds();
      if (isMemberIdentity && memberHistoryIds && memberHistoryIds.size === 0) {
        // Logged-in account has no server history: do not fall back to anonymous/local reports.
        setAnalysisContext(null);
        setContextReport(null);
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

      const isAllowedAnalysisId = (analysisId?: string | null): boolean => {
        if (!analysisId) return false;
        if (!isMemberIdentity) return true;
        if (memberHistoryIds) return memberHistoryIds.has(analysisId);
        // If history couldn't be fetched, only trust IDs already tied to this thread/user.
        const safeIds = new Set<string>();
        if (bootstrap?.analysisId) safeIds.add(bootstrap.analysisId);
        if (storedContext?.analysisId) safeIds.add(storedContext.analysisId);
        if (thread.lastAnalysisId) safeIds.add(thread.lastAnalysisId);
        if (recentMessageId) safeIds.add(recentMessageId);
        return safeIds.has(analysisId);
      };

      const pickAllowed = (report: GolfAnalysisResponse | null): GolfAnalysisResponse | null => {
        if (!report?.result) return null;
        return isAllowedAnalysisId(report.analysisId) ? report : null;
      };

      const targetReport =
        pickAllowed(bootstrapReport) ||
        pickAllowed(threadReport) ||
        pickAllowed(recentReport) ||
        // Global pointers (active/latest) are a source of cross-account mixing; only allow when server history confirms.
        (memberHistoryIds ? pickAllowed(activeReport) : null) ||
        (memberHistoryIds ? pickAllowed(latest) : null) ||
        null;

      if (targetReport?.result) {
        const ctx = buildContextFromReport(targetReport);
        if (ctx) {
          applyContext(ctx, targetReport);
          if (targetReport.analysisId && typeof targetReport.createdAt === 'number') {
            setActiveAnalysisPointer(targetReport.analysisId, targetReport.createdAt);
          }
        }
      }

      if (!targetReport?.result && !cancelled) {
        // Ensure a clean "no diagnosis" state instead of showing stale context.
        setAnalysisContext(null);
        setContextReport(null);
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

      const hasDiagnosisNow = !!analysisContext?.analysisId;
      if (!hasDiagnosisNow) {
        clearMessages(thread.threadId);
        const assistantMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'assistant',
          content: NO_DIAGNOSIS_MESSAGE,
          createdAt: new Date().toISOString(),
        };
        const merged = appendMessages(thread.threadId, [assistantMessage]);
        setMessages(merged);
        setShowQuickReplies(false);
        sendingRef.current = false;
        setSending(false);
        setInput('');
        return;
      }

      if (mode === 'initial' && !showUserMessage) {
        const effectiveAnalysisId = analysisIdFromQuery || analysisContext?.analysisId;
        const assistantMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'assistant',
          content: DIAGNOSIS_INITIAL_MESSAGE,
          createdAt: new Date().toISOString(),
          analysisId: effectiveAnalysisId || undefined,
        };
        const merged = appendMessages(thread.threadId, [assistantMessage]);
        setMessages(merged);
        sendingRef.current = false;
        setSending(false);
        setInput('');
        return;
      }

      try {
        const recent = baseMessages.slice(-12);
        let reportForVision = contextReport;
        const focusPhase = showUserMessage ? detectFocusPhase(content) : null;
        if (visionMode) {
          const active = getActiveAnalysisPointer();
          const desiredAnalysisId =
            analysisIdFromQuery ||
            analysisContext?.analysisId ||
            thread.lastAnalysisId ||
            // Avoid using global "active" pointer for member accounts; it can reference another diagnosis.
            (!userId.startsWith('user:') ? active?.analysisId : null) ||
            null;

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
        const rawVisionFrames = visionMode ? pickVisionFrames(reportForVision, 6, focusPhase) : [];
        const visionFrames = visionMode
          ? visionEnhanceMode
            ? await enhanceVisionFrames(rawVisionFrames)
            : rawVisionFrames
          : [];
        const sentFramesMetaText =
          debugVision && visionMode && visionFrames.length
            ? `送信フレーム: ${visionFrames
                .map((f, i) => {
                  const label = f.label ? String(f.label) : `frame${i + 1}`;
                  const idx = typeof f.frameIndex === 'number' ? `#${f.frameIndex}` : '#N/A';
                  const ts = typeof f.timestampSec === 'number' ? `${f.timestampSec.toFixed(2)}s` : 'ts:N/A';
                  return `${label}${idx}@${ts}`;
                })
                .join(' / ')}`
            : null;
        if (debugVision && visionMode) {
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
            debugVision,
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
        const messageTextRaw = data?.message || '次のステップを準備中です。';
        const messageText = replaceFrameIndexRefs(messageTextRaw, visionFrames);
        const displayText = debugVision ? messageText : stripVisionDebugBlocks(messageText);
        const assistantMessage: CoachMessage = {
          threadId: thread.threadId,
          role: 'assistant',
          content:
            (sentFramesMetaText ? `${sentFramesMetaText}\n\n` : '') + displayText,
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
    [
      analysisContext,
      analysisIdFromQuery,
      contextReport,
      detailMode,
      summary?.summaryText,
      thread,
      updateSummary,
      userId,
      debugVision,
      visionEnhanceMode,
      visionMode,
    ]
  );

  useEffect(() => {
    if (!thread) return;
    if (isLoading) return;
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    // Auto-seed only when a diagnosis context exists (otherwise we show a fixed guidance message without calling the API).
    if (messages.length === 0 && !hasAssistant && !sendingRef.current && !!analysisContext?.analysisId) {
      void handleSend('', 'initial');
    }
  }, [analysisContext?.analysisId, handleSend, isLoading, messages, thread]);

  useEffect(() => {
    if (!thread) return;
    if (isLoading) return;
    if (analysisContext?.analysisId) return;
    // Replace any legacy chat content with a simple "diagnose first" guidance when there is no diagnosis.
    const already =
      messages.length === 1 && messages[0]?.role === 'assistant' && messages[0]?.content === NO_DIAGNOSIS_MESSAGE;
    if (already) return;
    clearMessages(thread.threadId);
    const assistantMessage: CoachMessage = {
      threadId: thread.threadId,
      role: 'assistant',
      content: NO_DIAGNOSIS_MESSAGE,
      createdAt: new Date().toISOString(),
    };
    const merged = appendMessages(thread.threadId, [assistantMessage]);
    setMessages(merged);
    setShowQuickReplies(false);
  }, [analysisContext?.analysisId, isLoading, messages, thread]);

  useEffect(() => {
    if (!thread) return;
    if (isLoading) return;
    if (!analysisContext?.analysisId) return;
    const onlyNoDiagnosis =
      messages.length === 1 && messages[0]?.role === 'assistant' && messages[0]?.content === NO_DIAGNOSIS_MESSAGE;
    if (!onlyNoDiagnosis) return;
    if (sendingRef.current) return;
    // Diagnosis is now available, but the thread still shows the "no diagnosis" guidance message.
    // Clear and regenerate the initial coach response based on the diagnosis context.
    clearMessages(thread.threadId);
    setMessages([]);
    setShowQuickReplies(true);
    void handleSend('', 'initial');
  }, [analysisContext?.analysisId, handleSend, isLoading, messages, thread]);

  useEffect(() => {
    if (!thread) return;
    if (isLoading) return;
    const analysisId = analysisContext?.analysisId;
    if (!analysisId) return;
    if (sendingRef.current) return;
    // Ensure the latest section is for the current diagnosis by seeding a simple initial prompt once per analysisId.
    if (hasMessageForAnalysisId(messages, analysisId)) return;
    clearQuickRepliesDismissed(thread.threadId);
    setShowQuickReplies(true);
    const assistantMessage: CoachMessage = {
      threadId: thread.threadId,
      role: 'assistant',
      content: DIAGNOSIS_INITIAL_MESSAGE,
      createdAt: new Date().toISOString(),
      analysisId,
    };
    const merged = appendMessages(thread.threadId, [assistantMessage]);
    setMessages(merged);
  }, [analysisContext?.analysisId, isLoading, messages, thread]);

  const latestAssistantExists = messages.some((m) => m.role === 'assistant');
  const hasUserMessage = messages.some((m) => m.role === 'user');
  const quickReplyVisible = showQuickReplies && latestAssistantExists && !hasUserMessage && !!analysisContext?.analysisId;

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

  const hasDiagnosis = !!analysisContext?.analysisId;
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
              {hasDiagnosis ? (
                <>
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
	                  {debugUI && (
	                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-1">
	                      <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
	                        🧠 推定信頼度: {confidenceDisplay(analysisContext?.confidence)}
	                      </span>
	                      <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
	                        スレッドID: {thread.threadId.slice(0, 8)}
	                      </span>
	                    </div>
	                  )}
	                </>
	              ) : (
	                <>
	                  <p className="text-xs text-slate-400">📝 診断結果がありません</p>
	                  <p className="text-lg font-semibold text-slate-100">まずはスイング診断をアップロードしてください</p>
	                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-1">
	                    <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
	                      この画面は一般的な相談もできます（診断ありの方が精度が上がります）
	                    </span>
	                    {debugUI && (
	                      <span className="px-2 py-1 rounded-full border border-slate-700 bg-slate-800/60">
	                        スレッドID: {thread.threadId.slice(0, 8)}
	                      </span>
	                    )}
	                  </div>
	                </>
	              )}
	            </div>
	            <div className="flex flex-wrap items-center gap-2">
              {!hasDiagnosis && (
                <button
                  type="button"
                  onClick={() => router.push('/golf/upload')}
                  className="flex items-center gap-1 rounded-lg border border-emerald-500/60 bg-emerald-900/25 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-900/35"
                >
	                  診断する
	                </button>
	              )}
	              {debugUI && (
	                <>
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
	                      const next = !visionEnhanceMode;
	                      setVisionEnhanceMode(next);
	                      if (thread?.threadId) saveVisionEnhanceMode(thread.threadId, next);
	                    }}
	                    className={`flex items-center gap-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
	                      visionEnhanceMode
	                        ? 'border-emerald-500/60 bg-emerald-900/25 text-emerald-100 hover:bg-emerald-900/35'
	                        : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:border-emerald-400/60 hover:text-emerald-100'
	                    }`}
	                    title={visionEnhanceMode ? '画像をクロップ/補正して送信します（実験）' : '画像はそのまま送信します（従来）'}
	                  >
	                    <span>🧪</span>
	                    <span>{visionEnhanceMode ? '画像補正ON' : '画像補正OFF'}</span>
	                  </button>
	                </>
	              )}
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
	          {debugUI && (
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
	          )}
	        </header>

	        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 shadow-xl shadow-emerald-500/10">
	          <div className="px-4 pt-4">
	            <div className="flex items-center justify-between text-xs text-slate-400">
	              <span>専属AIコーチとのスレッド</span>
	              {summary?.updatedAt && <span>要約更新: {new Date(summary.updatedAt).toLocaleString('ja-JP')}</span>}
	            </div>
	            {false && analysisContext?.swingTypeHeadline && (
	              <p className="mt-1 text-[11px] text-emerald-200">狙うスイングタイプ: {analysisContext.swingTypeHeadline}</p>
	            )}
	          </div>

          <div className="mt-4 max-h-[65vh] sm:max-h-[70vh] overflow-y-auto px-4 pb-4 space-y-3" ref={chatRef}>
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
		                      {section.messages.map((msg, messageIdx) => {
                            const framesForThisSection =
                              section.analysisId && section.analysisId === contextReport?.analysisId
                                ? contextReport?.result?.sequence?.frames ?? []
                                : section.analysisId
                                  ? getReportById(section.analysisId)?.result?.sequence?.frames ?? []
                                  : [];
		                        const showInlineQuickReplies =
		                          quickReplyVisible &&
		                          idx === groupedSections.length - 1 &&
		                          messageIdx === section.messages.length - 1 &&
		                          msg.role === 'assistant';
		                        return (
		                          <div key={`${msg.createdAt}-${messageIdx}`} className="space-y-2">
		                            <MessageBubble
                                message={msg}
                                debugVision={debugVision}
                                analysisId={msg.analysisId ?? section.analysisId ?? analysisContext?.analysisId ?? null}
                                sequenceFrames={framesForThisSection}
                              />
		                            {showInlineQuickReplies && (
		                              <div className="flex flex-wrap gap-2">
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
	                        );
	                      })}
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
            {debugVision && visionMode && lastVisionFrames.length > 0 && (
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
          </div>
        </section>
      </div>
    </main>
  );
};

const MessageBubble = ({
  message,
  debugVision,
  analysisId,
  sequenceFrames,
}: {
  message: CoachMessage;
  debugVision: boolean;
  analysisId: string | null;
  sequenceFrames: Array<{ url: string; timestampSec?: number }>;
}) => {
  const isAssistant = message.role === 'assistant';
  const isUser = message.role === 'user';
  const tone = isAssistant
    ? 'border-emerald-700/50 bg-slate-900/70 text-emerald-50'
    : isUser
      ? 'border-slate-700 bg-slate-800/70 text-slate-50'
      : 'border-slate-800 bg-slate-900/40 text-slate-400';
  const content = debugVision ? message.content : stripVisionDebugBlocks(message.content);
  const referencedFrames = useMemo(
    () => (isAssistant ? extractReferencedFrames(content, sequenceFrames) : []),
    [content, isAssistant, sequenceFrames]
  );

  return (
    <div className={`rounded-xl border px-3 py-2 shadow-sm ${tone}`}>
      <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
        <span>{isAssistant ? 'AIコーチ' : isUser ? 'あなた' : 'システム'}</span>
        <span>{new Date(message.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>
      {isAssistant && referencedFrames.length > 0 && (
        <div className="mt-3">
          <div className="grid grid-cols-3 gap-2">
            {referencedFrames.map((f) => (
              <a
                key={f.index}
                href={analysisId ? `/golf/result/${encodeURIComponent(analysisId)}#sequence-frame-${f.index}` : undefined}
                className="block overflow-hidden rounded-lg border border-slate-700 bg-slate-950/40"
              >
                <div className="relative aspect-video w-full bg-slate-900">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.url} alt={`ref-frame-${f.index}`} className="h-full w-full object-contain bg-slate-950" />
                  <div className="absolute left-1 top-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-100">
                    #{f.index}
                  </div>
                  {typeof f.timestampSec === 'number' ? (
                    <div className="absolute right-1 top-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-200 tabular-nums">
                      {f.timestampSec.toFixed(2)}s
                    </div>
                  ) : null}
                </div>
              </a>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">この回答で参照したフレーム</p>
        </div>
      )}
    </div>
  );
};

export default CoachPage;
