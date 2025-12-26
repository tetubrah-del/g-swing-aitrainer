'use client';

import { useEffect, useMemo, useState } from 'react';

export type Phase = 'AD' | 'BS' | 'TOP' | 'DS' | 'IMP' | 'FIN';

export type PhaseSelection = {
  phase: Phase;
  frames: number[]; // 昇順
};

export type ConfirmedSelections = Record<Phase, number[]>;

export type SelectorFrame = {
  index: number; // 1-based
  imageUrl: string;
  timestampSec?: number;
};

// UX flow: アドレス → バックスイング → トップ → ダウンスイング → インパクト → フィニッシュ
const PHASE_ORDER: Phase[] = ['AD', 'BS', 'TOP', 'DS', 'IMP', 'FIN'];

const phaseLabelJa = (phase: Phase) => {
  switch (phase) {
    case 'AD':
      return 'アドレス';
    case 'BS':
      return 'バックスイング';
    case 'TOP':
      return 'トップ';
    case 'DS':
      return 'ダウンスイング';
    case 'IMP':
      return 'インパクト';
    case 'FIN':
      return 'フィニッシュ';
  }
};

const phaseTag = (phase: Phase) => {
  switch (phase) {
    case 'AD':
      return 'アド';
    case 'BS':
      return 'バック';
    case 'TOP':
      return 'トップ';
    case 'DS':
      return 'ダウン';
    case 'IMP':
      return 'インパ';
    case 'FIN':
      return 'フィニ';
  }
};

const phaseColor = (phase: Phase) => {
  switch (phase) {
    case 'AD':
      return {
        border: 'border-emerald-400/80',
        borderStrong: 'border-emerald-300',
        bg: 'bg-emerald-500/12',
        tag: 'border-emerald-500/60 text-emerald-100 bg-emerald-950/40',
        text: 'text-emerald-100',
      };
    case 'BS':
      return {
        border: 'border-violet-400/80',
        borderStrong: 'border-violet-300',
        bg: 'bg-violet-500/12',
        tag: 'border-violet-500/60 text-violet-100 bg-violet-950/40',
        text: 'text-violet-100',
      };
    case 'TOP':
      return {
        border: 'border-amber-400/80',
        borderStrong: 'border-amber-300',
        bg: 'bg-amber-500/12',
        tag: 'border-amber-500/60 text-amber-100 bg-amber-950/40',
        text: 'text-amber-100',
      };
    case 'DS':
      return {
        border: 'border-sky-400/80',
        borderStrong: 'border-sky-300',
        bg: 'bg-sky-500/12',
        tag: 'border-sky-500/60 text-sky-100 bg-sky-950/40',
        text: 'text-sky-100',
      };
    case 'IMP':
      return {
        border: 'border-rose-400/80',
        borderStrong: 'border-rose-300',
        bg: 'bg-rose-500/12',
        tag: 'border-rose-500/60 text-rose-100 bg-rose-950/40',
        text: 'text-rose-100',
      };
    case 'FIN':
      return {
        border: 'border-fuchsia-400/80',
        borderStrong: 'border-fuchsia-300',
        bg: 'bg-fuchsia-500/12',
        tag: 'border-fuchsia-500/60 text-fuchsia-100 bg-fuchsia-950/40',
        text: 'text-fuchsia-100',
      };
  }
};

const formatFrameRange = (frames: number[]) => {
  if (!frames.length) return '';
  const sorted = [...frames].sort((a, b) => a - b);
  const start = sorted[0]!;
  const end = sorted[sorted.length - 1]!;
  if (sorted.length === 1) return `#${start}`;
  // 2枚で離れている場合は「#a/#b」で誤解を減らす
  if (sorted.length === 2 && end - start >= 2) return `#${start}/#${end}`;
  return `#${start}–#${end}`;
};

const normalizeFrames = (frames: number[]) => Array.from(new Set(frames)).sort((a, b) => a - b);

const constraintsFor = (phase: Phase) => {
  // 1枚即確定
  if (phase === 'AD' || phase === 'BS' || phase === 'TOP' || phase === 'IMP' || phase === 'FIN') return { min: 1, max: 1, instant: true };
  // DS: 固定2枚（範囲指定ではなく2点選択）
  return { min: 2, max: 2, instant: false };
};

const nextPhase = (phase: Phase) => {
  const idx = PHASE_ORDER.indexOf(phase);
  return PHASE_ORDER[Math.min(idx + 1, PHASE_ORDER.length - 1)] ?? 'FIN';
};

const pickNextIncomplete = (confirmedSelections: ConfirmedSelections, fallback: Phase) => {
  const found = PHASE_ORDER.find((p) => (confirmedSelections[p] ?? []).length === 0);
  return found ?? fallback;
};

type PhaseStepperProps = {
  activePhase: Phase;
  confirmedSelections: ConfirmedSelections;
  onChange: (next: Phase) => void;
};

export function PhaseStepper({ activePhase, confirmedSelections, onChange }: PhaseStepperProps) {
  const items = useMemo(() => {
    return PHASE_ORDER.map((phase) => {
      const assigned = confirmedSelections[phase] ?? [];
      const statusText = assigned.length ? `✓ ${formatFrameRange(assigned)}` : '未';
      return { phase, statusText };
    });
  }, [confirmedSelections]);

  return (
    <div className="sticky top-0 z-30 -mx-4 bg-slate-950/85 px-4 py-2 backdrop-blur">
      <div className="grid grid-cols-2 gap-2">
        {items.map(({ phase, statusText }) => {
          const selected = phase === activePhase;
          const c = phaseColor(phase);
          return (
            <button
              key={phase}
              type="button"
              onClick={() => onChange(phase)}
              className={[
                'flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors',
                selected ? `border-2 ${c.borderStrong} ${c.bg}` : `border ${c.border} bg-slate-900/30`,
              ].join(' ')}
            >
              <span className={['font-semibold tracking-wide', selected ? c.text : 'text-slate-100'].join(' ')}>
                {phaseLabelJa(phase)}
              </span>
              <span className={['tabular-nums', assignedTone(statusText)].join(' ')}>{statusText}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const assignedTone = (statusText: string) => {
  if (statusText === '未') return 'text-slate-400';
  return 'text-slate-200';
};

type FrameCardProps = {
  frame: SelectorFrame;
  highlighted: boolean;
  activePhase: Phase;
  tempSelectedFrames: number[];
  confirmedSelections: ConfirmedSelections;
  onTap: (index: number) => void;
};

export function FrameCard({
  frame,
  highlighted,
  activePhase,
  tempSelectedFrames,
  confirmedSelections,
  onTap,
}: FrameCardProps) {
  const isTempSelected = tempSelectedFrames.includes(frame.index);
  const confirmedPhases = useMemo(() => {
    return PHASE_ORDER.filter((p) => (confirmedSelections[p] ?? []).includes(frame.index));
  }, [confirmedSelections, frame.index]);

  const primaryPhase = isTempSelected ? activePhase : confirmedPhases[0] ?? null;
  const c = primaryPhase ? phaseColor(primaryPhase) : null;

  const frameTone = (() => {
    if (highlighted) return 'border-emerald-400/70 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]';
    if (isTempSelected) return `border-2 ${phaseColor(activePhase).borderStrong} ${phaseColor(activePhase).bg}`;
    if (c) return `border-2 ${c.borderStrong} ${c.bg}`;
    return 'border border-slate-800';
  })();

  return (
    <button
      type="button"
      id={`sequence-frame-${frame.index}`}
      onClick={() => onTap(frame.index)}
      className={[
        'group relative overflow-hidden rounded-xl bg-slate-950/40',
        frameTone,
      ].join(' ')}
    >
      <div className="relative aspect-video w-full bg-slate-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={frame.imageUrl} alt={`frame-${frame.index}`} className="h-full w-full object-contain bg-slate-950" />
        <div className="absolute left-1 top-1 flex flex-wrap items-center gap-1">
          {isTempSelected ? (
            <span className={['rounded border px-1.5 py-0.5 text-[10px]', phaseColor(activePhase).tag].join(' ')}>
              {phaseTag(activePhase)}
            </span>
          ) : null}
          {!isTempSelected
            ? confirmedPhases.slice(0, 2).map((p) => (
                <span key={p} className={['rounded border px-1.5 py-0.5 text-[10px]', phaseColor(p).tag].join(' ')}>
                  {phaseTag(p)}
                </span>
              ))
            : null}
        </div>
        <div className="absolute right-1 top-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-200">
          #{frame.index}
        </div>
      </div>
      <div className="flex items-center justify-between px-2 py-1.5 text-[11px] text-slate-400">
        <span className={isTempSelected ? 'text-slate-100' : 'text-slate-400'}>{isTempSelected ? '選択中' : 'タップで選択'}</span>
        {typeof frame.timestampSec === 'number' ? <span className="tabular-nums">{frame.timestampSec.toFixed(2)}s</span> : null}
      </div>
    </button>
  );
}

type FrameGridProps = {
  frames: SelectorFrame[];
  highlightedFrames: number[];
  activePhase: Phase;
  tempSelectedFrames: number[];
  confirmedSelections: ConfirmedSelections;
  onTapFrame: (index: number) => void;
};

export function FrameGrid({
  frames,
  highlightedFrames,
  activePhase,
  tempSelectedFrames,
  confirmedSelections,
  onTapFrame,
}: FrameGridProps) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {frames.map((f) => (
        <FrameCard
          key={f.index}
          frame={f}
          highlighted={highlightedFrames.includes(f.index)}
          activePhase={activePhase}
          tempSelectedFrames={tempSelectedFrames}
          confirmedSelections={confirmedSelections}
          onTap={onTapFrame}
        />
      ))}
    </div>
  );
}

type BottomActionBarProps = {
  activePhase: Phase;
  tempSelectedFrames: number[];
  isConfirmEnabled: boolean;
  confirmLabel: string;
  errorText?: string | null;
  onConfirm: () => void;
  onClearTemp: () => void;
  onReevaluate: () => void;
  onResetAll: () => void;
  isReevaluating: boolean;
  isReevaluateEnabled: boolean;
};

export function BottomActionBar({
  activePhase,
  tempSelectedFrames,
  isConfirmEnabled,
  confirmLabel,
  errorText,
  onConfirm,
  onClearTemp,
  onReevaluate,
  onResetAll,
  isReevaluating,
  isReevaluateEnabled,
}: BottomActionBarProps) {
  const hasTemp = tempSelectedFrames.length > 0;
  if (!hasTemp && !isReevaluateEnabled) return null;

  const barLabel = hasTemp ? confirmLabel : 'フレームをリセットして再評価する';

  return (
    <div className="mt-3">
      <div className="w-full rounded-2xl border border-slate-800 bg-slate-950/95 p-3 shadow-lg shadow-black/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">{barLabel}</p>
            {errorText ? <p className="mt-1 text-[11px] text-rose-200">{errorText}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasTemp ? (
              <>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={!isConfirmEnabled}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                >
                  設定する
                </button>
                <button
                  type="button"
                  onClick={onClearTemp}
                  className="rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-2 text-sm text-slate-100"
                >
                  クリア
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onResetAll}
                  className="rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-2 text-sm text-slate-100"
                >
                  リセット
                </button>
                <button
                  type="button"
                  onClick={onReevaluate}
                  disabled={!isReevaluateEnabled || isReevaluating}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                >
                  {isReevaluating ? '再評価中…' : '再評価'}
                </button>
              </>
            )}
          </div>
        </div>
        {hasTemp ? (
          <div className="mt-2 text-[11px] text-slate-400">
            2タップで範囲指定（{phaseLabelJa(activePhase)}）
          </div>
        ) : null}
      </div>
    </div>
  );
}

type PhaseFrameSelectorProps = {
  frames: SelectorFrame[];
  initialConfirmedSelections: ConfirmedSelections;
  syncKey?: string;
  highlightedFrames?: number[];
  isReevaluating: boolean;
  isReevaluateEnabled: boolean;
  onConfirmedSelectionsChange: (next: ConfirmedSelections) => void;
  onReevaluate: () => void;
  onResetAll: () => void;
};

export default function PhaseFrameSelector({
  frames,
  initialConfirmedSelections,
  syncKey,
  highlightedFrames,
  isReevaluating,
  isReevaluateEnabled,
  onConfirmedSelectionsChange,
  onReevaluate,
  onResetAll,
}: PhaseFrameSelectorProps) {
  const [activePhase, setActivePhase] = useState<Phase>('AD');
  const [tempSelectedFrames, setTempSelectedFrames] = useState<number[]>([]);
  const [confirmedSelections, setConfirmedSelections] = useState<ConfirmedSelections>(initialConfirmedSelections);

  useEffect(() => {
    setConfirmedSelections(initialConfirmedSelections);
    setTempSelectedFrames([]);
    setActivePhase((prev) => pickNextIncomplete(initialConfirmedSelections, prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  const req = constraintsFor(activePhase);

  const guideText =
    req.min === 1 && req.max === 1
      ? 'フレームを 1枚 選んでください'
      : req.min === 2 && req.max === 2
        ? 'フレームを 2枚 選んでください'
        : `フレームを ${req.min}〜${req.max}枚 選んでください`;

  const normalizedTemp = useMemo(() => normalizeFrames(tempSelectedFrames), [tempSelectedFrames]);

  const tempCount = normalizedTemp.length;
  const isTempValid = tempCount >= req.min && tempCount <= req.max;

  const tempError =
    tempCount === 0
      ? null
      : tempCount < req.min
        ? req.min === 1
          ? '1枚選んでください'
          : '2枚選んでください'
        : tempCount > req.max
          ? `最大${req.max}枚です`
          : null;

  const confirmLabel = useMemo(() => {
    if (!tempCount) return '';
    return `${formatFrameRange(normalizedTemp)} を ${phaseLabelJa(activePhase)}に設定`;
  }, [activePhase, normalizedTemp, tempCount]);

  const switchPhase = (phase: Phase) => {
    setActivePhase(phase);
    setTempSelectedFrames([]);
  };

  const applyConfirmed = (phase: Phase, framesToSet: number[]) => {
    const next: ConfirmedSelections = {
      ...confirmedSelections,
      [phase]: normalizeFrames(framesToSet),
    };
    setConfirmedSelections(next);
    onConfirmedSelectionsChange(next);
    setTempSelectedFrames([]);
    setActivePhase((prev) => pickNextIncomplete(next, nextPhase(prev)));
  };

  const handleTapFrame = (frameIndex: number) => {
    const { instant } = req;

    if (instant) {
      applyConfirmed(activePhase, [frameIndex]);
      return;
    }

    const normalizedPrev = normalizeFrames(tempSelectedFrames);
    if (normalizedPrev.length === 0) {
      setTempSelectedFrames([frameIndex]);
      return;
    }
    if (normalizedPrev.length === 1) {
      const start = normalizedPrev[0]!;
      if (start === frameIndex) {
        setTempSelectedFrames([]);
        return;
      }
      const next = normalizeFrames([start, frameIndex]);
      // DSは2枚そろったら即次へ（インパクト選択へ）
      if (activePhase === 'DS' && req.min === 2 && req.max === 2 && next.length === 2) {
        applyConfirmed(activePhase, next);
        return;
      }
      setTempSelectedFrames(next);
      return;
    }
    setTempSelectedFrames([frameIndex]);
  };

  const confirmTemp = () => {
    if (!isTempValid) return;
    applyConfirmed(activePhase, normalizedTemp);
  };

  const clearTemp = () => setTempSelectedFrames([]);

  const highlighted = highlightedFrames ?? [];

  return (
    <div className="relative">
      <PhaseStepper activePhase={activePhase} confirmedSelections={confirmedSelections} onChange={switchPhase} />

      <div className="pt-3">
        <p className="text-sm text-slate-200">
          <span className="font-semibold">{phaseLabelJa(activePhase)}</span>
          <span className="text-slate-50">：{guideText}</span>
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          {req.instant
            ? 'タップで確定'
            : req.min === 2 && req.max === 2
              ? '1枚目 → 2枚目をタップ（2枚で自動で次へ）'
              : '1回目タップで開始 → 2回目タップで範囲確定'}
        </p>
      </div>

      <div className="mt-3">
        <FrameGrid
          frames={frames}
          highlightedFrames={highlighted}
          activePhase={activePhase}
          tempSelectedFrames={normalizedTemp}
          confirmedSelections={confirmedSelections}
          onTapFrame={handleTapFrame}
        />
      </div>

      <BottomActionBar
        activePhase={activePhase}
        tempSelectedFrames={normalizedTemp}
        isConfirmEnabled={isTempValid && !req.instant}
        confirmLabel={confirmLabel}
        errorText={!req.instant ? tempError : null}
        onConfirm={confirmTemp}
        onClearTemp={clearTemp}
        onReevaluate={onReevaluate}
        onResetAll={onResetAll}
        isReevaluating={isReevaluating}
        isReevaluateEnabled={isReevaluateEnabled}
      />
    </div>
  );
}
