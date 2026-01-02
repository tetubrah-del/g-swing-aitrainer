'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { buildCoachContext } from '@/app/coach/utils/context';
import { saveBootstrapContext } from '@/app/coach/utils/storage';
import { useMeUserState } from '@/app/golf/hooks/useMeUserState';
import { clearPhaseOverride, loadPhaseOverride, savePhaseOverride } from '@/app/golf/utils/phaseOverrideStorage';
import type {
  CausalImpactExplanation,
  GolfAnalysisResponse,
  SequenceStageFeedback,
  SwingAnalysisHistory,
  SwingTypeKey,
  SwingTypeLLMResult,
} from '@/app/golf/types';
	import {
	  clearActiveAnalysisPointer,
	  getReportById,
	  saveReport,
	  setActiveAnalysisPointer,
	} from '@/app/golf/utils/reportStorage';
import { getAnonymousUserId, getSwingHistories, saveSwingHistory } from '@/app/golf/utils/historyStorage';
import { buildRuleBasedCausalImpact } from '@/app/golf/utils/causalImpact';
import { saveSwingTypeResult } from '@/app/golf/utils/swingTypeStorage';
import { useUserState } from '@/app/golf/state/userState';
import ProUpsellModal from '@/app/components/ProUpsellModal';
import PhaseFrameSelector from './PhaseFrameSelector';
import { clearDiagnostics, loadDiagnostics, saveDiagnostics } from '@/app/golf/utils/diagnosticsStorage';
import { selectShareFrames } from '@/app/golf/utils/shareFrameSelection';
import { buildLevelDiagnosis, computeRoundFallbackFromScore } from '@/app/golf/utils/scoreCalibration';
import OnPlaneSection from './OnPlaneSection';

type SwingTypeBadge = {
  label: string;
  value?: string; // 高 / 中 / 低
  confidence?: number; // %
  positive: boolean; // ✔ or ❌
  reason?: string;
};

type SwingTypeResult = {
  label: string;
  reasons: string[];
  characteristics: string[];
  alternatives?: string[];
};

const PHASE_FRAME_MAP: Record<string, [number, number]> = {
  address: [1, 2],
  backswing: [2, 4],
  address_to_backswing: [2, 4],
  top: [4, 6],
  backswing_to_top: [4, 6],
  downswing: [8, 8],
  top_to_downswing: [7, 7],
  downswing_to_impact: [9, 9],
  impact: [9, 9],
  finish: [10, 16],
};

const phaseOrder: Array<keyof GolfAnalysisResponse['result']['phases']> = [
  'address',
  'backswing',
  'top',
  'downswing',
  'impact',
  'finish',
];

const SHOW_SWING_TYPE_DIAGNOSIS_UI = false;
const SHOW_SWING_STYLE_COMMENT_UI = false;

const normalizeFrameIndex = (raw: unknown, length: number): number | null => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded >= 1 && rounded <= length) return rounded - 1; // 1-based
  if (rounded >= 0 && rounded < length) return rounded; // 0-based
  return null;
};

type IssueRule = {
  key: string;
  patterns: RegExp[];
  label: string;
  nextAction: string;
};

type MissRule = {
  key: string;
  patterns: RegExp[];
  label: string;
};

const ISSUE_RULES: IssueRule[] = [
  {
    key: 'early_open_body',
    patterns: [/体の開き/, /胸.*開/],
    label: '切り返しで体が先に開いてしまう',
    nextAction: '切り返しで胸をターゲットに向けるのを0.2秒遅らせる',
  },
  {
    key: 'unstable_face',
    patterns: [/フェース管理が不安定/, /フェース向き/],
    label: 'インパクトでフェース向きが安定しない',
    nextAction: 'インパクト直前まで右手の力を抑える',
  },
  {
    key: 'weak_grip',
    patterns: [/グリップが弱い/, /弱いグリップ/, /グリップがゆる/],
    label: 'アドレスでグリップがゆるむ',
    nextAction: 'アドレスでグリップ圧を左右均等にする',
  },
  {
    key: 'lack_x_factor',
    patterns: [/捻転差/, /上半身.*下半身.*捻転/],
    label: 'トップで上半身と下半身の捻転差が不足',
    nextAction: 'トップで骨盤を我慢し肩だけ回す意識を入れる',
  },
  {
    key: 'stiff_wrist',
    patterns: [/リストが硬い/, /手首.*硬/],
    label: 'トップで手首の動きが硬くなる',
    nextAction: 'トップ直前で手首を柔らかく保つ素振りを10回行う',
  },
];

const MISS_RULES: MissRule[] = [
  {
    key: 'unstable_face',
    patterns: [/フェース管理が不安定/, /フェース向き/],
    label: 'インパクトでフェース向きが安定しない',
  },
  {
    key: 'lack_x_factor',
    patterns: [/捻転差/],
    label: 'トップで上半身と下半身の捻転差が不足',
  },
  {
    key: 'stiff_wrist',
    patterns: [/リストが硬い/, /手首.*硬/],
    label: 'トップで手首の動きが硬くなる',
  },
];

type RoundEstimateMetrics = {
  strokeRange: string;
  fwKeep: string;
  gir: string;
  ob: string;
};

const computeFallbackRoundEstimates = (totalScore: number): RoundEstimateMetrics => computeRoundFallbackFromScore(totalScore);

const buildLocalCausalImpact = (
  result: GolfAnalysisResponse['result'],
  estimates: RoundEstimateMetrics
): CausalImpactExplanation => {
  return buildRuleBasedCausalImpact({
    result,
    roundEstimates: { ob: estimates.ob, strokeRange: estimates.strokeRange },
  });
};

const pickIssueRule = (text?: string | null): IssueRule | undefined => {
  if (!text) return undefined;
  return ISSUE_RULES.find((rule) => rule.patterns.some((p) => p.test(text)));
};

const pickMissRule = (text?: string | null): MissRule | undefined => {
  if (!text) return undefined;
  return MISS_RULES.find((rule) => rule.patterns.some((p) => p.test(text)));
};

const getDisplayIssue = (text?: string | null): { label: string; nextAction: string } => {
  const rule = pickIssueRule(text);
  if (rule) {
    return { label: rule.label, nextAction: rule.nextAction };
  }
  return {
    label: text ?? 'スイングの再現性を高めましょう',
    nextAction: 'ハーフスイングでフェース向きを一定に保つ練習を10球',
  };
};

const getDisplayMiss = (text?: string | null): string => {
  const rule = pickMissRule(text);
  if (rule) return rule.label;
  return text ?? '打点と方向性が乱れやすい';
};

const getFrameRange = (
  phaseKey: string,
  sequenceStages?: SequenceStageFeedback[],
  manual?: { backswing?: number[]; top?: number[]; downswing?: number[]; impact?: number[] }
): [number, number] | null => {
  try {
    const manualBackswing = Array.isArray(manual?.backswing) ? manual!.backswing : undefined;
    const manualTop = Array.isArray(manual?.top) ? manual!.top : undefined;
    const manualDownswing = Array.isArray(manual?.downswing) ? manual!.downswing : undefined;
    const manualImpact = Array.isArray(manual?.impact) ? manual!.impact : undefined;
    if (phaseKey === 'backswing' && manualBackswing?.length)
      return [manualBackswing[0], manualBackswing[manualBackswing.length - 1]];
    if (phaseKey === 'top' && manualTop?.length) return [manualTop[0], manualTop[manualTop.length - 1]];
    if (phaseKey === 'downswing' && manualDownswing?.length) return [manualDownswing[0], manualDownswing[manualDownswing.length - 1]];
    if (phaseKey === 'impact' && manualImpact?.length) return [manualImpact[0], manualImpact[manualImpact.length - 1]];

    // sequenceStagesから実際のフェーズフレーム番号を取得
    if (sequenceStages && Array.isArray(sequenceStages) && sequenceStages.length > 0) {
      try {
        const stageMap: Record<string, string[]> = {
          address: ['address', 'address_to_backswing'],
          backswing: ['address_to_backswing', 'backswing_to_top'],
          top: ['backswing_to_top', 'top', 'top_to_downswing'],
          downswing: ['top_to_downswing', 'downswing'],
          top_to_downswing: ['top_to_downswing'],
          downswing_to_impact: ['downswing_to_impact'],
          impact: ['impact', 'downswing_to_impact'],
          finish: ['finish'],
        };
        const relevantStages = stageMap[phaseKey] ?? [];
        if (relevantStages.length === 0) {
          // phaseKeyがstageMapにない場合はfallback
          return PHASE_FRAME_MAP[phaseKey] ?? null;
        }
        const frameIndices: number[] = [];
        sequenceStages.forEach((stage) => {
          try {
            if (stage && typeof stage === 'object' && 'stage' in stage) {
              const stageStr = String(stage.stage);
              if (relevantStages.includes(stageStr) && Array.isArray(stage.keyFrameIndices)) {
                stage.keyFrameIndices.forEach((idx) => {
                  if (typeof idx === 'number' && Number.isFinite(idx)) {
                    // keyFrameIndicesは1-based（UI表示 #1..N）の可能性がある
                    const normalizedIdx = idx >= 1 && idx <= 16 ? idx : idx >= 0 && idx < 16 ? idx + 1 : null;
                    if (normalizedIdx != null && !frameIndices.includes(normalizedIdx)) {
                      frameIndices.push(normalizedIdx);
                    }
                  }
                });
              }
            }
          } catch (stageErr) {
            console.warn('[getFrameRange] error processing stage:', stageErr, { stage });
          }
        });
        if (frameIndices.length > 0) {
          frameIndices.sort((a, b) => a - b);
          const start = frameIndices[0];
          const end = frameIndices[frameIndices.length - 1];
          return [start, end];
        }
      } catch (err) {
        console.error('[getFrameRange] error processing sequenceStages:', err, { phaseKey, sequenceStages });
      }
    }
    // fallback: 固定マッピングを使用
    return PHASE_FRAME_MAP[phaseKey] ?? null;
  } catch (err) {
    console.error('[getFrameRange] unexpected error:', err, { phaseKey });
    return PHASE_FRAME_MAP[phaseKey] ?? null;
  }
};

const attachFrameRange = (
  comment: string,
  phaseKey: string,
  sequenceStages?: SequenceStageFeedback[],
  manual?: { address?: number[]; backswing?: number[]; top?: number[]; downswing?: number[]; impact?: number[]; finish?: number[] }
): string => {
  try {
    const range = getFrameRange(phaseKey, sequenceStages, manual);
    if (!range) return comment;
    const [start, end] = range;
    return `${comment}（#${start}〜#${end}）`;
  } catch (err) {
    console.error('[attachFrameRange] error:', err, { comment, phaseKey });
    return comment;
  }
};

const pickPreviousHistory = (ownerId: string, analysisId: string, currentTs: number): SwingAnalysisHistory | null => {
  const toTime = (value: string): number => {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : 0;
  };
  const histories = getSwingHistories(ownerId).filter((item) => item.analysisId !== analysisId);
  if (!histories.length) return null;
  if (currentTs > 0) {
    const candidates = histories.filter((h) => toTime(h.createdAt) <= currentTs);
    if (candidates.length) return candidates[0] ?? null;
  }
  return histories[0] ?? null;
};

const normalizeTextPool = (result: GolfAnalysisResponse['result']) => {
  const pool: string[] = [];
  Object.values(result.phases).forEach((phase) => {
    pool.push(...(phase.good || []), ...(phase.issues || []), ...(phase.advice || []));
  });
  if (result.summary) pool.push(result.summary);
  return pool.join('／');
};

const deriveSwingTypes = (result: GolfAnalysisResponse['result']): SwingTypeBadge[] => {
  const pool = normalizeTextPool(result);
  const has = (keyword: string | RegExp) =>
    typeof keyword === 'string' ? pool.includes(keyword) : keyword.test(pool);
  const downswingScore = result.phases.downswing?.score ?? 0;
  const impactScore = result.phases.impact?.score ?? 0;
  const topScore = result.phases.top?.score ?? 0;

  const badges: SwingTypeBadge[] = [];

  // 下半身主導型
  // NOTE: some analyses describe lower-body lead as "体重移動" rather than explicitly "下半身リード".
  if (downswingScore >= 14 || has(/下半身リード|腰の回転|体幹/) || (downswingScore >= 12 && has(/体重移動/))) {
    const confidence = Math.min(90, 50 + Math.round(((downswingScore + impactScore) / 40) * 50));
    badges.push({
      label: '下半身主導型',
      confidence,
      positive: true,
      reason:
        '下半身でリズムを作り、切り返しからインパクトまで骨盤が先行して上半身を牽引できています。骨盤リードが効くことでクラブ軌道が安定し、再現性の高いインパクトを作れている点が強みです。',
    });
  }

  // ハンドファースト傾向
  if (has(/ハンドファースト|右手を我慢|インパクト前倒し/)) {
    badges.push({
      label: 'ハンドファースト傾向',
      positive: true,
      reason:
        'インパクトでグリップが先行し、右手のリリースを我慢できています。これによりハンドファーストの形が保たれ、入射角が安定してフェース管理もしやすくなっています。',
    });
  }

  // ボディターン適性
  const bodyTurnScore = (downswingScore + topScore) / 2;
  if (bodyTurnScore >= 10 || has(/ボディターン|体の回転/)) {
    const value = bodyTurnScore >= 14 ? '高' : bodyTurnScore >= 11 ? '中' : '低';
    badges.push({
      label: 'ボディターン適性',
      value,
      positive: value !== '低',
      reason:
        'トップからダウンで肩と腰の回転が連動しやすく、体幹主導で振り抜けています。体幹で回転を作れているので、手元の暴れが少なく、軌道とフェース向きの再現性を高めやすい傾向です。',
    });
  }

  // トップの安定性（クラブ位置の再現性）
  if (has(/クラブの位置が不安定|トップ.*不安定/)) {
    badges.push({
      label: 'トップ安定性',
      value: '低',
      positive: false,
      reason:
        'トップ付近でクラブの位置が揃いにくく、切り返し以降の軌道やフェース向きが毎回同じになりにくい傾向があります。トップの再現性が上がるほど、スイング全体の安定につながります。',
    });
  }

  // 手打ち適性（低いほど良い）
  if (has(/体の開きが早い|手打ち|フェース管理が不安定|リストリード/)) {
    badges.push({
      label: '手打ち適性',
      value: '低',
      positive: false,
      reason:
        '体が先に開きやすく、手先で合わせる動きが混ざりやすい状態です。体の回転と腕・フェースのタイミングを揃え、胸の向きとフェース向きを同調させることで、手打ちのリスクを下げられます。',
    });
  }

  // リズム/テンポ傾向
  if (has(/リズム|テンポ|滑らか|スムーズ/)) {
    badges.push({
      label: 'リズムが滑らか',
      positive: true,
      reason:
        'スイング全体のテンポが揃っており、トップ〜ダウンで「間」を取れているため、力みなく振り切れています。このリズムが軌道とフェース管理の安定に寄与しています。',
    });
  }

  return badges.slice(0, 5);
};

const deriveSwingTypeResult = (
  result: GolfAnalysisResponse['result'],
  causalImpact?: CausalImpactExplanation | null
): SwingTypeResult => {
  const pool = normalizeTextPool(result);
  const has = (keyword: string | RegExp) =>
    typeof keyword === 'string' ? pool.includes(keyword) : keyword.test(pool);
  const downswingScore = result.phases.downswing?.score ?? 0;
  const impactScore = result.phases.impact?.score ?? 0;
  const causalIssue = causalImpact?.issue ?? '';

  // 初期値
  let label = 'ボディターン型（ややハイブリッド寄り）';
  const reasons: string[] = [];
  const characteristics: string[] = [];
  const alternatives: string[] = [];

  const isBodyTurn =
    downswingScore >= 14 ||
    impactScore >= 14 ||
    has(/下半身リード|腰の回転|体幹/) ||
    /体/.test(causalIssue);
  const isArmSwing = has(/手元主導|腕主導|手で合わせる|手先/);
  const isFade = has(/フェード|カット/) || (causalIssue.includes('開き') && !causalIssue.includes('閉'));
  const isDraw = has(/ドロー|インサイドアウト|ドロー回転/);

  if (isArmSwing && !isBodyTurn) {
    label = 'アームスイング型';
    reasons.push('腕と手元のコントロールで球筋を作る傾向が強く、手先の感覚が活きているため');
    reasons.push('切り返しで腕の動きが主導しやすく、手元を起点にフェースを合わせる場面が多い');
    characteristics.push('手元の感覚を活かしつつ、体の回転と同調させると再現性が上がる');
    characteristics.push('フェース管理をシンプルにし、手のリリースタイミングを整えると安定する');
    alternatives.push('ハイブリッド型：体幹リードを少し強めて、手元は微調整役に寄せる');
  } else if (isBodyTurn && isArmSwing) {
    label = 'ハイブリッド型（体幹×手元バランス）';
    reasons.push('下半身リードでリズムを作りつつ、インパクトで手元の調整力も働いているため');
    reasons.push('体の回転で大枠を作り、手元で微調整する動きが共存している');
    characteristics.push('体幹で回転の軸を作り、手元は「微調整」に限定するとブレが減る');
    characteristics.push('フェース向きは胸の向きと同期させ、手先はリリースのタイミングに集中すると良い');
    alternatives.push('ボディターン型：体幹主導の割合をさらに増やし、手元の介入を減らす');
    alternatives.push('アームスイング型：手元の感覚を活かしつつ、足りない回転を補うアプローチも可');
  } else if (isBodyTurn) {
    label = 'ボディターン型';
    reasons.push('切り返し〜インパクトで下半身リードが明確で、肩と腰が連動している');
    reasons.push('クラブを体の回転で運ぶ割合が高く、フェース管理がシンプルになりやすい');
    characteristics.push('体幹主導で軌道が安定しやすく、再現性の高いインパクトを作れる');
    characteristics.push('アドレスの軸とリズムを守るだけで、大きなブレなくプレーできる');
    alternatives.push('ハイブリッド型：体幹軸を維持しつつ、手元で球筋を微調整するスタイルも選択肢');
  } else {
    label = 'ハイブリッド型';
    reasons.push('体の回転と手元の調整をバランス良く使ってスイングを組み立てている');
    reasons.push('場面に応じて体幹・手元の主導を切り替える柔軟性がある');
    characteristics.push('どちらかに偏らず、シチュエーション適応力が高い');
    characteristics.push('軸ブレを抑え、手元の使い方をシンプルにすると安定感が増す');
    alternatives.push('ボディターン型：体幹主導を強めて軌道の一貫性をさらに高める');
    alternatives.push('アームスイング型：手元の感覚を磨き、ショートゲームに活かすスタイルもあり');
  }

  if (isFade) {
    characteristics.push('フェード系の球筋を作りやすく、左のミスを抑えやすい特性');
    alternatives.push('ドロー寄り：インサイドアウト軌道とやや遅めのフェースターンで球筋バリエーションを持つ');
  } else if (isDraw) {
    characteristics.push('ドロー系の球筋を作りやすく、飛距離を伸ばしやすい特性');
    alternatives.push('フェード寄り：フェース管理を抑えめにし、コントロール重視の球筋も身につける');
  }

  return {
    label,
    reasons: reasons.slice(0, 3),
    characteristics: characteristics.slice(0, 3),
    alternatives: alternatives.slice(0, 3),
  };
};

const GolfResultPage = () => {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useMeUserState();
  const id = (params?.id ?? '') as string;
  const { state: userState } = useUserState();
  const [showToast, setShowToast] = useState(false);
  const registerUrl = `/golf/register?next=${encodeURIComponent(pathname ?? '/golf/history')}`;

  const [data, setData] = useState<GolfAnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [causalImpact, setCausalImpact] = useState<CausalImpactExplanation | null>(null);
  const [isCausalLoading, setIsCausalLoading] = useState(false);
  const [swingTypes, setSwingTypes] = useState<SwingTypeBadge[]>([]);
  const [swingTypeResult, setSwingTypeResult] = useState<SwingTypeResult | null>(null);
  const [swingTypeLLM, setSwingTypeLLM] = useState<SwingTypeLLMResult | null>(null);
  const [isSwingTypeLoading, setIsSwingTypeLoading] = useState(false);
  const [, setSelectedSwingType] = useState<SwingTypeKey | null>(null);
  const [expandedAlt, setExpandedAlt] = useState<SwingTypeKey | null>(null);
  const [highlightFrames, setHighlightFrames] = useState<number[]>([]);
  const [manualPhase, setManualPhase] = useState<{
    address?: number[];
    backswing?: number[];
    top?: number[];
    downswing?: number[];
    impact?: number[];
    finish?: number[];
  }>({});
  const [isPhaseReevalLoading, setIsPhaseReevalLoading] = useState(false);
  const [phaseReevalError, setPhaseReevalError] = useState<string | null>(null);
  const [isOnPlaneReevalLoading, setIsOnPlaneReevalLoading] = useState(false);
  const [onPlaneReevalError, setOnPlaneReevalError] = useState<string | null>(null);
  const [phaseOverrideAppliedSig, setPhaseOverrideAppliedSig] = useState<string | null>(null);
  const [anonymousUserId, setAnonymousUserId] = useState<string | null>(null);
  const [previousHistory, setPreviousHistory] = useState<SwingAnalysisHistory | null>(null);
  const [hasSavedHistory, setHasSavedHistory] = useState(false);
  const [hasSeededCoachContext, setHasSeededCoachContext] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [proModalOpen, setProModalOpen] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<'idle' | 'generating' | 'ready'>('idle');
  const [isRoundEstimateLoading, setIsRoundEstimateLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  useEffect(() => {
    const id = getAnonymousUserId();
    setAnonymousUserId(id || null);
  }, []);

  useEffect(() => {
    const registered = searchParams.get('registered');
    if (!registered) return;
    setShowToast(true);
    const timer = setTimeout(() => setShowToast(false), 3500);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('registered');
    const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(nextUrl);
    return () => clearTimeout(timer);
  }, [pathname, router, searchParams]);

  const createShareUrl = useCallback(
    async (snsType: 'twitter' | 'instagram' | 'copy'): Promise<string> => {
      setShareBusy(true);
      setShareMessage(null);
      try {
        const totalScoreRaw = data?.result?.totalScore as unknown;
        const totalScore =
          typeof totalScoreRaw === 'number'
            ? totalScoreRaw
            : typeof totalScoreRaw === 'string'
              ? Number(totalScoreRaw)
              : null;
        const normalizedScore = Number.isFinite(totalScore as number) ? (totalScore as number) : null;

        const createdAtRaw = data?.createdAt as unknown;
        const createdAt =
          typeof createdAtRaw === 'number'
            ? createdAtRaw
            : typeof createdAtRaw === 'string'
              ? Number(createdAtRaw)
              : null;
        const normalizedCreatedAt = Number.isFinite(createdAt as number) ? (createdAt as number) : null;

        const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
        const allFrames = (data?.result?.sequence?.frames ?? [])
          .slice(0, 16)
          .map((f) => f.url)
          .filter((u): u is string => typeof u === 'string' && u.length > 0);

        const normalizeIndices = (indices: number[]) => {
          const max = allFrames.length || 16;
          const normalized = indices
            .filter((n) => typeof n === 'number' && Number.isFinite(n))
            .map((n) => clamp(Math.round(n), 1, max));
          return Array.from(new Set(normalized)).sort((a, b) => a - b);
        };

        const stageSelectedIndices = normalizeIndices(
          (data?.result?.sequence?.stages ?? []).flatMap((s) => (Array.isArray(s.keyFrameIndices) ? s.keyFrameIndices : []))
        );

        const selectedFrames = selectShareFrames({
          allFrames,
          manual: {
            address: manualPhase.address,
            backswing: manualPhase.backswing,
            top: manualPhase.top,
            downswing: manualPhase.downswing,
            impact: manualPhase.impact,
            finish: manualPhase.finish,
          },
          stageIndices: stageSelectedIndices,
          desiredCount: 7,
        });

        const sharePayload = {
          analysisId: id,
          totalScore: normalizedScore,
          createdAt: normalizedCreatedAt,
          phases: data?.result?.phases ?? null,
          summary: data?.result?.summary ?? null,
          recommendedDrills: Array.isArray(data?.result?.recommendedDrills) ? data!.result!.recommendedDrills : [],
          selectedFrames,
        };
        const res = await fetch('/api/share/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysisId: id,
            snsType,
            totalScore: normalizedScore,
            createdAt: normalizedCreatedAt,
            sharePayload,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { shareUrl?: string; error?: string };
        if (!res.ok || !json.shareUrl) throw new Error(json.error || '共有リンクの作成に失敗しました');
        return json.shareUrl;
      } finally {
        setShareBusy(false);
      }
    },
    [data, id, manualPhase.address, manualPhase.backswing, manualPhase.downswing, manualPhase.finish, manualPhase.impact, manualPhase.top]
  );

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.left = '-1000px';
        document.body.appendChild(el);
        el.focus();
        el.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
      } catch {
        return false;
      }
    }
  }, []);

  const handleCopyShare = useCallback(async () => {
    try {
      const shareUrl = await createShareUrl('copy');
      const ok = await copyToClipboard(shareUrl);
      setShareMessage(ok ? 'リンクをコピーしました' : 'リンクをコピーできませんでした');
    } catch (e) {
      setShareMessage(e instanceof Error ? e.message : '共有に失敗しました');
    }
  }, [copyToClipboard, createShareUrl]);

  const handleTwitterShare = useCallback(async () => {
    try {
      const shareUrl = await createShareUrl('twitter');
      const intent = new URL('https://twitter.com/intent/tweet');
      intent.searchParams.set('url', shareUrl);
      intent.searchParams.set('text', 'ゴルフAIスイング診断の結果を共有します');
      window.open(intent.toString(), '_blank', 'noopener,noreferrer');
    } catch (e) {
      setShareMessage(e instanceof Error ? e.message : '共有に失敗しました');
    }
  }, [createShareUrl]);

  const handleInstagramShare = useCallback(async () => {
    try {
      const shareUrl = await createShareUrl('instagram');
      if (typeof navigator !== 'undefined' && 'share' in navigator) {
        try {
          // Instagram web share is limited; navigator.share falls back to OS share sheet on mobile.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (navigator as any).share({ url: shareUrl, text: 'ゴルフAIスイング診断の結果' });
          return;
        } catch {
          // fall back to copy
        }
      }
      await copyToClipboard(shareUrl);
      window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
      setShareMessage('リンクをコピーしました（Instagramを開きました）');
    } catch (e) {
      setShareMessage(e instanceof Error ? e.message : '共有に失敗しました');
    }
  }, [copyToClipboard, createShareUrl]);

  useEffect(() => {
    if (!id) return;
    setHasSavedHistory(false);
    setPreviousHistory(null);

    // まずローカル保存済みの診断を優先表示し、サーバーにデータが無い場合のダミー表示を防ぐ
    const local = typeof window !== 'undefined' ? getReportById(id) : null;
    if (local?.result) {
      setData(local);
      setSwingTypes(deriveSwingTypes(local.result));
      setSwingTypeResult(deriveSwingTypeResult(local.result));
      setCausalImpact(local.causalImpact ?? null);
      setFallbackNote(null);
      setIsLoading(false);
      return;
    }

    const fetchResult = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const res = await fetch(`/api/golf/result/${id}`, {
          method: 'GET',
          cache: 'no-store',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || '診断結果の取得に失敗しました。');
        }

        const json = (await res.json()) as GolfAnalysisResponse;
        if (typeof window !== 'undefined') {
          // API 取得が成功したらローカルにも保存して次回以降同一IDを参照
          saveReport(json);
        }

        setData(json);
        if (json.result) {
          setSwingTypes(deriveSwingTypes(json.result));
          setSwingTypeResult(deriveSwingTypeResult(json.result));
        }
        if (json.causalImpact) {
          setCausalImpact(json.causalImpact);
        }
      } catch (err: unknown) {
        console.error(err);
        const message = err instanceof Error ? err.message : '予期せぬエラーが発生しました。';
        if (typeof window !== 'undefined') {
          const stored = getReportById(id);
          if (stored?.result) {
            setData(stored);
            setSwingTypes(deriveSwingTypes(stored.result));
            setSwingTypeResult(deriveSwingTypeResult(stored.result));
            setCausalImpact(stored.causalImpact ?? null);
            return;
          }
        }
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchResult();
  }, [id]);

  useEffect(() => {
    if (!data) return;
    // 完了結果を localStorage に保存（最大20件）
    const record: GolfAnalysisResponse = {
      ...data,
      createdAt: data.createdAt ?? Date.now(),
    };
    saveReport(record);
    setActiveAnalysisPointer(record.analysisId, record.createdAt);
  }, [data]);

  const currentResultCreatedAtTs = useMemo(() => {
    const createdAtSource = data?.result?.createdAt ?? data?.createdAt ?? null;
    if (!createdAtSource) return 0;
    const ts =
      typeof createdAtSource === "number"
        ? createdAtSource
        : typeof createdAtSource === "string"
          ? new Date(createdAtSource).getTime()
          : 0;
    return Number.isFinite(ts) ? ts : 0;
  }, [data?.createdAt, data?.result?.createdAt]);

  useEffect(() => {
    const ownerId = userState.userId ?? anonymousUserId;
    if (!ownerId || !data?.analysisId) {
      setPreviousHistory(null);
      return;
    }
    if (!userState.hasProAccess) {
      setPreviousHistory(pickPreviousHistory(ownerId, data.analysisId, currentResultCreatedAtTs));
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        if (!Number.isFinite(currentResultCreatedAtTs) || currentResultCreatedAtTs <= 0) {
          setPreviousHistory(null);
          return;
        }
        const res = await fetch("/api/golf/history", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as
          | { items?: Array<{ id?: string; createdAt?: number; score?: number | null }> }
          | null;
        const items = Array.isArray(json?.items) ? json!.items! : [];
        const sorted = [...items]
          .filter((it) => typeof it?.id === "string" && typeof it?.createdAt === "number" && typeof it?.score === "number")
          .sort((a, b) => (b.createdAt as number) - (a.createdAt as number));

        const prev =
          sorted.find((it) => it.id !== data.analysisId && (it.createdAt as number) < currentResultCreatedAtTs) ?? null;

        if (cancelled) return;
        if (prev) {
          setPreviousHistory({
            analysisId: prev.id as string,
            userId: ownerId,
            createdAt: new Date(prev.createdAt as number).toISOString(),
            swingScore: prev.score as number,
            estimatedOnCourseScore: "-",
            swingType: "-",
            priorityIssue: "-",
            nextAction: "-",
          });
          return;
        }
        // Server history is the source of truth for members; avoid falling back to localStorage histories
        // because they can contain stale/other-device/other-session data and cause incorrect "前回比".
        setPreviousHistory(null);
      } catch {
        if (!cancelled) setPreviousHistory(null);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [anonymousUserId, currentResultCreatedAtTs, data?.analysisId, userState.hasProAccess, userState.userId]);

  const handleRetry = () => {
    clearActiveAnalysisPointer();
    router.push('/golf/upload');
  };

  // ❗ Hooks は必ずトップレベルで呼ぶ必要がある
  const analyzedAt = useMemo(() => {
    if (!data?.createdAt) return null;
    return new Date(data.createdAt).toLocaleString('ja-JP');
  }, [data?.createdAt]);

  const phaseList = useMemo(() => {
    if (!data?.result?.phases) return [];

    return phaseOrder.map((key) => {
      const phaseData = data.result.phases[key];
      // データの安全性を確保
      const safeData = phaseData
        ? {
            score: typeof phaseData.score === 'number' ? phaseData.score : 0,
            good: Array.isArray(phaseData.good) ? phaseData.good : [],
            issues: Array.isArray(phaseData.issues) ? phaseData.issues : [],
            advice: Array.isArray(phaseData.advice) ? phaseData.advice : [],
          }
        : null;

      return {
        key,
        label:
          key === 'address'
            ? 'アドレス'
            : key === 'backswing'
              ? 'バックスイング'
            : key === 'top'
              ? 'トップ'
              : key === 'downswing'
                ? 'ダウンスイング'
                : key === 'impact'
                  ? 'インパクト'
                  : 'フィニッシュ',
        data: safeData,
      };
    });
  }, [data?.result?.phases]);

  const levelEstimate = useMemo(() => {
    return buildLevelDiagnosis({ totalScore: data?.result?.totalScore ?? 0, phases: data?.result?.phases ?? null });
  }, [data?.result?.phases, data?.result?.totalScore]);

  const fallbackRoundEstimates = useMemo<RoundEstimateMetrics>(() => {
    return computeFallbackRoundEstimates(data?.result?.totalScore ?? 0);
  }, [data?.result?.totalScore]);

  const [roundEstimates, setRoundEstimates] = useState<RoundEstimateMetrics>(fallbackRoundEstimates);

  useEffect(() => {
    setRoundEstimates(fallbackRoundEstimates);
  }, [fallbackRoundEstimates]);

  useEffect(() => {
    if (!data?.result) return;
    if (!data.causalImpact) return;
    setCausalImpact(data.causalImpact);
    setSwingTypeResult(deriveSwingTypeResult(data.result, data.causalImpact));
  }, [data?.analysisId, data?.causalImpact, data?.result]);

  useEffect(() => {
    if (swingTypeLLM) {
      saveSwingTypeResult(swingTypeLLM);
    }
  }, [swingTypeLLM]);

  const extendedSummary = useMemo(() => {
    const base = (data?.result?.summary ?? '').trim();
    const extras: string[] = [];
    const phases = data?.result?.phases;
    const addPhase = (key: keyof typeof phases, label: string) => {
      const phase = phases?.[key];
      if (!phase) return;
      const good = phase.good?.[0];
      const issue = phase.issues?.[0];
      if (good || issue) {
        const goodText = good ? `良い点: ${good}` : '';
        const issueText = issue ? `改善点: ${issue}` : '';
        extras.push(`${label} — ${[goodText, issueText].filter(Boolean).join(' / ')}`);
      }
    };
    addPhase('address', 'Address');
    addPhase('top', 'Top');
    addPhase('downswing', 'Downswing');
    addPhase('impact', 'Impact');
    addPhase('finish', 'Finish');

    if (!extras.length) return base;
    const extraText = extras.map((e) => `- ${e}`).join('\n');
    return `${base}\n\n補足:\n${extraText}`;
  }, [data?.result?.summary, data?.result?.phases]);

  const causalImpactText = useMemo(() => {
    if (!causalImpact) return '';
    const parts: string[] = [];
    if (typeof causalImpact.scoreImpact.obDelta === 'number' && Number.isFinite(causalImpact.scoreImpact.obDelta)) {
      parts.push(`OB +${causalImpact.scoreImpact.obDelta.toFixed(1)}回（18H換算）`);
    }
    parts.push(`推定スコア +${causalImpact.scoreImpact.scoreDelta}打`);
    return parts.join(' → ');
  }, [causalImpact]);

  const displayIssueInfo = useMemo(() => getDisplayIssue(causalImpact?.issue), [causalImpact?.issue]);
  const displayMissLabel = useMemo(() => getDisplayMiss(causalImpact?.relatedMiss), [causalImpact?.relatedMiss]);
  const nextActionText = causalImpact?.nextAction?.content ?? displayIssueInfo.nextAction;
  const causalChain = useMemo(() => {
    if (!causalImpact) return [];
    const base = causalImpact.chain?.length ? [...causalImpact.chain] : [displayIssueInfo.label, displayMissLabel];
    const shouldPrefix = data?.result?.swingStyleChange?.change === "improving";
    if (shouldPrefix && base[0] !== "スイング様式を胸主導へ移行中") {
      base.unshift("スイング様式を胸主導へ移行中");
    }
    const chain = base;
    if (causalImpactText) chain.push(causalImpactText);
    return chain;
  }, [causalImpact, causalImpactText, data?.result?.swingStyleChange?.change, displayIssueInfo.label, displayMissLabel]);
  const swingTypeBadges = useMemo(
    () => (data?.result ? deriveSwingTypes(data.result) : swingTypes),
    [data?.result, swingTypes]
  );
  const swingTypeSummary = useMemo(
    () => (data?.result ? swingTypeResult ?? deriveSwingTypeResult(data.result, causalImpact) : swingTypeResult),
    [data?.result, swingTypeResult, causalImpact]
  );

  const swingTypeMatches = useMemo(() => {
    if (swingTypeLLM?.swingTypeMatch?.length) return swingTypeLLM.swingTypeMatch;
    if (swingTypeSummary?.label) {
      return [
        {
          type: 'body_turn' as SwingTypeKey,
          label: swingTypeSummary.label,
          matchScore: 0.72,
          reason: swingTypeSummary.reasons?.[0] ?? '診断結果から推定',
        },
      ];
    }
    return [];
  }, [swingTypeLLM?.swingTypeMatch, swingTypeSummary]);

  const bestType = useMemo(() => swingTypeMatches[0] ?? null, [swingTypeMatches]);

  const bestTypeDetail = useMemo(() => {
    const key = bestType?.type;
    if (key && swingTypeLLM?.swingTypeDetails?.[key]) {
      return swingTypeLLM.swingTypeDetails[key];
    }
    if (swingTypeSummary?.label) {
      return {
        title: swingTypeSummary.label,
        shortDescription: swingTypeSummary.characteristics?.[0] ?? '',
        overview: swingTypeSummary.reasons?.join('。') ?? '',
        characteristics: swingTypeSummary.characteristics ?? [],
        recommendedFor: ['このタイプをベースにさらに安定性を高めたい方'],
        advantages: ['診断から見た強みを活かしやすい'],
        disadvantages: [],
        commonMistakes: [],
        cta: {
          headline: 'このスイングを目指したい方へ',
          message:
            'このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。',
          buttonText: 'この型を目標にAIコーチに相談する',
        },
      };
    }
    return null;
  }, [bestType?.type, swingTypeLLM?.swingTypeDetails, swingTypeSummary]);

  const alternativeTypes = useMemo(() => {
    const matches = swingTypeMatches.slice(1, 4);
    if (matches.length) return matches;
    return [];
  }, [swingTypeMatches]);

  useEffect(() => {
    const ownerId = userState.userId ?? anonymousUserId;
    if (
      !ownerId ||
      !data?.analysisId ||
      !data.result ||
      !causalImpact ||
      !roundEstimates.strokeRange ||
      hasSavedHistory
    ) {
      return;
    }

    const createdAtSource = data.result.createdAt ?? data.createdAt;
    const createdAtIso =
      typeof createdAtSource === 'number'
        ? new Date(createdAtSource).toISOString()
        : createdAtSource ?? new Date().toISOString();

    const history: SwingAnalysisHistory = {
      analysisId: data.analysisId,
      userId: ownerId,
      createdAt: createdAtIso,
      swingScore: data.result.totalScore,
      estimatedOnCourseScore: roundEstimates.strokeRange,
      swingType: bestType?.label ?? swingTypeSummary?.label ?? '診断中',
      priorityIssue: displayIssueInfo.label,
      nextAction: nextActionText,
    };

    saveSwingHistory(history);
    if (!userState.hasProAccess) {
      setPreviousHistory(pickPreviousHistory(ownerId, history.analysisId, new Date(history.createdAt).getTime()));
    }
    setHasSavedHistory(true);
  }, [
    anonymousUserId,
    userState.userId,
    userState.hasProAccess,
    bestType?.label,
    causalImpact,
    data?.analysisId,
    data?.createdAt,
    data?.result,
    displayIssueInfo.label,
    hasSavedHistory,
    nextActionText,
    roundEstimates.strokeRange,
    swingTypeSummary?.label,
  ]);

  useEffect(() => {
    const identityKeys: string[] = [];
    if (userState.userId) identityKeys.push(`user:${userState.userId}`);
    if (anonymousUserId) identityKeys.push(`anon:${anonymousUserId}`);
    if (!identityKeys.length || !data?.analysisId || !causalImpact || hasSeededCoachContext) return;
    const swingTypeTitle = bestTypeDetail?.title || bestType?.label || swingTypeSummary?.label || null;
    const analyzedAtIso = data.createdAt ? new Date(data.createdAt).toISOString() : null;
    const context = buildCoachContext({
      causal: causalImpact,
      displayIssue: displayIssueInfo.label,
      chain: causalChain,
      nextAction: nextActionText,
      analysisId: data.analysisId,
      summary: extendedSummary,
      swingTypeHeadline: swingTypeTitle,
      analyzedAt: analyzedAtIso,
    });
    identityKeys.forEach((key) => saveBootstrapContext(key, context));
    setHasSeededCoachContext(true);
  }, [
    bestType?.label,
    bestTypeDetail?.title,
    causalChain,
    causalImpact,
    data?.analysisId,
    data?.createdAt,
    displayIssueInfo.label,
    extendedSummary,
    hasSeededCoachContext,
    nextActionText,
    swingTypeSummary?.label,
    userState.userId,
    anonymousUserId,
  ]);

  useEffect(() => {
    if (!highlightFrames.length) return;
    const targetId = `sequence-frame-${highlightFrames[0]}`;
    const el = typeof document !== 'undefined' ? document.getElementById(targetId) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightFrames]);

  useEffect(() => {
    if (!data?.analysisId) return;
    const stored = loadPhaseOverride(data.analysisId);
    if (!stored) return;
    setManualPhase({
      address: stored.address,
      backswing: stored.backswing,
      top: stored.top,
      downswing: stored.downswing,
      impact: stored.impact,
      finish: stored.finish,
    });
  }, [data?.analysisId]);

  const phaseOverrideSig = useMemo(() => {
    const ad = (manualPhase.address ?? []).join(",");
    const bs = (manualPhase.backswing ?? []).join(",");
    const top = (manualPhase.top ?? []).join(",");
    const ds = (manualPhase.downswing ?? []).join(",");
    const imp = (manualPhase.impact ?? []).join(",");
    const fin = (manualPhase.finish ?? []).join(",");
    if (!ad && !bs && !top && !ds && !imp && !fin) return "";
    return `ad:${ad}|bs:${bs}|top:${top}|ds:${ds}|imp:${imp}|fin:${fin}`;
  }, [
    manualPhase.address,
    manualPhase.backswing,
    manualPhase.downswing,
    manualPhase.finish,
    manualPhase.impact,
    manualPhase.top,
  ]);

  useEffect(() => {
    if (!data?.analysisId || typeof window === "undefined") return;
    const key = `golf_phase_override_applied_${data.analysisId}`;
    setPhaseOverrideAppliedSig(window.localStorage.getItem(key));
  }, [data?.analysisId]);

  const runFullEvaluation = async () => {
    if (!data?.analysisId) return;
    const address = manualPhase.address ?? [];
    const backswing = manualPhase.backswing ?? [];
    const top = manualPhase.top ?? [];
    const downswing = manualPhase.downswing ?? [];
    const impact = manualPhase.impact ?? [];
    const finish = manualPhase.finish ?? [];
    if (!address.length && !backswing.length && !top.length && !downswing.length && !impact.length && !finish.length) return;

    try {
      setDiagnosticsStatus('generating');
      setIsPhaseReevalLoading(true);
      setPhaseReevalError(null);
      setIsRoundEstimateLoading(false);
      setIsCausalLoading(false);
      setIsSwingTypeLoading(false);
      setCausalImpact(null);
      setSwingTypeLLM(null);
      const res = await fetch("/api/golf/reanalyze-phases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId: data.analysisId, address, backswing, top, downswing, impact, finish }),
      });
      const json = (await res.json().catch(() => null)) as GolfAnalysisResponse | { error?: string } | null;
      if (!res.ok) {
        const message =
          (json && typeof json === "object" && "error" in json && json.error) || "再評価に失敗しました";
        throw new Error(message);
      }
      if (!json || typeof json !== "object" || !("result" in json)) {
        throw new Error("invalid response");
      }
      const next = json as GolfAnalysisResponse;
      if (typeof window !== "undefined") {
        const key = `golf_phase_override_applied_${data.analysisId}`;
        window.localStorage.setItem(key, phaseOverrideSig);
        setPhaseOverrideAppliedSig(phaseOverrideSig);
      }
      setData(next);
      if (next.result) {
        setSwingTypes(deriveSwingTypes(next.result));
        setSwingTypeResult(deriveSwingTypeResult(next.result));
      }

      if (!next.result) {
        setDiagnosticsStatus('ready');
        return;
      }

      const fallback = computeFallbackRoundEstimates(next.result.totalScore ?? 0);
      setRoundEstimates(fallback);
      setIsRoundEstimateLoading(true);
      let resolvedRound = fallback;
      try {
        const roundRes = await fetch('/api/golf/round-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            totalScore: next.result.totalScore,
            phases: next.result.phases,
            meta: next.meta,
          }),
        });
        if (roundRes.ok) {
          const roundJson = (await roundRes.json().catch(() => ({}))) as Partial<RoundEstimateMetrics>;
          resolvedRound = {
            strokeRange: typeof roundJson.strokeRange === 'string' ? roundJson.strokeRange : fallback.strokeRange,
            fwKeep: typeof roundJson.fwKeep === 'string' ? roundJson.fwKeep : fallback.fwKeep,
            gir: typeof roundJson.gir === 'string' ? roundJson.gir : fallback.gir,
            ob: typeof roundJson.ob === 'string' ? roundJson.ob : fallback.ob,
          };
        }
      } catch {
        // ignore (use fallback)
      } finally {
        setIsRoundEstimateLoading(false);
        setRoundEstimates(resolvedRound);
      }

      const localCausalFallback = buildLocalCausalImpact(next.result, resolvedRound);
      let resolvedCausal = localCausalFallback;
      if (next.causalImpact) {
        resolvedCausal = next.causalImpact;
      } else {
        setIsCausalLoading(true);
        try {
          const causalRes = await fetch('/api/golf/causal-explanation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              analysisId: next.analysisId,
              totalScore: next.result.totalScore,
              phases: next.result.phases,
              summary: next.result.summary,
              meta: next.meta,
              roundEstimates: resolvedRound,
            }),
          });
          if (causalRes.ok) {
            const causalJson = (await causalRes.json().catch(() => ({}))) as Partial<{ causalImpact: CausalImpactExplanation }>;
            resolvedCausal = causalJson.causalImpact ?? localCausalFallback;
          }
        } catch {
          resolvedCausal = localCausalFallback;
        } finally {
          setIsCausalLoading(false);
        }
      }
      setCausalImpact(resolvedCausal);
      setSwingTypeResult(deriveSwingTypeResult(next.result, resolvedCausal));
      setData({ ...next, causalImpact: resolvedCausal });

      setIsSwingTypeLoading(true);
      let resolvedSwingType: SwingTypeLLMResult | undefined;
      try {
        const stRes = await fetch('/api/golf/swing-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysis: next.result,
            meta: next.meta,
            causalImpact: resolvedCausal,
          }),
        });
        if (stRes.ok) {
          const stJson = (await stRes.json().catch(() => null)) as SwingTypeLLMResult | null;
          if (stJson) {
            setSwingTypeLLM(stJson);
            setSelectedSwingType(stJson.swingTypeMatch?.[0]?.type ?? null);
            resolvedSwingType = stJson;
          }
        }
      } catch {
        // ignore
      } finally {
        setIsSwingTypeLoading(false);
      }

      saveDiagnostics({
        analysisId: next.analysisId,
        phaseOverrideSig,
        roundEstimates: resolvedRound,
        causalImpact: resolvedCausal,
        swingTypeLLM: resolvedSwingType,
      });

      setDiagnosticsStatus('ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : "再評価に失敗しました";
      setPhaseReevalError(message);
      setDiagnosticsStatus('idle');
    } finally {
      setIsPhaseReevalLoading(false);
    }
  };

  const runOnPlaneEvaluation = async () => {
    if (!data?.analysisId) return;
    const address = manualPhase.address ?? [];
    const backswing = manualPhase.backswing ?? [];
    const top = manualPhase.top ?? [];
    const downswing = manualPhase.downswing ?? [];
    const impact = manualPhase.impact ?? [];
    const finish = manualPhase.finish ?? [];
    if (!top.length || !downswing.length || !impact.length) return;

    try {
      setIsOnPlaneReevalLoading(true);
      setOnPlaneReevalError(null);
      const res = await fetch("/api/golf/reanalyze-phases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId: data.analysisId,
          address,
          backswing,
          top,
          downswing,
          impact,
          finish,
          onPlaneOnly: true,
        }),
      });
      const json = (await res.json().catch(() => null)) as GolfAnalysisResponse | { error?: string } | null;
      if (!res.ok) {
        const message =
          (json && typeof json === "object" && "error" in json && json.error) || "オンプレーン診断に失敗しました";
        throw new Error(message);
      }
      if (!json || typeof json !== "object" || !("result" in json)) {
        throw new Error("invalid response");
      }
      const next = json as GolfAnalysisResponse;
      setData(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "オンプレーン診断に失敗しました";
      setOnPlaneReevalError(message);
    } finally {
      setIsOnPlaneReevalLoading(false);
    }
  };

  const analysisId = data?.analysisId ?? '';

  const sequenceFrames = useMemo(() => {
    return (data?.result?.sequence?.frames ?? []) as Array<{ url: string; timestampSec?: number }>;
  }, [data?.result?.sequence?.frames]);

  const sequenceStages = useMemo(() => {
    return (data?.result?.sequence?.stages ?? []) as SequenceStageFeedback[];
  }, [data?.result?.sequence?.stages]);

  const initialConfirmedSelections = useMemo(
    () => ({
      AD: manualPhase.address ?? [],
      BS: manualPhase.backswing ?? [],
      TOP: manualPhase.top ?? [],
      DS: manualPhase.downswing ?? [],
      IMP: manualPhase.impact ?? [],
      FIN: manualPhase.finish ?? [],
    }),
    [manualPhase.address, manualPhase.backswing, manualPhase.downswing, manualPhase.finish, manualPhase.impact, manualPhase.top],
  );

  const phaseSelectorSyncKey = useMemo(() => {
    return `${analysisId}:${phaseOverrideSig}`;
  }, [analysisId, phaseOverrideSig]);

  const selectorFrames = useMemo(() => {
    const src = (sequenceFrames ?? []).slice(0, 16);
    return src.map((f, idx) => ({
      index: idx + 1,
      imageUrl: f.url,
      timestampSec: f.timestampSec,
    }));
  }, [sequenceFrames]);

  const handleConfirmedSelectionsChange = useCallback(
    (next: { AD: number[]; BS: number[]; TOP: number[]; DS: number[]; IMP: number[]; FIN: number[] }) => {
      setManualPhase({
        address: next.AD,
        backswing: next.BS,
        top: next.TOP,
        downswing: next.DS,
        impact: next.IMP,
        finish: next.FIN,
      });
      if (!analysisId) return;
      savePhaseOverride(analysisId, {
        address: next.AD,
        backswing: next.BS,
        top: next.TOP,
        downswing: next.DS,
        impact: next.IMP,
        finish: next.FIN,
      });
    },
    [analysisId],
  );

  const handleResetAllPhases = useCallback(() => {
    if (!analysisId) return;
    clearPhaseOverride(analysisId);
    clearDiagnostics(analysisId);
    setManualPhase({});
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(`golf_phase_override_applied_${analysisId}`);
    }
    setPhaseOverrideAppliedSig(null);
    setDiagnosticsStatus('idle');
  }, [analysisId]);

  const isReevaluateEnabled =
    !isPhaseReevalLoading &&
    (!!manualPhase.address?.length ||
      !!manualPhase.backswing?.length ||
      !!manualPhase.top?.length ||
      !!manualPhase.downswing?.length ||
      !!manualPhase.impact?.length ||
      !!manualPhase.finish?.length);
  const isOnPlaneReevalEnabled =
    !isOnPlaneReevalLoading &&
    !isPhaseReevalLoading &&
    !!manualPhase.top?.length &&
    !!manualPhase.downswing?.length &&
    !!manualPhase.impact?.length;

  const requiresManualEvaluation = sequenceFrames.length > 0;
  useEffect(() => {
    if (!analysisId) return;
    if (!requiresManualEvaluation) {
      setDiagnosticsStatus('ready');
      return;
    }

    if (typeof window === 'undefined') return;
    const appliedSig = window.localStorage.getItem(`golf_phase_override_applied_${analysisId}`);
    if (appliedSig && appliedSig === phaseOverrideSig) {
      const stored = loadDiagnostics(analysisId);
      if (stored?.roundEstimates) setRoundEstimates(stored.roundEstimates);
      if (stored?.causalImpact) {
        setCausalImpact(stored.causalImpact);
        if (data?.result) setSwingTypeResult(deriveSwingTypeResult(data.result, stored.causalImpact));
      }
      if (stored?.swingTypeLLM) {
        setSwingTypeLLM(stored.swingTypeLLM);
        setSelectedSwingType(stored.swingTypeLLM.swingTypeMatch?.[0]?.type ?? null);
      }
      setDiagnosticsStatus('ready');
      return;
    }

    setDiagnosticsStatus('idle');
  }, [analysisId, data?.result, phaseOverrideSig, requiresManualEvaluation]);

  const isGeneratingAllDiagnostics =
    diagnosticsStatus === 'generating' || isPhaseReevalLoading || isRoundEstimateLoading || isCausalLoading || isSwingTypeLoading;

  // ▼ early return は Hooks の後に置く
  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50">
        <p>診断結果を取得しています…</p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-50 space-y-4">
        <p className="text-red-400 text-sm">{error || '診断結果が見つかりませんでした。'}</p>
        <button
          onClick={handleRetry}
          className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
        >
          再診断する
        </button>
      </main>
    );
  }

  const { result, note, meta } = data;
  if (!result) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-50 space-y-4">
        <p className="text-red-400 text-sm">診断結果データが不正です。</p>
        <button
          onClick={handleRetry}
          className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
        >
          再診断する
        </button>
      </main>
    );
  }
  const comparison = result.comparison;
  const previousScoreDelta = previousHistory ? result.totalScore - previousHistory.swingScore : null;
  const previousAnalyzedAt =
    previousHistory?.createdAt ? new Date(previousHistory.createdAt).toLocaleString('ja-JP') : null;
  const usageBanner = !userState.hasProAccess ? userState.monthlyAnalysis : null;
  const shouldShowPhaseEvaluation =
    sequenceFrames.length === 0 ||
    (!!manualPhase.downswing?.length &&
      !!manualPhase.impact?.length &&
      phaseOverrideSig.length > 0 &&
      phaseOverrideSig === phaseOverrideAppliedSig);
  const onPlaneData =
    (result as unknown as Record<string, unknown>)?.on_plane ??
    (result as unknown as Record<string, unknown>)?.onPlane ??
    (result as unknown as Record<string, unknown>)?.onPlaneData ??
    null;
  const onPlaneOverlayFrames = (() => {
    const debugList =
      (onPlaneData as Record<string, unknown> | null)?.debug_frames ??
      (onPlaneData as Record<string, unknown> | null)?.debugFrames ??
      null;
    if (Array.isArray(debugList)) {
      const picked = debugList
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const url = typeof (entry as { url?: unknown }).url === 'string' ? (entry as { url: string }).url : null;
          if (!url || !url.startsWith('data:image/')) return null;
          const label =
            typeof (entry as { label?: unknown }).label === 'string' ? (entry as { label: string }).label : 'Frame';
          return { url, label };
        })
        .filter(Boolean) as Array<{ url: string; label: string }>;
      if (picked.length) return picked;
    }

    const seq = result?.sequence;
    const frames = Array.isArray(seq?.frames) ? seq.frames : [];
    const urls = frames.map((f) => (f && typeof (f as { url?: unknown }).url === 'string' ? (f as { url: string }).url : null));
    const validAt = (idx0: number | null) => (idx0 == null ? null : urls[idx0] && urls[idx0]!.startsWith('data:image/') ? urls[idx0] : null);

    const pickFromManual = (indices1Based: number[] | undefined | null) => {
      if (!Array.isArray(indices1Based) || !indices1Based.length) return null;
      for (const n of indices1Based) {
        const idx0 = normalizeFrameIndex(n, urls.length);
        const url = validAt(idx0);
        if (url) return url;
      }
      return null;
    };

    const pickFromStage = (stageKey: string) => {
      const stages = Array.isArray(seq?.stages) ? seq!.stages : [];
      const found = stages.find((s) => s && typeof (s as { stage?: unknown }).stage === 'string' && (s as { stage: string }).stage === stageKey);
      const indices = found && Array.isArray((found as { keyFrameIndices?: unknown }).keyFrameIndices) ? (found as { keyFrameIndices: unknown[] }).keyFrameIndices : [];
      for (const raw of indices) {
        const idx0 = normalizeFrameIndex(raw, urls.length);
        const url = validAt(idx0);
        if (url) return url;
      }
      return null;
    };

    const adUrl =
      pickFromManual(manualPhase.address) ??
      pickFromStage('address') ??
      pickFromStage('address_to_backswing') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.address?.[0], urls.length));
    const bsUrl =
      pickFromManual(manualPhase.backswing) ??
      pickFromStage('address_to_backswing') ??
      pickFromStage('backswing_to_top') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.backswing?.[0], urls.length));
    const topUrl =
      pickFromManual(manualPhase.top) ??
      pickFromStage('backswing_to_top') ??
      pickFromStage('top_to_downswing') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.top?.[0], urls.length));
    const pickFromManualAt = (indices1Based: number[] | undefined | null, pos: number) => {
      if (!Array.isArray(indices1Based) || indices1Based.length <= pos) return null;
      const idx0 = normalizeFrameIndex(indices1Based[pos], urls.length);
      return validAt(idx0);
    };

    const dsEarlyUrl =
      pickFromManualAt(manualPhase.downswing, 0) ??
      pickFromStage('top_to_downswing') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.downswing?.[0], urls.length));
    const dsLateUrl =
      pickFromManualAt(manualPhase.downswing, 1) ??
      pickFromStage('downswing_to_impact') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.downswing?.[1], urls.length));
    const impUrl =
      pickFromManual(manualPhase.impact) ??
      pickFromStage('impact') ??
      validAt(normalizeFrameIndex(PHASE_FRAME_MAP.impact?.[0], urls.length)) ??
      dsLateUrl;

    const out: Array<{ url: string; label: string }> = [];
    if (adUrl) out.push({ url: adUrl, label: 'Address' });
    if (bsUrl) out.push({ url: bsUrl, label: 'Backswing' });
    if (topUrl) out.push({ url: topUrl, label: 'Top' });
    if (dsEarlyUrl) out.push({ url: dsEarlyUrl, label: 'Downswing 1' });
    if (dsLateUrl) out.push({ url: dsLateUrl, label: 'Downswing 2' });
    if (impUrl) out.push({ url: impUrl, label: 'Impact' });
    return out;
  })();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex justify-center">
      <div className="w-full max-w-3xl px-4 py-8 space-y-6">
        {showToast && (
          <div className="fixed top-4 inset-x-0 flex justify-center px-4">
            <div className="max-w-lg w-full rounded-lg border border-emerald-400/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 shadow-lg shadow-emerald-900/30">
              登録が完了しました。履歴が保存されました。
            </div>
          </div>
        )}
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AIゴルフスイング診断 – 結果</h1>
            <p className="text-xs text-slate-400 mt-1">解析ID：{data.analysisId}</p>
            {(meta || analyzedAt) && (
              <div className="mt-1 space-y-0.5 text-xs text-slate-400">
                {analyzedAt && <p>解析日時: {analyzedAt}</p>}
                {meta && (
                  <p>
                    入力情報: {meta.handedness === 'right' ? '右打ち' : '左打ち'} / {meta.clubType} / {meta.level}
                  </p>
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleRetry}
            className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            再診断する
          </button>
          <Link
            href="/golf/history"
            className="text-xs text-emerald-300 underline underline-offset-4"
          >
            これまでの診断履歴を見る
          </Link>
        </header>

        {!userState.isAuthenticated && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-900/20 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-emerald-100">履歴を保存してスコア推移を確認しましょう</p>
              <p className="text-xs text-emerald-200">
                メール登録で無料診断が合計3回利用でき、履歴とスコア推移グラフが解放されます。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => router.push(registerUrl)}
                className="rounded-md bg-emerald-500 hover:bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-900"
              >
                メールアドレスを登録する
              </button>
              <Link
                href="/golf/history"
                className="rounded-md border border-emerald-400/60 px-3 py-2 text-xs font-semibold text-emerald-100 hover:border-emerald-300"
              >
                履歴を確認する
              </Link>
            </div>
          </div>
        )}

        {usageBanner && (
          <div className="rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-50 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold">
                無料診断 残り {usageBanner.remaining ?? 0} 回（合計 {usageBanner.limit ?? 0} 回まで）
              </p>
              <span className="text-xs text-amber-100/80">
                累計 {usageBanner.used} / {usageBanner.limit ?? 0} 回利用
              </span>
            </div>
            {(usageBanner.remaining ?? 0) === 1 && <p className="text-xs text-amber-200">無料診断は残り1回です。</p>}
            {(usageBanner.remaining ?? 0) === 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-amber-200">無料診断の利用回数は上限に達しました。</p>
                {userState.isAuthenticated && (
                  <button
                    type="button"
                    className="rounded-md border border-emerald-200/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/25"
                    onClick={() => router.push('/pricing')}
                  >
                    PROにアップグレード
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {(note || fallbackNote) && (
          <p className="text-xs text-amber-300">
            {fallbackNote ? fallbackNote : note}
          </p>
        )}

        {/* 連続フレーム診断（再評価の起点） */}
        {(sequenceFrames.length > 0 || sequenceStages.length > 0) && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">連続フレーム診断</h2>
              </div>
              {sequenceFrames.length === 0 ? <span className="text-xs text-slate-300">ステージコメントのみ</span> : null}
            </div>

            {phaseReevalError && <p className="text-xs text-rose-300">再評価エラー: {phaseReevalError}</p>}
            {sequenceFrames.length > 0 && (
              <div id="manual-phase-selector">
                <PhaseFrameSelector
                  frames={selectorFrames}
                  initialConfirmedSelections={initialConfirmedSelections}
                  syncKey={phaseSelectorSyncKey}
                  highlightedFrames={highlightFrames}
                  isReevaluating={isPhaseReevalLoading}
                  isReevaluateEnabled={isReevaluateEnabled}
                  hasEvaluationResult={diagnosticsStatus === 'ready'}
                  onConfirmedSelectionsChange={handleConfirmedSelectionsChange}
                  onReevaluate={() => void runFullEvaluation()}
                  onResetAll={handleResetAllPhases}
                />
              </div>
            )}
          </section>
        )}

        {isGeneratingAllDiagnostics && (
          <section className="rounded-xl border border-emerald-500/30 bg-emerald-900/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-semibold text-emerald-100">評価を生成中…</p>
              <p className="text-[11px] text-emerald-200/90">少し時間がかかる場合があります</p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div className="h-full w-full bg-gradient-to-r from-emerald-400 via-emerald-200 to-emerald-400 opacity-70 animate-pulse" />
            </div>
          </section>
        )}

        {diagnosticsStatus === 'ready' && (
          <>
        {/* スコア */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 sm:col-span-1">
            <p className="text-xs text-slate-400">総合スイングスコア</p>
            <p className="text-3xl font-bold mt-1">{result.totalScore}</p>
            <p className="text-xs text-slate-400 mt-1">（100点満点）</p>
            <p className="text-[11px] text-slate-500 mt-1">
              ※同じ動画でも、AIの推定誤差やフレーム抽出の差で数点ブレる場合があります
            </p>
            {userState.hasProAccess && previousHistory && (
              <div className="mt-3 space-y-1 text-xs text-slate-300">
                <p>
                  前回{previousAnalyzedAt ? `（${previousAnalyzedAt}）` : ''}：{previousHistory.swingScore} 点
                </p>
                {typeof previousScoreDelta === 'number' && (
                  <p className={previousScoreDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {previousScoreDelta === 0
                      ? 'スコアは変化なし'
                      : `今回 ${previousScoreDelta >= 0 ? '+' : ''}${previousScoreDelta} 点`}
                  </p>
                )}
              </div>
            )}
            {!userState.hasProAccess && previousHistory && (
              <div className="mt-3 relative rounded-lg border border-slate-800 bg-slate-950/20 p-3 text-xs text-slate-300">
                <div className="opacity-50 space-y-1">
                  <p>前回との比較（PRO）</p>
                  <p>前回比のスコア変化・改善点の比較は PRO で確認できます。</p>
                </div>
                <button
                  type="button"
                  className="absolute inset-0 rounded-lg"
                  aria-label="PRO案内"
                  onClick={() => setProModalOpen(true)}
                />
              </div>
            )}
          </div>
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 sm:col-span-2">
            <p className="text-sm font-semibold text-slate-100">📣 この診断結果を共有する</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleTwitterShare}
                disabled={shareBusy}
                className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              >
                Xで共有
              </button>
              <button
                type="button"
                onClick={handleInstagramShare}
                disabled={shareBusy}
                className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              >
                Instagramで共有
              </button>
              <button
                type="button"
                onClick={handleCopyShare}
                disabled={shareBusy}
                className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 px-3 py-2 text-sm text-slate-100"
              >
                リンクをコピー
              </button>
            </div>
            {shareMessage && <p className="text-xs text-slate-300 mt-2">{shareMessage}</p>}
          </section>
        </section>

        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
          <p className="text-xs text-slate-400">推定レベル診断</p>
          <p className="text-xl font-semibold mt-1">{levelEstimate.label}</p>
          <p className="text-sm text-slate-300 mt-1 whitespace-pre-line">{levelEstimate.detail}</p>
        </section>

        {/* 推定ラウンドスコア/推奨ドリル */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">推定ラウンドスコア</p>
            <p className="text-3xl font-bold mt-1">{roundEstimates.strokeRange}</p>
            <p className="text-xs text-slate-400 mt-1">ラウンドスコアの目安レンジ（ストローク）</p>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <p>推定フェアウェイキープ率: {roundEstimates.fwKeep}</p>
              <p>推定パーオン率: {roundEstimates.gir}</p>
              <p>推定OB数（18H換算）: {roundEstimates.ob}</p>
            </div>
          </div>
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4">
            <p className="text-xs text-slate-400">推奨ドリル</p>
            {result.recommendedDrills && result.recommendedDrills.length > 0 ? (
              <ul className="list-disc pl-5 space-y-1 text-sm mt-2">
                {result.recommendedDrills.map((drill, i) => (
                  <li key={i}>{drill}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-300 mt-2">ドリル情報がありません。</p>
            )}
          </div>
        </section>

        {/* 因果チェーン（最重要の1点） */}
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-slate-400">スコアへの因果チェーン（AI推定）</p>
              <p className="text-sm font-semibold text-slate-100">最もスコアに影響する1点をピックアップ</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              {causalImpact?.confidence && (
                <span
                  className={
                    causalImpact.confidence === 'high'
                      ? 'text-emerald-300'
                      : causalImpact.confidence === 'medium'
                        ? 'text-amber-200'
                        : 'text-rose-200'
                  }
                >
                  信頼度: {causalImpact.confidence === 'high' ? '高' : causalImpact.confidence === 'medium' ? '中' : '低（参考）'}
                </span>
              )}
              <span>{isCausalLoading ? '推定中…' : causalImpact?.source === 'ai' ? 'AI推定' : 'ルールベース'}</span>
            </div>
          </div>
          {SHOW_SWING_STYLE_COMMENT_UI &&
            typeof result.swingStyleComment === "string" &&
            result.swingStyleComment.trim().length > 0 && (
              <p className="text-sm text-slate-200">{result.swingStyleComment}</p>
            )}
          {causalImpact ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {causalChain.map((item, idx) => (
                  <div key={`${item}-${idx}`} className="flex items-center gap-2">
                    <div
                      className={`px-3 py-2 rounded-lg border text-sm ${
                        idx === 0
                          ? 'bg-rose-900/40 border-rose-700/50 text-rose-100'
                          : idx === causalChain.length - 1
                            ? 'bg-emerald-900/40 border-emerald-700/50 text-emerald-100'
                            : 'bg-slate-800/60 border-slate-700 text-slate-100'
                      }`}
                    >
                      {item}
                    </div>
                    {idx < causalChain.length - 1 && <span className="text-slate-400 text-lg">→</span>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-300">因果チェーンを準備中です。</p>
          )}
        </section>

        {/* フェーズごとの評価 */}
        {shouldShowPhaseEvaluation ? (
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-4">
          <h2 className="text-sm font-semibold">フェーズ別評価</h2>
          {isPhaseReevalLoading && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-900/10 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-emerald-100">評価を生成中…</p>
                <p className="text-[11px] text-emerald-200/90">少し時間がかかる場合があります</p>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div className="h-full w-full bg-gradient-to-r from-emerald-400 via-emerald-200 to-emerald-400 opacity-70 animate-pulse" />
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {phaseList.map(({ key, label, data }) => {
              if (!data) {
                return (
                  <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{label}</p>
                    </div>
                    <div className="text-sm text-amber-300">解析データが不足しています（{key}）。</div>
                  </div>
                );
              }

              // データの安全性を再確認
	              const safeGood = Array.isArray(data.good) ? data.good : [];
	              const safeIssues = Array.isArray(data.issues) ? data.issues : [];
	              const safeAdvice = Array.isArray(data.advice) ? data.advice : [];
	
	              const swingStyle = result.swingStyle;
	              const swingStyleChange = result.swingStyleChange;
	              const shouldShowSwingStyleComment =
	                !!swingStyle &&
	                !!swingStyleChange &&
	                swingStyle.confidence !== 'low' &&
	                swingStyleChange.change !== 'unchanged' &&
	                swingStyleChange.change !== 'unclear';
	
	              const swingStyleCommentText = (() => {
	                if (!shouldShowSwingStyleComment) return null;
	                if (key === 'top' && swingStyleChange?.current === 'torso-dominant') {
	                  return `トップでは、腕だけで上げる動きから\n胸の回転を使った形に変わりつつあります。\n切り返し以降の動きと噛み合うと安定感が増します。`;
	                }
	                if (key === 'downswing' && swingStyleChange?.change === 'improving') {
	                  return `ダウンスイングでは、\n手先ではなく胸の回転でクラブを下ろそうとする意識が見られます。\nまだタイミングにばらつきがありますが、方向性としては良い変化です。`;
	                }
	                if (key === 'impact' && swingStyleChange?.current === 'torso-dominant' && data.score < 15) {
	                  return `インパクトでは胸の回転を使った形に移行していますが、\nフェース管理がまだ安定しきっていません。\n動き自体は正しいため、再現性を高める段階です。`;
	                }
	                return null;
	              })();

	              return (
	                <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
	                  <div className="flex items-center justify-between">
	                    <p className="text-sm font-semibold">{label}</p>
                    <span className="text-xs text-slate-300">スコア：{data.score}/20</span>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">良い点</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {safeGood.map((g, i) => {
                        try {
                          return <li key={i}>{attachFrameRange(String(g || ''), key, sequenceStages, manualPhase)}</li>;
                        } catch (err) {
                          console.error('[phaseList] error rendering good item:', err, { key, i, g });
                          return <li key={i}>{String(g || '')}</li>;
                        }
                      })}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">改善点</p>
                    <ul className="list-disc pl-4 text-sm space-y-1">
                      {safeIssues.map((b, i) => {
                        try {
                          const text = attachFrameRange(String(b || ''), key, sequenceStages, manualPhase);
                          return (
                            <li
                              key={i}
                              className="cursor-pointer hover:text-emerald-200 transition-colors"
                              onClick={() => {
                                try {
                                  const range = getFrameRange(key, sequenceStages, manualPhase);
                                  if (!range) return;
                                  const [start, end] = range;
                                  const arr = Array.from({ length: end - start + 1 }, (_, idx) => start + idx);
                                  setHighlightFrames(arr);
                                } catch (err) {
                                  console.error('[phaseList] error in onClick:', err);
                                }
                              }}
                            >
                              {text}
                            </li>
                          );
                        } catch (err) {
                          console.error('[phaseList] error rendering issues item:', err, { key, i, b });
                          return <li key={i}>{String(b || '')}</li>;
                        }
	                      })}
	                    </ul>
	                  </div>
	                  {SHOW_SWING_STYLE_COMMENT_UI && swingStyleCommentText && (
	                    <p className="text-sm text-slate-300 mt-2 whitespace-pre-line">{swingStyleCommentText}</p>
	                  )}
	                  <div>
	                    <p className="text-xs text-slate-400">アドバイス</p>
	                    <ul className="list-disc pl-4 text-sm space-y-1">
	                      {safeAdvice.map((adv, i) => {
	                        try {
                          const text = attachFrameRange(String(adv || ''), key, sequenceStages, manualPhase);
                          return (
                            <li
                              key={i}
                              className="cursor-pointer hover:text-emerald-200 transition-colors"
                              onClick={() => {
                                try {
                                  const range = getFrameRange(key, sequenceStages, manualPhase);
                                  if (!range) return;
                                  const [start, end] = range;
                                  const arr = Array.from({ length: end - start + 1 }, (_, idx) => start + idx);
                                  setHighlightFrames(arr);
                                } catch (err) {
                                  console.error('[phaseList] error in onClick:', err);
                                }
                              }}
                            >
                              {text}
                            </li>
                          );
                        } catch (err) {
                          console.error('[phaseList] error rendering advice item:', err, { key, i, adv });
                          return <li key={i}>{String(adv || '')}</li>;
                        }
                      })}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        ) : (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <h2 className="text-sm font-semibold">フェーズ別評価</h2>
            {isPhaseReevalLoading && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-900/10 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-100">評価を生成中…</p>
                  <p className="text-[11px] text-emerald-200/90">少し時間がかかる場合があります</p>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full w-full bg-gradient-to-r from-emerald-400 via-emerald-200 to-emerald-400 opacity-70 animate-pulse" />
                </div>
              </div>
            )}
          </section>
        )}

        {userState.hasProAccess &&
          (isPhaseReevalLoading ? (
            <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
              <h2 className="text-sm font-semibold">前回比 改善ポイント / 悪化ポイント</h2>
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
                フェーズ別評価の生成に合わせて比較を作成中…
              </div>
            </section>
          ) : (
            comparison &&
            (comparison.improved.length > 0 || comparison.regressed.length > 0) && (
              <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
                <h2 className="text-sm font-semibold">前回比 改善ポイント / 悪化ポイント</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-lg border border-emerald-700/50 bg-emerald-900/20 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-emerald-300">改善ポイント</p>
                      <span className="text-xs text-emerald-200">{comparison.improved.length} 件</span>
                    </div>
                    {comparison.improved.length > 0 ? (
                      <ul className="list-disc pl-4 text-sm space-y-1 text-emerald-50">
                        {comparison.improved.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-emerald-100">改善点は報告されていません。</p>
                    )}
                  </div>

                  <div className="rounded-lg border border-rose-700/50 bg-rose-900/20 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-rose-200">悪化ポイント</p>
                      <span className="text-xs text-rose-100">{comparison.regressed.length} 件</span>
                    </div>
                    {comparison.regressed.length > 0 ? (
                      <ul className="list-disc pl-4 text-sm space-y-1 text-rose-50">
                        {comparison.regressed.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-rose-100">悪化ポイントは報告されていません。</p>
                    )}
                  </div>
                </div>
              </section>
            )
          ))}

        {!userState.hasProAccess && previousHistory && (
          <section className="rounded-xl bg-slate-900/50 border border-slate-700 p-4 space-y-2 relative">
            <div className="opacity-40">
              <h2 className="text-sm font-semibold">前回比 改善ポイント / 悪化ポイント（PRO）</h2>
              <p className="text-xs text-slate-300 mt-1">比較・推移は PRO で確認できます。</p>
            </div>
            <button
              type="button"
              className="absolute inset-0 rounded-xl"
              aria-label="PRO案内"
              onClick={() => setProModalOpen(true)}
            />
          </section>
        )}

        {(sequenceFrames.length > 0 || sequenceStages.length > 0) && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">オンプレーン診断のみ再解析</h2>
                <p className="text-xs text-slate-400 mt-1">
                  TOP / ダウンスイング / インパクトの選択フレームを使ってオンプレーンのみ更新します。
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!isOnPlaneReevalEnabled}
                onClick={() => void runOnPlaneEvaluation()}
              >
                {isOnPlaneReevalLoading ? "オンプレーン解析中…" : "オンプレーンだけ再解析"}
              </button>
            </div>
            {onPlaneReevalError && <p className="text-xs text-rose-300">オンプレーン再解析エラー: {onPlaneReevalError}</p>}
            {!isOnPlaneReevalEnabled && (
              <p className="text-[11px] text-slate-400">TOP / DS / IMP を選択すると実行できます。</p>
            )}
          </section>
        )}

        <OnPlaneSection
          onPlaneData={onPlaneData}
          isPro={userState.hasProAccess}
          overlayFrames={userState.hasProAccess ? onPlaneOverlayFrames : null}
        />

        <ProUpsellModal
          open={proModalOpen}
          onClose={() => setProModalOpen(false)}
          title="比較・推移はPROで確認できます"
          message="履歴の推移グラフや前回比の比較が利用できます。"
          ctaHref={userState.isAuthenticated ? '/pricing' : `/golf/register?next=${encodeURIComponent('/pricing')}`}
          ctaLabel={userState.isAuthenticated ? 'PROにアップグレード' : '登録してPROを見る'}
        />

        {SHOW_SWING_TYPE_DIAGNOSIS_UI && (
          <>
            {/* あなたのスイングタイプ */}
            <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🧬</span>
                <div>
                  <p className="text-xs text-slate-400">あなたのスイングタイプ</p>
                  <p className="text-sm font-semibold text-slate-100">得意な動きと伸ばしたい方向性</p>
                </div>
              </div>
              {swingTypeBadges.length > 0 ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {swingTypeBadges.map((badge, idx) => (
                      <div
                        key={`${badge.label}-${idx}`}
                        className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className={badge.positive ? "text-emerald-300" : "text-amber-300"}>
                            {badge.positive ? "✔" : "❌"}
                          </span>
                          <span className="text-sm text-slate-100">{badge.label}</span>
                        </div>
                        <div className="text-xs text-slate-300">
                          {typeof badge.confidence === "number" ? `${badge.confidence}%` : badge.value ?? ""}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-slate-400 space-y-1">
                    {swingTypeBadges.map((badge, idx) => (
                      <p key={`reason-${badge.label}-${idx}`}>
                        ・{badge.label}：{badge.reason || "診断内容から推定しました"}
                      </p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-300">タイプを分析しています…</p>
              )}
            </section>

            {/* スイングタイプ（AI判定・型の解説） */}
            <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-lg">🧬</span>
                <div>
                  <p className="text-xs text-slate-400">あなたに向いているスイングタイプ（AI判定）</p>
                  <p className="text-sm font-semibold text-slate-100">型に縛られず、向き・強みをベースに伸ばす提案</p>
                </div>
              </div>
              {isSwingTypeLoading && <p className="text-xs text-slate-400">スイング型を解析中…</p>}
              {swingTypeMatches.length > 0 && bestType && bestTypeDetail && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1">
                    <div className="flex items-center justify-between rounded-lg px-3 py-3 text-left border border-emerald-500/70 bg-emerald-900/30 text-emerald-50">
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold">{bestType.label}</span>
                        <span className="text-[11px] text-emerald-100">{bestType.reason}</span>
                      </div>
                      <span className="flex items-center gap-1 text-xs font-semibold text-emerald-50">
                        <span className="text-[10px] font-medium text-emerald-100/80">適合性</span>
                        <span>{Math.round(bestType.matchScore * 100)}%</span>
                      </span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                    <p className="text-sm font-semibold text-emerald-200">{bestTypeDetail.title}</p>
                    <p className="text-xs text-slate-300">{bestTypeDetail.shortDescription}</p>
                    <p className="text-xs text-slate-300 leading-relaxed">{bestTypeDetail.overview}</p>

                    <div className="text-xs text-slate-300 space-y-1">
                      <p className="font-semibold text-slate-200">【AIの判定理由】</p>
                      <ul className="list-disc pl-4 space-y-1">
                        <li>{bestType?.reason || swingTypeSummary?.reasons?.[0] || '診断結果から推定しました'}</li>
                      </ul>
                      <p className="font-semibold text-slate-200 pt-1">【このタイプの特徴】</p>
                      <ul className="list-disc pl-4 space-y-1">
                        {bestTypeDetail.characteristics.map((line, idx) => (
                          <li key={`ch-${idx}`}>{line}</li>
                        ))}
                      </ul>
                      {bestTypeDetail.recommendedFor?.length ? (
                        <>
                          <p className="font-semibold text-slate-200 pt-1">【向いている人・レベル】</p>
                          <ul className="list-disc pl-4 space-y-1">
                            {bestTypeDetail.recommendedFor.map((line, idx) => (
                              <li key={`rec-${idx}`}>{line}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {bestTypeDetail.advantages?.length ? (
                        <>
                          <p className="font-semibold text-slate-200 pt-1">【メリット】</p>
                          <ul className="list-disc pl-4 space-y-1">
                            {bestTypeDetail.advantages.map((line, idx) => (
                              <li key={`adv-${idx}`}>{line}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {bestTypeDetail.disadvantages?.length ? (
                        <>
                          <p className="font-semibold text-slate-200 pt-1">【注意点】</p>
                          <ul className="list-disc pl-4 space-y-1">
                            {bestTypeDetail.disadvantages.map((line, idx) => (
                              <li key={`dis-${idx}`}>{line}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {bestTypeDetail.commonMistakes?.length ? (
                        <>
                          <p className="font-semibold text-slate-200 pt-1">【よくある誤解・失敗】</p>
                          <ul className="list-disc pl-4 space-y-1">
                            {bestTypeDetail.commonMistakes.map((line, idx) => (
                              <li key={`mis-${idx}`}>{line}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const params = new URLSearchParams();
                      if (bestTypeDetail?.title) params.set('swingType', bestTypeDetail.title);
                      if (data?.analysisId) params.set('analysisId', data.analysisId);
                      const query = params.toString();
                      router.push(`/coach${query ? `?${query}` : ''}`);
                    }}
                    className="w-full rounded-lg border border-emerald-500/50 bg-emerald-900/30 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/50 transition-colors"
                  >
                    👉 このスイングを磨くためにAIコーチに相談する
                  </button>
                </div>
              )}
              {!swingTypeMatches.length && !isSwingTypeLoading && (
                <p className="text-sm text-slate-300">スイングタイプを分析しています…</p>
              )}
            </section>

            {alternativeTypes.length > 0 && swingTypeLLM?.swingTypeDetails && (
              <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
                <p className="text-sm font-semibold">ほかに進められるスイング型</p>
                <div className="space-y-2">
                  {alternativeTypes.map((match, idx) => {
                    const detail =
                      swingTypeLLM.swingTypeDetails[match.type] ||
                      {
                        title: match.label,
                        shortDescription: match.reason,
                        overview: swingTypeSummary?.reasons?.join('。') ?? match.reason,
                        characteristics: [],
                        recommendedFor: [],
                        advantages: [],
                        disadvantages: [],
                        commonMistakes: [],
                        cta: bestTypeDetail?.cta || {
                          headline: 'このスイングを目指したい方へ',
                          message:
                            'このスイング型を自分に合った形で身につけるには、自己流ではなく客観的なチェックが重要です。AIコーチなら、あなたのスイング動画をもとに、この型に近づくための具体的な改善ポイントを段階的にアドバイスできます。',
                          buttonText: 'この型を目標にAIコーチに相談する',
                        },
                      };
                    const isOpen = expandedAlt === match.type;
                    const reasonText =
                      match.reason && /記述/.test(match.reason)
                        ? detail.shortDescription || 'この型の動きがマッチするため'
                        : match.reason || detail.shortDescription || 'この型の動きがマッチするため';
                    return (
                      <div key={`${match.type}-${idx}`} className="rounded-lg border border-slate-800 bg-slate-950/60">
                        <button
                          type="button"
                          onClick={() => setExpandedAlt(isOpen ? null : match.type)}
                          className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                            isOpen ? 'bg-slate-900/70 border-b border-emerald-500/40' : 'hover:border-emerald-400/50'
                          }`}
                        >
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                              <span>{match.label}</span>
                              <span className="text-[10px] text-slate-400">{isOpen ? '▲' : '▼'}</span>
                            </span>
                            <span className="text-[11px] text-slate-400">{reasonText}</span>
                          </div>
                          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-200">
                            <span className="text-[10px] font-medium text-slate-400">適合性</span>
                            <span>{Math.round(match.matchScore * 100)}%</span>
                          </span>
                        </button>
                        {isOpen && detail && (
                          <div className="border-t border-slate-800 px-3 py-3 space-y-2 animate-accordion">
                            <p className="text-sm font-semibold text-emerald-200">{detail.title}</p>
                            <p className="text-xs text-slate-300">{detail.shortDescription}</p>
                        <p className="text-xs text-slate-300 leading-relaxed">{detail.overview}</p>
                        <div className="text-xs text-slate-300 space-y-1">
                          <AccordionSection title="【このタイプの特徴】" items={detail.characteristics} />
                          <AccordionSection title="【向いている人・レベル】" items={detail.recommendedFor} />
                          <AccordionSection title="【メリット】" items={detail.advantages} />
                          <AccordionSection title="【注意点】" items={detail.disadvantages} />
                          <AccordionSection title="【よくある誤解・失敗】" items={detail.commonMistakes} />
                        </div>
                        <button
                          onClick={() => {
                            const params = new URLSearchParams();
                            if (detail?.title) params.set('swingType', detail.title);
                            if (data?.analysisId) params.set('analysisId', data.analysisId);
                            const query = params.toString();
                            router.push(`/coach${query ? `?${query}` : ''}`);
                          }}
                          className="w-full rounded-lg border border-emerald-500/50 bg-emerald-900/30 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/50 transition-colors"
                        >
                          👉 このスイングを磨くためにAIコーチに相談する
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
          </>
        )}
          </>
        )}
      </div>
    </main>
  );
};

const AccordionSection = ({ title, items }: { title: string; items?: string[] }) => {
  if (!items || !items.length) return null;
  return (
    <div className="space-y-1">
      <p className="font-semibold text-slate-200">{title}</p>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((line, idx) => (
          <li key={`${title}-${idx}`} className="text-slate-300">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default GolfResultPage;
