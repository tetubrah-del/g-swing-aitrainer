'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { buildCoachContext } from '@/app/coach/utils/context';
import { saveBootstrapContext } from '@/app/coach/utils/storage';
import { useMeUserState } from '@/app/golf/hooks/useMeUserState';
import { clearPhaseOverride, loadPhaseOverride, togglePhaseOverride } from '@/app/golf/utils/phaseOverrideStorage';
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
  manual?: { backswing?: number[]; top?: number[]; downswing?: number[]; impact?: number[] }
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
  const [manualPhase, setManualPhase] = useState<{ backswing?: number[]; top?: number[]; downswing?: number[]; impact?: number[] }>({});
  const [isPhaseReevalLoading, setIsPhaseReevalLoading] = useState(false);
  const [phaseReevalError, setPhaseReevalError] = useState<string | null>(null);
  const [phaseOverrideAppliedSig, setPhaseOverrideAppliedSig] = useState<string | null>(null);
  const [anonymousUserId, setAnonymousUserId] = useState<string | null>(null);
  const [previousHistory, setPreviousHistory] = useState<SwingAnalysisHistory | null>(null);
  const [hasSavedHistory, setHasSavedHistory] = useState(false);
  const [hasSeededCoachContext, setHasSeededCoachContext] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [proModalOpen, setProModalOpen] = useState(false);

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
        let resolved = json;

        if (typeof window !== 'undefined') {
          const stored = getReportById(id);
          if (stored?.result) {
            resolved = stored;
            setFallbackNote(null);
          }
          // API 取得が成功したらローカルにも保存して次回以降同一IDを参照
          saveReport(json);
        }

        setData(resolved);
        if (resolved.result) {
          setSwingTypes(deriveSwingTypes(resolved.result));
          setSwingTypeResult(deriveSwingTypeResult(resolved.result));
        }
        if (resolved.causalImpact) {
          setCausalImpact(resolved.causalImpact);
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
    setPreviousHistory(pickPreviousHistory(ownerId, data.analysisId, currentResultCreatedAtTs));
  }, [anonymousUserId, currentResultCreatedAtTs, data?.analysisId, userState.userId]);

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
    const score = data?.result?.totalScore ?? 0;
    if (score >= 85)
      return {
        label: '上級',
        detail:
          '全体の完成度が高く、動きの再現性が高いスイングです。良い点は、切り返し以降の体幹の回転が途切れにくく、インパクトでの当たり負けが少ないことです。一方で、わずかなフェース向きのズレやリリースのタイミング差が球筋に出やすく、弾道のばらつき要因になりやすい傾向があります。',
      };
    if (score >= 70)
      return {
        label: '中上級',
        detail:
          '全体のバランスが良く、スイングの形が崩れにくいタイプです。良い点は、トップ〜ダウンの動きが比較的スムーズで、ミート率につながる“体とクラブの同調”が見えやすいことです。課題は、切り返し付近でクラブの落ち方／フェース向きが一定になりきらず、方向性のブレが残りやすい点です。',
      };
    if (score >= 55)
      return {
        label: '中級',
        detail:
          '基本動作は安定しており、スイングの形としては十分にまとまっています。良い点は、アドレス〜トップまでの流れが大きく破綻せず、振り抜きまでのリズムが作れていることです。課題は、毎回の重心位置やトップ位置にわずかな差が出やすく、その影響が切り返し以降のクラブ軌道／フェース向きのばらつきとして現れやすい点です。',
      };
    if (score >= 40)
      return {
        label: '初級',
        detail:
          'スイングは成立しており、形の方向性も見えています。良い点は、フィニッシュまで振り切ろうとする意識があり、動作が途中で止まりにくいことです。課題は、アドレスの姿勢（前傾・重心）やグリップの一定感が揺れやすく、インパクトで当たり所とフェース向きが安定しにくい点です。',
      };
    return {
      label: 'ビギナー',
      detail:
        'スイングの骨格を作っている段階で、動きの再現性はこれから伸びるタイプです。良い点は、クラブを振る動作自体はできており、改善に必要な“基準の形”を作れる余地が大きいことです。課題は、アドレス姿勢とテンポが毎回変わりやすく、トップ位置やインパクトの当たり所が揃いにくい点です。',
    };
  }, [data?.result?.totalScore]);

  const fallbackRoundEstimates = useMemo<RoundEstimateMetrics>(() => {
    const totalScore = data?.result?.totalScore ?? 0;
    // 少し厳しめに換算して、実力より甘く出ないよう調整
    const mid = Math.round(105 - totalScore * 0.28); // スコアが高いほどストロークは小さい想定
    const spread = 3;
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const low = clamp(mid - spread, 60, 115);
    const high = clamp(mid + spread, 60, 115);

    // 簡易推定（少し厳しめ）
    const fwKeep = clamp(50 + totalScore * 0.18, 40, 75); // フェアウェイキープ率
    const gir = clamp(32 + totalScore * 0.18, 25, 65); // パーオン率
    const ob = clamp(3.2 - totalScore * 0.012, 0.5, 4); // 推定OB数/18H

    return {
      strokeRange: `${low}〜${high}`,
      fwKeep: `${fwKeep.toFixed(0)}%`,
      gir: `${gir.toFixed(0)}%`,
      ob: `${ob.toFixed(1)} 回`,
    };
  }, [data?.result?.totalScore]);

  const [roundEstimates, setRoundEstimates] = useState<RoundEstimateMetrics>(fallbackRoundEstimates);

  useEffect(() => {
    setRoundEstimates(fallbackRoundEstimates);
    if (!data?.result) return;

    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch('/api/golf/round-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            totalScore: data.result.totalScore,
            phases: data.result.phases,
            meta: data.meta,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'round-estimate failed');
        }

        const json = (await res.json()) as Partial<{
          strokeRange: string;
          fwKeep: string;
          gir: string;
          ob: string;
        }>;

        if (cancelled) return;
        setRoundEstimates({
          strokeRange: typeof json.strokeRange === 'string' ? json.strokeRange : fallbackRoundEstimates.strokeRange,
          fwKeep: typeof json.fwKeep === 'string' ? json.fwKeep : fallbackRoundEstimates.fwKeep,
          gir: typeof json.gir === 'string' ? json.gir : fallbackRoundEstimates.gir,
          ob: typeof json.ob === 'string' ? json.ob : fallbackRoundEstimates.ob,
        });
      } catch (err) {
        console.warn('[round-estimate fetch failed]', err);
        if (!cancelled) setRoundEstimates(fallbackRoundEstimates);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [data?.result, data?.meta, fallbackRoundEstimates]);

  useEffect(() => {
    if (!data?.result) return;
    if (data.causalImpact) {
      setCausalImpact(data.causalImpact);
      setIsCausalLoading(false);
      return;
    }

    let cancelled = false;
    const localFallback = buildLocalCausalImpact(data.result, roundEstimates);

    const run = async () => {
      try {
        setIsCausalLoading(true);
        const res = await fetch('/api/golf/causal-explanation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysisId: data.analysisId,
            totalScore: data.result.totalScore,
            phases: data.result.phases,
            summary: data.result.summary,
            meta: data.meta,
            roundEstimates,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'causal-explanation failed');
        }

        const json = (await res.json()) as Partial<{ causalImpact: CausalImpactExplanation }>;
        if (cancelled) return;
        setCausalImpact(json.causalImpact ?? localFallback);
        setSwingTypeResult(deriveSwingTypeResult(data.result, json.causalImpact ?? localFallback));
      } catch (err) {
        console.warn('[causal-explanation fetch failed]', err);
        if (!cancelled) {
          setCausalImpact(localFallback);
          setSwingTypeResult(deriveSwingTypeResult(data.result, localFallback));
        }
      } finally {
        if (!cancelled) setIsCausalLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [data?.analysisId, data?.result, data?.meta, data?.causalImpact, roundEstimates]);

  useEffect(() => {
    if (!data?.result) return;
    let cancelled = false;
    const run = async () => {
      try {
        setIsSwingTypeLoading(true);
        const res = await fetch('/api/golf/swing-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysis: data.result,
            meta: data.meta,
            causalImpact,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'swing-type failed');
        }
        const json = (await res.json()) as SwingTypeLLMResult;
        if (cancelled) return;
        setSwingTypeLLM(json);
        setSelectedSwingType(json.swingTypeMatch?.[0]?.type ?? null);
      } catch (err) {
        console.warn('[swing-type fetch failed]', err);
      } finally {
        if (!cancelled) setIsSwingTypeLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [data?.result, data?.meta, causalImpact]);

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
    setPreviousHistory(pickPreviousHistory(ownerId, history.analysisId, new Date(history.createdAt).getTime()));
    setHasSavedHistory(true);
  }, [
    anonymousUserId,
    userState.userId,
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
    setManualPhase({ backswing: stored.backswing, top: stored.top, downswing: stored.downswing, impact: stored.impact });
  }, [data?.analysisId]);

  const phaseOverrideSig = useMemo(() => {
    const bs = (manualPhase.backswing ?? []).join(",");
    const top = (manualPhase.top ?? []).join(",");
    const ds = (manualPhase.downswing ?? []).join(",");
    const imp = (manualPhase.impact ?? []).join(",");
    if (!bs && !top && !ds && !imp) return "";
    return `bs:${bs}|top:${top}|ds:${ds}|imp:${imp}`;
  }, [manualPhase.backswing, manualPhase.downswing, manualPhase.impact, manualPhase.top]);

  useEffect(() => {
    if (!data?.analysisId || typeof window === "undefined") return;
    const key = `golf_phase_override_applied_${data.analysisId}`;
    setPhaseOverrideAppliedSig(window.localStorage.getItem(key));
  }, [data?.analysisId]);

  const runPhaseReeval = async () => {
    if (!data?.analysisId) return;
    const backswing = manualPhase.backswing ?? [];
    const top = manualPhase.top ?? [];
    const downswing = manualPhase.downswing ?? [];
    const impact = manualPhase.impact ?? [];
    if (!backswing.length && !top.length && !downswing.length && !impact.length) return;

    try {
      setIsPhaseReevalLoading(true);
      setPhaseReevalError(null);
      const res = await fetch("/api/golf/reanalyze-phases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId: data.analysisId, backswing, top, downswing, impact }),
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "再評価に失敗しました";
      setPhaseReevalError(message);
    } finally {
      setIsPhaseReevalLoading(false);
    }
  };

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
  const sequenceFrames = result.sequence?.frames ?? [];
  const sequenceStages = (result.sequence?.stages ?? []) as SequenceStageFeedback[];
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
  const autoBackswingRange = getFrameRange('backswing', sequenceStages, undefined);
  const autoTopRange = getFrameRange('top', sequenceStages, undefined);
  const showAutoPhaseWarning =
    sequenceFrames.length > 0 &&
    (!manualPhase.backswing?.length || !manualPhase.top?.length) &&
    ((autoBackswingRange != null && (autoBackswingRange[0] === 1 || autoBackswingRange[1] - autoBackswingRange[0] >= 3)) ||
      (autoTopRange != null && (autoTopRange[0] === 1 || autoTopRange[1] - autoTopRange[0] >= 3)));

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
          <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 sm:col-span-2">
            <p className="text-xs text-slate-400">推定レベル診断</p>
            <p className="text-xl font-semibold mt-1">{levelEstimate.label}</p>
            <p className="text-sm text-slate-300 mt-1">{levelEstimate.detail}</p>
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
          {typeof result.swingStyleComment === "string" && result.swingStyleComment.trim().length > 0 && (
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

        {/* 推定ラウンドスコア＆推奨ドリル */}
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

        {/* スイングタイプ */}
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
                      <span className={badge.positive ? 'text-emerald-300' : 'text-amber-300'}>
                        {badge.positive ? '✔' : '❌'}
                      </span>
                      <span className="text-sm text-slate-100">{badge.label}</span>
                    </div>
                    <div className="text-xs text-slate-300">
                      {typeof badge.confidence === 'number' ? `${badge.confidence}%` : badge.value ?? ''}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-400 space-y-1">
                {swingTypeBadges.map((badge, idx) => (
                  <p key={`reason-${badge.label}-${idx}`}>
                    ・{badge.label}：{badge.reason || '診断内容から推定しました'}
                  </p>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-300">タイプを分析しています…</p>
          )}
        </section>

        {(sequenceFrames.length > 0 || sequenceStages.length > 0) && (
          <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">連続フレーム診断</h2>
                <p className="text-xs text-slate-400">抽出された14〜16フレームをそのまま診断に使用しています。</p>
              </div>
              <span className="text-xs text-slate-300">
                {sequenceFrames.length ? `${sequenceFrames.length}枚のフレーム` : 'ステージコメントのみ'}
              </span>
            </div>

            <div
              id="manual-phase-selector"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300"
            >
              <span className="text-slate-400">手動指定:</span>
              <span className="text-violet-200">
                バックスイング{' '}
                {manualPhase.backswing?.length ? manualPhase.backswing.map((v) => `#${v}`).join(' / ') : '未設定'}
              </span>
              <span className="text-amber-200">
                トップ {manualPhase.top?.length ? manualPhase.top.map((v) => `#${v}`).join(' / ') : '未設定'}
              </span>
              <span className="text-sky-200">
                ダウンスイング{' '}
                {manualPhase.downswing?.length ? manualPhase.downswing.map((v) => `#${v}`).join(' / ') : '未設定'}
              </span>
              <span className="text-rose-200">
                インパクト {manualPhase.impact?.length ? manualPhase.impact.map((v) => `#${v}`).join(' / ') : '未設定'}
              </span>
              <button
                type="button"
                disabled={
                  isPhaseReevalLoading ||
                  (!manualPhase.backswing?.length &&
                    !manualPhase.top?.length &&
                    !manualPhase.downswing?.length &&
                    !manualPhase.impact?.length)
                }
                className="rounded-md border border-emerald-700/50 bg-emerald-950/25 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-900/30 disabled:opacity-60"
                onClick={() => void runPhaseReeval()}
                title="手動指定したフレームを使って、フェーズ評価コメントを再計算します"
              >
                {isPhaseReevalLoading ? '再評価中…' : 'この指定で再評価'}
              </button>
              <button
                type="button"
                className="ml-auto rounded-md border border-slate-700 bg-slate-900/40 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-900/70"
                onClick={() => {
                  if (!data?.analysisId) return;
                  clearPhaseOverride(data.analysisId);
                  setManualPhase({});
                  if (typeof window !== "undefined") {
                    window.localStorage.removeItem(`golf_phase_override_applied_${data.analysisId}`);
                  }
                  setPhaseOverrideAppliedSig(null);
                }}
              >
                リセット
              </button>
            </div>
            {phaseReevalError && <p className="text-xs text-rose-300">再評価エラー: {phaseReevalError}</p>}
            {showAutoPhaseWarning && (
              <p className="text-xs text-amber-200">
                バックスイング/トップの抽出がズレている可能性があります（自動目安: BS {autoBackswingRange ? `#${autoBackswingRange[0]}〜#${autoBackswingRange[1]}` : 'N/A'} / TOP {autoTopRange ? `#${autoTopRange[0]}〜#${autoTopRange[1]}` : 'N/A'}）。必要ならBS/TOPも手動指定して再評価してください。
              </p>
            )}

            {sequenceFrames.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sequenceFrames.map((frame, idx) => {
                  const frameNumber = idx + 1;
                  const highlighted = highlightFrames.includes(frameNumber);
                  const isManualBackswing = manualPhase.backswing?.includes(frameNumber) ?? false;
                  const isManualTop = manualPhase.top?.includes(frameNumber) ?? false;
                  const isManualDownswing = manualPhase.downswing?.includes(frameNumber) ?? false;
                  const isManualImpact = manualPhase.impact?.includes(frameNumber) ?? false;
                  return (
                    <div
                      key={`${frame.url}-${idx}`}
                      id={`sequence-frame-${frameNumber}`}
                      className={`rounded-lg p-2 space-y-2 transition-all ${
                        highlighted
                          ? 'border-emerald-400 bg-slate-900/60 shadow-[0_0_0_2px_rgba(16,185,129,0.3)]'
                          : 'border border-slate-800 bg-slate-950/50'
                      }`}
                    >
                    <div className="flex items-center justify-between text-xs text-slate-300 gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold ${highlighted ? 'text-emerald-200' : ''}`}>#{frameNumber}</span>
                        {isManualDownswing && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] border border-sky-500/60 text-sky-200 bg-sky-900/20">
                            DS
                          </span>
                        )}
                        {isManualImpact && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] border border-rose-500/60 text-rose-200 bg-rose-900/20">
                            IMP
                          </span>
                        )}
                        {isManualBackswing && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] border border-violet-500/60 text-violet-200 bg-violet-900/20">
                            BS
                          </span>
                        )}
                        {isManualTop && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] border border-amber-500/60 text-amber-200 bg-amber-900/20">
                            TOP
                          </span>
                        )}
                      </div>
                      {typeof frame.timestampSec === 'number' && <span>{frame.timestampSec.toFixed(2)}s</span>}
                    </div>
                    <div
                      className={`aspect-video w-full overflow-hidden rounded-md bg-slate-900 ${
                        isManualImpact
                          ? 'border border-rose-500'
                          : isManualDownswing
                            ? 'border border-sky-500'
                            : highlighted
                              ? 'border border-emerald-400'
                              : 'border border-slate-800'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={frame.url}
                        alt={`sequence-frame-${frameNumber}`}
                        className="h-full w-full object-contain bg-slate-950"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="rounded-md border border-sky-600/50 bg-sky-950/40 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-900/30"
                        onClick={() => {
                          if (!data?.analysisId) return;
                          const next = togglePhaseOverride(data.analysisId, { downswing: frameNumber });
                          setManualPhase({ backswing: next?.backswing, top: next?.top, downswing: next?.downswing, impact: next?.impact });
                        }}
                      >
                        {isManualDownswing ? 'ダウンスイング解除' : 'ダウンスイングにする'}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-rose-600/50 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-900/30"
                        onClick={() => {
                          if (!data?.analysisId) return;
                          const next = togglePhaseOverride(data.analysisId, { impact: frameNumber });
                          setManualPhase({ backswing: next?.backswing, top: next?.top, downswing: next?.downswing, impact: next?.impact });
                        }}
                      >
                        {isManualImpact ? 'インパクト解除' : 'インパクトにする'}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-violet-600/50 bg-violet-950/40 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-900/30"
                        onClick={() => {
                          if (!data?.analysisId) return;
                          const next = togglePhaseOverride(data.analysisId, { backswing: frameNumber });
                          setManualPhase({ backswing: next?.backswing, top: next?.top, downswing: next?.downswing, impact: next?.impact });
                        }}
                      >
                        {isManualBackswing ? 'BS解除' : 'バックスイングにする'}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-amber-600/50 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-900/30"
                        onClick={() => {
                          if (!data?.analysisId) return;
                          const next = togglePhaseOverride(data.analysisId, { top: frameNumber });
                          setManualPhase({ backswing: next?.backswing, top: next?.top, downswing: next?.downswing, impact: next?.impact });
                        }}
                      >
                        {isManualTop ? 'TOP解除' : 'トップにする'}
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}

          </section>
        )}

        {userState.hasProAccess && comparison && (comparison.improved.length > 0 || comparison.regressed.length > 0) && (
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
        )}

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

        <ProUpsellModal
          open={proModalOpen}
          onClose={() => setProModalOpen(false)}
          title="比較・推移はPROで確認できます"
          message="履歴の推移グラフや前回比の比較が利用できます。"
          ctaHref={userState.isAuthenticated ? '/pricing' : `/golf/register?next=${encodeURIComponent('/pricing')}`}
          ctaLabel={userState.isAuthenticated ? 'PROにアップグレード' : '登録してPROを見る'}
        />

        {/* フェーズごとの評価 */}
        {shouldShowPhaseEvaluation ? (
        <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-4">
          <h2 className="text-sm font-semibold">フェーズ別評価</h2>
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
	                  {swingStyleCommentText && (
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
            <p className="text-sm text-slate-300">
              ダウンスイングとインパクトを「連続フレーム診断」で手動指定して、「この指定で再評価」を押すと表示されます。
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded-md border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-100 hover:bg-slate-900/70"
                onClick={() => {
                  const el = typeof document !== 'undefined' ? document.getElementById('manual-phase-selector') : null;
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >
                手動指定へ移動
              </button>
            </div>
          </section>
        )}

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
                  <span className="text-xs font-semibold text-emerald-50">{Math.round(bestType.matchScore * 100)}%</span>
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
                      <span className="text-xs font-semibold text-emerald-200">{Math.round(match.matchScore * 100)}%</span>
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
