import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type OnPlaneSectionProps = {
  onPlaneData: unknown;
  isPro: boolean;
  overlayFrames?: Array<{ url: string; label: string }> | null;
  poseMetrics?: import("@/app/lib/swing/poseMetrics").PoseMetrics | null;
  analyzerComment?: string | null;
};

type ScoreTone = 'green' | 'yellow' | 'red';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.+-]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nested =
      obj.cm ??
      obj.deg ??
      obj.value ??
      obj.amount ??
      obj.delta ??
      obj.diff ??
      obj.score ??
      obj.matchScore ??
      obj.match_score;
    if (nested !== undefined) return readNumber(nested);
  }
  return null;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
};

const getObj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' ? (value as Record<string, unknown>) : null);

const resolveScore100 = (data: unknown): number | null => {
  const obj = getObj(data);
  if (!obj) return null;
  const candidates = [
    obj.score,
    obj.matchScore,
    obj.match_score,
    obj.onPlaneScore,
    obj.on_plane_score,
    obj.accuracy,
    obj.accuracyScore,
  ];
  for (const c of candidates) {
    const n = readNumber(c);
    if (n == null) continue;
    const score = n <= 1.2 ? n * 100 : n;
    return clamp(Math.round(score), 0, 100);
  }
  return null;
};

const resolveTone = (score: number): ScoreTone => (score >= 80 ? 'green' : score >= 70 ? 'yellow' : 'red');

const resolveGrade = (score: number): string => {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
};

const toneClasses = (tone: ScoreTone) => {
  switch (tone) {
    case 'green':
      return { text: 'text-emerald-300', ring: 'ring-emerald-400/30', bg: 'bg-emerald-900/10' };
    case 'yellow':
      return { text: 'text-amber-200', ring: 'ring-amber-300/30', bg: 'bg-amber-900/10' };
    case 'red':
      return { text: 'text-rose-300', ring: 'ring-rose-400/30', bg: 'bg-rose-900/10' };
  }
};

const resolveSummary = (data: unknown): string | null => {
  const obj = getObj(data);
  if (!obj) return null;
  const candidates = [
    obj.shortSummary,
    obj.short_summary,
    obj.oneLineSummary,
    obj.one_line_summary,
    obj.headline,
    obj.summary,
    obj.comment,
    obj.insight,
    obj.message,
  ];
  for (const c of candidates) {
    const s = readString(c);
    if (!s) continue;
    return s.replace(/\s+/g, ' ').replace(/\n+/g, ' ').trim();
  }
  return null;
};

const sanitizeOneLinerForFree = (text: string | null): string | null => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const first = (t.split('。')[0] || t).trim();
  const s = first.endsWith('。') ? first : `${first}。`;
  const hasUnitNumber = /\b\d+(\.\d+)?\s*(cm|deg)\b/i.test(s) || /\d+(\.\d+)?\s*(センチ|度)\b/.test(s) || /\d+(\.\d+)?\s*°/.test(s);
  if (hasUnitNumber) return null;
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

const resolveReanalyzeTs = (data: unknown): number | null => {
  const obj = getObj(data);
  if (!obj) return null;
  const debug = getObj(obj.pose_debug ?? obj.poseDebug ?? obj.poseDebug);
  if (!debug) return null;
  return readNumber(debug.reanalyze_ts ?? debug.reanalyzeTs ?? debug.reanalyzeTS);
};

type PhaseDeviationKey = 'top_to_downswing' | 'late_downswing' | 'impact';

const resolveDeviationCm = (data: unknown, key: PhaseDeviationKey): number | null => {
  const obj = getObj(data);
  if (!obj) return null;

  const breakdown =
    getObj(obj.phaseBreakdown) ??
    getObj(obj.phase_breakdown) ??
    getObj(obj.phaseDeviations) ??
    getObj(obj.phase_deviations) ??
    getObj(obj.deviations) ??
    getObj(obj.breakdown) ??
    getObj(obj.phases);

  const mapCandidate = getObj(breakdown) ?? obj;

  const candidates =
    key === 'top_to_downswing'
      ? [
          mapCandidate.top_to_downswing_cm,
          mapCandidate.topToDownswingCm,
          mapCandidate.top_to_downswing,
          mapCandidate.topToDownswing,
          mapCandidate.transition_cm,
          mapCandidate.transitionCm,
          mapCandidate.transition,
        ]
      : key === 'late_downswing'
        ? [
            mapCandidate.late_downswing_cm,
            mapCandidate.lateDownswingCm,
            mapCandidate.downswing_late_cm,
            mapCandidate.downswingLateCm,
            mapCandidate.downswing_second_half_cm,
            mapCandidate.downswingSecondHalfCm,
            mapCandidate.downswing_late,
            mapCandidate.downswingLate,
          ]
        : [
            mapCandidate.impact_cm,
            mapCandidate.impactCm,
            mapCandidate.impact,
            mapCandidate.at_impact_cm,
            mapCandidate.atImpactCm,
          ];

  for (const c of candidates) {
    const n = readNumber(c);
    if (n == null) continue;
    return n;
  }
  return null;
};

const sign = (v: number) => (v > 0 ? '+' : '');

const directionLabel = (v: number) => (v >= 0 ? '外側' : '内側');

const formatNumber = (value: number | null | undefined, digits = 2) => {
  if (value == null || !Number.isFinite(value)) return '--';
  const factor = Math.pow(10, digits);
  return `${Math.round(value * factor) / factor}`;
};

const formatDeg = (value: number | null | undefined) => {
  const n = formatNumber(value, 1);
  return n === '--' ? n : `${n}°`;
};

const formatNorm = (value: number | null | undefined) => {
  const n = formatNumber(value, 2);
  return n === '--' ? n : `${n}x`;
};

const labelLowerBodyLead = (lead?: import("@/app/lib/swing/poseMetrics").PoseMetrics["metrics"]["lowerBodyLead"] | null) => {
  const status = lead?.lead ?? 'unclear';
  if (status === 'lower_body') return '下半身先行';
  if (status === 'chest') return '胸先行';
  return '判定不能';
};

const labelHandVsChest = (handVs?: import("@/app/lib/swing/poseMetrics").PoseMetrics["metrics"]["handVsChest"] | null) => {
  const status = handVs?.classification ?? 'unclear';
  if (status === 'hand_first') return '手打ち寄り';
  if (status === 'torso_first') return '振り遅れ寄り';
  if (status === 'mixed') return '混合';
  return '判定中';
};

function OnPlaneFrameOverlay(props: {
  frames: Array<{ url: string; label: string }>;
  addressLandmarks?: {
    clubhead?: { x: number; y: number } | null;
    grip?: { x: number; y: number } | null;
    ball?: { x: number; y: number } | null;
    shoulder?: { x: number; y: number } | null;
    hip?: { x: number; y: number } | null;
  } | null;
  handPoints?: { top?: { x: number; y: number } | null; downswing?: { x: number; y: number } | null; impact?: { x: number; y: number } | null } | null;
  handTrace?: Array<{ x: number; y: number; phase?: string; timestampSec?: number }>;
  phaseTimestamps?: {
    address?: number | null;
    backswing?: number | null;
    top?: number | null;
    downswing?: number | null;
    impact?: number | null;
    finish?: number | null;
  } | null;
  tone: ScoreTone;
}) {
  const frames = props.frames.filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const displayFrames = selectedLabel ? frames.filter((f) => f.label === selectedLabel) : frames;

  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const firstUrl = displayFrames[0]?.url ?? null;
  useEffect(() => {
    if (!firstUrl) return;
    let canceled = false;
    const img = new Image();
    img.onload = () => {
      if (canceled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return;
      setAspectRatio(w / h);
    };
    img.src = firstUrl;
    return () => {
      canceled = true;
    };
  }, [firstUrl]);

  const viewBoxHeight = useMemo(() => {
    const ar = aspectRatio ?? 16 / 9;
    if (!Number.isFinite(ar) || ar <= 0) return 56.25;
    return 100 / ar;
  }, [aspectRatio]);

  if (displayFrames.length < 1) return null;

  const opacity = selectedLabel ? 1.0 : displayFrames.length >= 3 ? 0.32 : 0.38;
  const borderOf = (label: string) =>
    label === 'Address'
      ? 'border-emerald-400/30'
      : label === 'Backswing'
        ? 'border-violet-400/30'
        : label === 'Top'
      ? 'border-sky-400/30'
      : label.startsWith('Downswing')
        ? 'border-amber-300/30'
        : label === 'Impact'
          ? 'border-rose-300/30'
          : 'border-slate-400/30';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-2 w-full">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">フレーム重ね表示（透かし）</p>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
          {frames.map((f) => (
            <span key={f.label} className="inline-flex items-center gap-1">
              <span
                className={`h-2 w-2 rounded-full ${
                  f.label === 'Address'
                    ? 'bg-emerald-300'
                    : f.label === 'Backswing'
                      ? 'bg-violet-300'
                      : f.label === 'Top'
                    ? 'bg-sky-300'
                  : f.label.startsWith('Downswing')
                      ? 'bg-amber-200'
                      : f.label === 'Impact'
                        ? 'bg-rose-300'
                        : 'bg-slate-300'
                }`}
              />
              {f.label}
            </span>
          ))}
          {frames.length ? (
            <div className="ml-2 inline-flex flex-wrap items-center gap-1 rounded-full border border-slate-700 bg-slate-950/40 p-0.5">
              <button
                type="button"
                onClick={() => setSelectedLabel(null)}
                className={`rounded-full px-2 py-1 text-[11px] ${
                  selectedLabel === null ? 'bg-slate-200/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                重ね
              </button>
              {frames.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => setSelectedLabel(f.label)}
                  className={`rounded-full px-2 py-1 text-[11px] ${
                    selectedLabel === f.label ? 'bg-slate-200/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex justify-center">
        <div className="w-full max-w-sm overflow-hidden rounded-lg border border-slate-800 bg-slate-950/30">
          <div className="relative w-full" style={{ aspectRatio: aspectRatio ? String(aspectRatio) : '16 / 9' }}>
          {displayFrames.map((f, idx) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${f.label}-${idx}`}
              src={f.url}
              alt={`${f.label} frame`}
              className={`absolute inset-0 h-full w-full object-contain ${selectedLabel ? 'mix-blend-normal' : 'mix-blend-screen'}`}
              style={{ opacity }}
              loading="lazy"
            />
          ))}
          {/* Overlay: same "plane vs trajectory" logic as the mini-viz, plotted on top of frames */}
          <svg
            viewBox={`0 0 100 ${viewBoxHeight}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full pointer-events-none"
          >
            {null}

            {/* Address landmarks (debug): points only */}
            {(() => {
              const lm = props.addressLandmarks ?? null;
              if (!lm) return null;
              const norm = (p: { x: number; y: number } | null | undefined) =>
                p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } : null;
              const club = norm(lm.clubhead);
              const grip = norm(lm.grip);
              const ball = norm(lm.ball);
              const shoulder = norm(lm.shoulder);
              const hip = norm(lm.hip);
              const dot = (p: { x: number; y: number }, fill: string, stroke: string) => (
                <circle cx={p.x * 100} cy={p.y * viewBoxHeight} r="1.35" fill={fill} stroke={stroke} strokeWidth="0.55" />
              );
              return (
                <>
                  {club ? dot(club, "rgba(248,113,113,0.9)", "rgba(248,113,113,0.6)") : null}
                  {grip ? dot(grip, "rgba(74,222,128,0.9)", "rgba(74,222,128,0.6)") : null}
                  {ball ? dot(ball, "rgba(226,232,240,0.9)", "rgba(226,232,240,0.7)") : null}
                  {shoulder ? dot(shoulder, "rgba(59,130,246,0.9)", "rgba(59,130,246,0.6)") : null}
                  {hip ? dot(hip, "rgba(168,85,247,0.9)", "rgba(168,85,247,0.6)") : null}
                </>
              );
            })()}

            {/* Hand trace (Top → Downswing → Impact). Yellow = hands (grip center). */}
            {(() => {
              const hp = props.handPoints ?? null;
              const top = hp?.top ?? null;
              const down = hp?.downswing ?? null;
              const impact = hp?.impact ?? null;
              const pts = [top, down, impact].filter((p): p is { x: number; y: number } => !!p);

              const tracePts =
                (props.handTrace ?? [])
                  .map((p) =>
                    p && Number.isFinite(p.x) && Number.isFinite(p.y)
                      ? {
                          x: clamp(p.x, 0, 1),
                          y: clamp(p.y, 0, 1),
                          phase: (p.phase ?? '').toLowerCase(),
                          timestampSec: p.timestampSec,
                        }
                      : null,
                  )
                  .filter((p): p is { x: number; y: number; phase: string; timestampSec?: number } => !!p) ?? [];

              const allPts = tracePts.length >= 2 ? tracePts : pts.map((p) => ({ ...p, phase: '' }));
              if (allPts.length < 2) return null;

              const backswingPts = tracePts.filter(
                (p) => p.phase.includes('top') || p.phase.includes('back') || p.phase.includes('address') || p.phase.includes('addr'),
              );
              const tracePtsSorted = [...tracePts].sort((a, b) => {
                const ta = typeof a.timestampSec === 'number' && Number.isFinite(a.timestampSec) ? a.timestampSec : Number.POSITIVE_INFINITY;
                const tb = typeof b.timestampSec === 'number' && Number.isFinite(b.timestampSec) ? b.timestampSec : Number.POSITIVE_INFINITY;
                if (ta === tb) return 0;
                return ta < tb ? -1 : 1;
              });
              const impactTs = props.phaseTimestamps?.impact ?? null;
              const downswingTs = props.phaseTimestamps?.top ?? props.phaseTimestamps?.downswing ?? null;
              const withinImpactWindow = (p: { timestampSec?: number }) => {
                if (impactTs == null) return true;
                if (typeof p.timestampSec !== 'number' || !Number.isFinite(p.timestampSec)) return false;
                return p.timestampSec <= impactTs;
              };
              const withinDownswingWindow = (p: { timestampSec?: number }) => {
                if (downswingTs == null || impactTs == null) return true;
                if (typeof p.timestampSec !== 'number' || !Number.isFinite(p.timestampSec)) return false;
                return p.timestampSec >= downswingTs && p.timestampSec <= impactTs;
              };
              let cutoffIndex: number | null = null;
              if (impactTs != null) {
                for (let i = 0; i < tracePtsSorted.length; i += 1) {
                  const ts = tracePtsSorted[i]?.timestampSec;
                  if (typeof ts === 'number' && Number.isFinite(ts) && ts <= impactTs) {
                    cutoffIndex = i;
                  }
                }
              }
              const clippedTrace =
                cutoffIndex != null
                  ? tracePtsSorted.slice(0, cutoffIndex + 1).filter(withinImpactWindow)
                  : tracePtsSorted;
              let downswingPts =
                downswingTs != null && impactTs != null
                  ? clippedTrace.filter(withinDownswingWindow)
                  : clippedTrace.filter((p) => p.phase.includes('down'));
              if (downswingPts.length < 2) {
                downswingPts =
                  impactTs != null
                    ? clippedTrace.filter(withinImpactWindow)
                    : clippedTrace.filter((p) => p.phase.includes('down'));
              }
              const fallbackBackPts = top && down ? [top, down] : null;
              const fallbackDownPts = down && impact ? [down, impact] : null;

              const toPath = (points: Array<{ x: number; y: number }>) =>
                points.map((p) => `${p.x * 100} ${p.y * viewBoxHeight}`).join(' L ');

              const tracePath = clippedTrace.length >= 2 ? toPath(clippedTrace) : null;
              const fullPath = tracePath;
              const backPath =
                backswingPts.length >= 2
                  ? toPath(backswingPts)
                  : fallbackBackPts
                    ? toPath(fallbackBackPts)
                    : null;
              const fallbackDownPath = fallbackDownPts ? toPath(fallbackDownPts) : null;

              return (
                <>
                  {fullPath ? (
                    <path d={`M ${fullPath}`} stroke="rgba(226,232,240,0.12)" strokeWidth="0.75" fill="none" strokeLinecap="round" />
                  ) : null}
                  {backPath ? (
                    <path d={`M ${backPath}`} stroke="rgba(125, 211, 252, 0.9)" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                  {downswingPts.length >= 2 ? (
                    <path d={`M ${toPath(downswingPts)}`} stroke="rgba(253, 230, 138, 0.98)" strokeWidth="2.0" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ) : fallbackDownPath ? (
                    <path d={`M ${fallbackDownPath}`} stroke="rgba(253, 230, 138, 0.98)" strokeWidth="2.0" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ) : tracePath ? (
                    <path d={`M ${tracePath}`} stroke="rgba(253, 230, 138, 0.98)" strokeWidth="2.0" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                </>
              );
            })()}

            {/* Legend (place away from top phase tabs) */}
            <g>
              <rect x="52" y={Math.max(4.5, viewBoxHeight - 7.6)} width="40" height="5.6" rx="1.8" fill="rgba(2,6,23,0.55)" />
              <g transform={`translate(56, ${Math.max(5.8, viewBoxHeight - 6.3)})`}>
                <line x1="0" y1="1.6" x2="6" y2="1.6" stroke="rgba(125, 211, 252, 0.9)" strokeWidth="1.6" strokeLinecap="round" />
                <text x="7.6" y="2.45" fontSize="1.75" fill="rgba(226,232,240,0.92)">
                  Back
                </text>
                <line x1="20.8" y1="1.6" x2="26.8" y2="1.6" stroke="rgba(253, 230, 138, 0.96)" strokeWidth="1.8" strokeLinecap="round" />
                <text x="28.6" y="2.45" fontSize="1.75" fill="rgba(226,232,240,0.92)">
                  Down
                </text>
              </g>
            </g>
          </svg>
          <div className="absolute inset-0 pointer-events-none">
            <div className="flex flex-wrap gap-2 p-2">
              {displayFrames.slice(0, 5).map((f) => (
                <div
                  key={`cap-${f.label}`}
                  className={`rounded-md border ${borderOf(f.label)} bg-slate-950/40 px-2 py-1 text-[11px] text-slate-200`}
                >
                  {f.label}
                </div>
              ))}
            </div>
          </div>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mt-2">
        ※ 図は理解優先のガイド表示です（位置合わせは自動ではありません）。録画の角度・トリミング差でズレます。
      </p>
    </div>
  );
}

type PlaneLine01 = { x1: number; y1: number; x2: number; y2: number };

const lineDx = (l: PlaneLine01) => l.x2 - l.x1;
const lineDy = (l: PlaneLine01) => l.y2 - l.y1;
const flipXLine = (l: PlaneLine01): PlaneLine01 => ({ x1: 1 - l.x1, y1: l.y1, x2: 1 - l.x2, y2: l.y2 });
const flipXPoint01 = (p: { x: number; y: number }): { x: number; y: number } => ({ x: 1 - p.x, y: p.y });

const normalizePlaneLine01 = (value: unknown): PlaneLine01 | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const x1 = readNumber(v.x1);
  const y1 = readNumber(v.y1);
  const x2 = readNumber(v.x2);
  const y2 = readNumber(v.y2);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  const nx1 = clamp(to01(x1), 0, 1);
  const ny1 = clamp(to01(y1), 0, 1);
  const nx2 = clamp(to01(x2), 0, 1);
  const ny2 = clamp(to01(y2), 0, 1);
  return { x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
};

const resolvePlaneLine = (onPlaneData: unknown, which: 'backswing' | 'downswing'): PlaneLine01 | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const candidates =
    which === 'backswing'
      ? [
          obj.backswing_plane,
          obj.backswingPlane,
          obj.back_plane,
          obj.backPlane,
          getObj(obj.visual)?.backswing_plane,
          getObj(obj.visual)?.backswingPlane,
        ]
      : [
          obj.reference_plane,
          obj.referencePlane,
          obj.downswing_plane,
          obj.downswingPlane,
          obj.down_plane,
          obj.downPlane,
          getObj(obj.visual)?.downswing_plane,
          getObj(obj.visual)?.downswingPlane,
        ];
  for (const c of candidates) {
    const line = normalizePlaneLine01(c);
    if (line) return line;
  }
  return null;
};


const resolveHandPoints = (
  onPlaneData: unknown,
): { top?: { x: number; y: number } | null; downswing?: { x: number; y: number } | null; impact?: { x: number; y: number } | null } | null => {
  const obj = getObj(onPlaneData);
  const hp = getObj(obj?.hand_points ?? obj?.handPoints);
  if (!hp) return null;
  const readPt = (v: unknown) => {
    const o = getObj(v);
    if (!o) return null;
    const x = readNumber(o.x);
    const y = readNumber(o.y);
    if (x == null || y == null) return null;
    const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
    return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
  };
  return { top: readPt(hp.top), downswing: readPt(hp.downswing), impact: readPt(hp.impact) };
};

const resolveHandTrace = (onPlaneData: unknown): Array<{ x: number; y: number; phase?: string; timestampSec?: number }> | null => {
  const obj = getObj(onPlaneData);
  const visual = getObj(obj?.visual);
  const raw =
    obj?.hand_trace_display ??
    obj?.handTraceDisplay ??
    visual?.hand_trace_display ??
    visual?.handTraceDisplay ??
    obj?.hand_trace ??
    obj?.handTrace ??
    visual?.hand_trace ??
    visual?.handTrace;
  const parsedRaw =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(parsedRaw)) return null;
  const out: Array<{ x: number; y: number; phase?: string; timestampSec?: number }> = [];
  for (const entry of parsedRaw) {
    const e = getObj(entry);
    if (!e) continue;
    const x = readNumber(e.x);
    const y = readNumber(e.y);
    if (x == null || y == null) continue;
    const timestampSec = readNumber(e.timestampSec ?? e.timestamp_sec ?? e.t ?? e.time);
    const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
    out.push({
      x: clamp(to01(x), 0, 1),
      y: clamp(to01(y), 0, 1),
      phase: readString(e.phase) ?? undefined,
      timestampSec: timestampSec ?? undefined,
    });
  }
  return out.length ? out : null;
};

const resolvePhaseTimestamps = (onPlaneData: unknown) => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const raw = getObj(obj.phase_timestamps ?? obj.phaseTimestamps);
  if (!raw) return null;
  const readTs = (value: unknown) => {
    const n = readNumber(value);
    return n != null && Number.isFinite(n) ? n : null;
  };
  return {
    address: readTs(raw.address),
    backswing: readTs(raw.backswing),
    top: readTs(raw.top),
    downswing: readTs(raw.downswing),
    impact: readTs(raw.impact),
    finish: readTs(raw.finish),
  };
};

const resolveOutsideInIndicator = (onPlaneData: unknown, poseMetrics?: import("@/app/lib/swing/poseMetrics").PoseMetrics | null) => {
  const proxy = poseMetrics?.metrics.outsideInProxy ?? null;
  if (proxy?.status) {
    const label =
      proxy.status === "confirmed"
        ? "アウトサイドイン傾向が強い"
        : proxy.status === "tendency"
          ? "アウトサイドイン傾向が見られる"
          : proxy.status === "none"
            ? "アウトサイドイン傾向は目立たない"
            : "判定不能";
    return {
      label,
      valueNorm: proxy.handOffsetNorm ?? null,
      outsideRatio: proxy.outsideRatio ?? null,
      source: "mediapipe",
    };
  }
  const obj = getObj(onPlaneData);
  const primary = readString(obj?.primary_deviation ?? obj?.primaryDeviation) ?? null;
  const top = resolveDeviationCm(onPlaneData, "top_to_downswing");
  const late = resolveDeviationCm(onPlaneData, "late_downswing");
  const value = typeof top === "number" ? top : typeof late === "number" ? late : null;
  const label = (() => {
    if (typeof value === "number") {
      if (value >= 2.5) return "アウトサイドイン傾向が見られる";
      if (value <= -2.5) return "内側寄り";
      return "中立";
    }
    if (primary === "outside") return "アウトサイドイン傾向が見られる";
    if (primary === "inside") return "内側寄り";
    return "判定不能";
  })();
  return { label, valueCm: value, source: "on_plane" };
};

const traceSpread = (points: Array<{ x: number; y: number }>) => {
  if (points.length < 2) return 0;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(0, (maxX - minX) + (maxY - minY));
};

const countTracePhases = (points: Array<{ phase?: string | null }>) => {
  const counts: Record<string, number> = {};
  for (const point of points) {
    const phase = typeof point.phase === 'string' ? point.phase.trim().toLowerCase() : '';
    if (!phase) continue;
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  return counts;
};

const interpolatePointAtTime = (
  points: Array<{ x: number; y: number; timestampSec?: number }>,
  targetTs: number,
) => {
  const withTs = points
    .filter((p) => typeof p.timestampSec === 'number' && Number.isFinite(p.timestampSec))
    .map((p) => ({ ...p, timestampSec: p.timestampSec as number }))
    .sort((a, b) => a.timestampSec - b.timestampSec);
  if (withTs.length < 2) return null;
  let before = withTs[0]!;
  let after = withTs[withTs.length - 1]!;
  for (let i = 0; i < withTs.length; i += 1) {
    const p = withTs[i]!;
    if (p.timestampSec <= targetTs) before = p;
    if (p.timestampSec >= targetTs) {
      after = p;
      break;
    }
  }
  const t1 = before.timestampSec;
  const t2 = after.timestampSec;
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 === t2) return { x: before.x, y: before.y, timestampSec: t1 };
  const t = (targetTs - t1) / (t2 - t1);
  return {
    x: clamp(before.x + (after.x - before.x) * t, 0, 1),
    y: clamp(before.y + (after.y - before.y) * t, 0, 1),
    timestampSec: targetTs,
  };
};

const rephaseTraceByMinY = (points: Array<{ x: number; y: number; phase?: string }>) => {
  if (points.length < 3) return points;
  let minIdx = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.y < points[minIdx]!.y) minIdx = i;
  }
  return points.map((p, i) => ({
    ...p,
    phase: i <= minIdx ? 'backswing' : 'downswing',
  }));
};


const resolveZoneAnchorPoint = (onPlaneData: unknown): { x: number; y: number } | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const raw =
    obj.raw_clubhead_point ??
    obj.rawClubheadPoint ??
    obj.clubhead_point ??
    obj.clubheadPoint ??
    obj.ball_point ??
    obj.ballPoint ??
    obj.ball_point_01 ??
    obj.ballPoint01 ??
    getObj(obj.visual)?.raw_clubhead_point ??
    getObj(obj.visual)?.rawClubheadPoint ??
    getObj(obj.visual)?.clubhead_point ??
    getObj(obj.visual)?.clubheadPoint ??
    getObj(obj.visual)?.ball_point ??
    getObj(obj.visual)?.ballPoint;
  const o = getObj(raw);
  if (!o) return null;
  const x = readNumber(o.x);
  const y = readNumber(o.y);
  if (x == null || y == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
};

const resolveAddressShoulderPoint = (onPlaneData: unknown): { x: number; y: number } | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const raw =
    obj.address_shoulder_point_pose ??
    obj.addressShoulderPointPose ??
    obj.address_shoulder_point ??
    obj.addressShoulderPoint ??
    getObj(obj.visual)?.address_shoulder_point_pose ??
    getObj(obj.visual)?.addressShoulderPointPose ??
    getObj(obj.visual)?.address_shoulder_point ??
    getObj(obj.visual)?.addressShoulderPoint;
  const o = getObj(raw);
  if (!o) return null;
  const x = readNumber(o.x);
  const y = readNumber(o.y);
  if (x == null || y == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
};

const resolveAddressHipPoint = (onPlaneData: unknown): { x: number; y: number } | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const raw = obj.address_hip_point ?? obj.addressHipPoint ?? getObj(obj.visual)?.address_hip_point ?? getObj(obj.visual)?.addressHipPoint;
  const o = getObj(raw);
  if (!o) return null;
  const x = readNumber(o.x);
  const y = readNumber(o.y);
  if (x == null || y == null) return null;
  const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
  return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
};

const resolveAddressLandmarks = (onPlaneData: unknown) => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;

  const readPt = (raw: unknown) => {
    const o = getObj(raw);
    if (!o) return null;
    const x = readNumber(o.x);
    const y = readNumber(o.y);
    if (x == null || y == null) return null;
    const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
    return { x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1) };
  };

  const visual = getObj(obj.visual);
  const rawClubhead = readPt(
    obj.raw_clubhead_point ??
      obj.rawClubheadPoint ??
      visual?.raw_clubhead_point ??
      visual?.rawClubheadPoint,
  );
  const clubhead = rawClubhead ?? readPt(obj.clubhead_point ?? obj.clubheadPoint ?? visual?.clubhead_point ?? visual?.clubheadPoint);
  const grip = readPt(obj.grip_point ?? obj.gripPoint ?? visual?.grip_point ?? visual?.gripPoint);
  const ball = readPt(obj.ball_point ?? obj.ballPoint ?? visual?.ball_point ?? visual?.ballPoint);
  const shoulder = readPt(obj.address_shoulder_point ?? obj.addressShoulderPoint ?? visual?.address_shoulder_point ?? visual?.addressShoulderPoint);
  const shoulderPose = readPt(obj.address_shoulder_point_pose ?? obj.addressShoulderPointPose ?? visual?.address_shoulder_point_pose ?? visual?.addressShoulderPointPose);
  const hip = readPt(obj.address_hip_point ?? obj.addressHipPoint ?? visual?.address_hip_point ?? visual?.addressHipPoint);
  const finalShoulder = shoulderPose ?? shoulder;
  if (!clubhead && !grip && !ball && !finalShoulder && !hip) return null;
  return { clubhead, grip, ball, shoulder: finalShoulder, hip };
};

export default function OnPlaneSection(props: OnPlaneSectionProps) {
  const { onPlaneData, isPro, overlayFrames, poseMetrics } = props;
  const analyzerComment = props.analyzerComment ?? null;
  const score = resolveScore100(onPlaneData);
  const tone = resolveTone(score ?? 0);
  const toneClass = toneClasses(tone);

  const summary = resolveSummary(onPlaneData);
  const downswingPlaneRaw = resolvePlaneLine(onPlaneData, 'downswing');
  const handPointsRaw = resolveHandPoints(onPlaneData);
  const handTraceRaw = resolveHandTrace(onPlaneData);
  const phaseTimestamps = resolvePhaseTimestamps(onPlaneData);
  const addressLandmarksRaw = resolveAddressLandmarks(onPlaneData);
  const onPlaneSource = readString(getObj(onPlaneData)?.source);
  const reanalyzeTs = resolveReanalyzeTs(onPlaneData);
  const reanalyzeLabel = reanalyzeTs ? new Date(reanalyzeTs).toLocaleString('ja-JP', { hour12: false }) : null;

  // Display heuristic:
  // If extracted shaft-vector lines consistently tilt "right-up -> left-down" (negative slope),
  // flip X for visualization so the plane aligns with the most common DTL expectation (left-up -> right-down).
  // This does NOT change stored data; it only affects rendering.
  const shouldFlipX = false;

  const poseTraceFallback = (() => {
    if (!poseMetrics?.handTrace?.length) return null;
    return poseMetrics.handTrace.map((p) => ({ x: p.x, y: p.y, phase: p.phase }));
  })();

  const handPointsFallback = (() => {
    const keypoints = poseMetrics?.handKeypoints;
    if (!keypoints) return null;
    const downswingPoint = poseMetrics?.handTrace?.find((p) => p.phase === "downswing") ?? null;
    return {
      top: keypoints.top ?? null,
      downswing: downswingPoint ? { x: downswingPoint.x, y: downswingPoint.y } : null,
      impact: keypoints.impact ?? null,
    };
  })();

  const handTrace = (() => {
    const base = handTraceRaw ?? poseTraceFallback;
    if (!base) return null;
    if (!shouldFlipX) return base;
    return base.map((p) => {
      const flippedX = shouldFlipX ? { ...p, x: 1 - p.x } : p;
      return flippedX;
    });
  })();
  const handPoints = (() => {
    const base = handPointsRaw ?? handPointsFallback;
    if (!base) return null;
    if (!shouldFlipX) return base;
    const apply = (p: { x: number; y: number } | null) => {
      if (!p) return null;
      const flippedX = shouldFlipX ? flipXPoint01(p) : p;
      return flippedX;
    };
    return {
      top: apply(base.top),
      downswing: apply(base.downswing),
      impact: apply(base.impact),
    };
  })();
  const addressLandmarks = (() => {
    if (!addressLandmarksRaw) return null;
    if (!shouldFlipX) return addressLandmarksRaw;
    const flip = (p: { x: number; y: number } | null | undefined) => {
      if (!p) return null;
      const flippedX = shouldFlipX ? flipXPoint01(p) : p;
      return flippedX;
    };
    return {
      clubhead: flip(addressLandmarksRaw.clubhead),
      grip: flip(addressLandmarksRaw.grip),
      ball: flip(addressLandmarksRaw.ball),
      shoulder: flip(addressLandmarksRaw.shoulder),
      hip: flip(addressLandmarksRaw.hip),
    };
  })();
  const displayHandTrace = (() => {
    if (!handTrace?.length) return handTrace;
    const counts = countTracePhases(handTrace);
    const backswingCount = counts.backswing ?? 0;
    const downswingCount = counts.downswing ?? 0;
    if (backswingCount >= 8 && downswingCount <= 3) {
      return rephaseTraceByMinY(handTrace);
    }
    return handTrace;
  })();
  const displayHandPoints = (() => {
    if (!displayHandTrace?.length) return handPoints;
    const hasTop = handPoints?.top != null;
    const hasImpact = handPoints?.impact != null;
    if (hasTop && hasImpact) return handPoints;
    const topTs = phaseTimestamps?.top ?? null;
    const interpolatedTop = topTs != null ? interpolatePointAtTime(displayHandTrace, topTs) : null;
    let topIdx = 0;
    for (let i = 1; i < displayHandTrace.length; i += 1) {
      if (displayHandTrace[i]!.y < displayHandTrace[topIdx]!.y) topIdx = i;
    }
    const downswingPoint = displayHandTrace.find((p) => (p.phase ?? '').includes('down')) ?? null;
    const impactPoint = displayHandTrace[displayHandTrace.length - 1] ?? null;
    return {
      top:
        handPoints?.top ??
        (interpolatedTop ? { x: interpolatedTop.x, y: interpolatedTop.y } : null) ??
        (displayHandTrace[topIdx] ? { x: displayHandTrace[topIdx]!.x, y: displayHandTrace[topIdx]!.y } : null),
      downswing: handPoints?.downswing ?? (downswingPoint ? { x: downswingPoint.x, y: downswingPoint.y } : null),
      impact: handPoints?.impact ?? (impactPoint ? { x: impactPoint.x, y: impactPoint.y } : null),
    };
  })();
  const displayHandTraceWithTop = (() => {
    if (!displayHandTrace?.length) return displayHandTrace;
    const hasTop = displayHandTrace.some((p) => (p.phase ?? '').toLowerCase().includes('top'));
    if (hasTop) return displayHandTrace;
    const topTs = phaseTimestamps?.top ?? null;
    const interpolatedTop = topTs != null ? interpolatePointAtTime(displayHandTrace, topTs) : null;
    const topPoint = interpolatedTop
      ? { x: interpolatedTop.x, y: interpolatedTop.y, timestampSec: interpolatedTop.timestampSec }
      : (displayHandPoints?.top ?? null);
    if (!topPoint) return displayHandTrace;
    let minIdx = 0;
    for (let i = 1; i < displayHandTrace.length; i += 1) {
      if (displayHandTrace[i]!.y < displayHandTrace[minIdx]!.y) minIdx = i;
    }
    const ts = topPoint.timestampSec ?? phaseTimestamps?.top ?? displayHandTrace[minIdx]?.timestampSec;
    const injected = { ...topPoint, phase: 'top', timestampSec: ts };
    const next = displayHandTrace.slice();
    next.splice(minIdx, 0, injected);
    return next;
  })();
  const top = resolveDeviationCm(onPlaneData, 'top_to_downswing');
  const late = resolveDeviationCm(onPlaneData, 'late_downswing');
  const impact = resolveDeviationCm(onPlaneData, 'impact');
  const hasDeviations = [top, late, impact].some((v) => typeof v === 'number' && Number.isFinite(v));

  const derivedOneLiner = (() => {
    if (!hasDeviations) return '診断データが不足しています。';
    const entries = [
      { key: 'top→downswing', v: top },
      { key: 'downswing後半', v: late },
      { key: 'impact', v: impact },
    ].filter((e): e is { key: string; v: number } => typeof e.v === 'number' && Number.isFinite(e.v));
    entries.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const main = entries[0];
    if (!main) return '診断データが不足しています。';
    const dir = directionLabel(main.v);
    if (main.key === 'impact') return `インパクト付近でやや${dir}を通過しています。`;
    if (main.key === 'downswing後半') return `ダウンスイング後半でやや${dir}を通過しています。`;
    return `切り返し〜下ろしでやや${dir}を通過しています。`;
  })();

  const freeOneLiner = sanitizeOneLinerForFree(summary) ?? derivedOneLiner;

  const proCausalSummary = (() => {
    const obj = getObj(onPlaneData);
    const direct = resolveSummary(onPlaneData) ?? readString(obj?.causal_summary) ?? readString(obj?.cause_summary) ?? readString(obj?.why);
    if (direct) return direct;
    if (!hasDeviations) return '軌道のズレは複合要因で起こるため、まずはズレが大きいフェーズを優先して整えるのが近道です。';
    const entries = [
      { phase: 'Top → Downswing', v: top },
      { phase: 'Downswing後半', v: late },
      { phase: 'Impact', v: impact },
    ].filter((e): e is { phase: string; v: number } => typeof e.v === 'number' && Number.isFinite(e.v));
    entries.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const main = entries[0];
    if (!main) return '軌道のズレは複合要因で起こるため、まずはズレが大きいフェーズを優先して整えるのが近道です。';
    const dir = directionLabel(main.v);
    return `${main.phase}で${dir}へのズレが大きく出ています。ここが崩れると、そのままインパクトまで軌道が戻りにくくなります。`;
  })();

  const prev = (() => {
    const obj = getObj(onPlaneData);
    return obj?.previous ?? obj?.prev ?? (getObj(obj?.comparison)?.previous ?? null);
  })();
  const prevScore = resolveScore100(prev);
  const scoreDelta = typeof score === 'number' && typeof prevScore === 'number' ? score - prevScore : null;

  const impactPrev = resolveDeviationCm(prev, 'impact');
  const impactDelta = typeof impact === 'number' && typeof impactPrev === 'number' ? impact - impactPrev : null;
  const impactTrend = (() => {
    if (typeof impact !== 'number' || typeof impactPrev !== 'number') return null;
    const prevAbs = Math.abs(impactPrev);
    const nowAbs = Math.abs(impact);
    if (nowAbs < prevAbs) return '改善';
    if (nowAbs > prevAbs) return '悪化';
    return '変化なし';
  })();

  const poseMetricsBlock = poseMetrics ? (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-xs text-slate-400">MediaPipe 定量指標</p>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        {(() => {
          const outside = resolveOutsideInIndicator(onPlaneData, poseMetrics ?? null);
          return (
            <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
              <p className="text-slate-300">アウトサイドイン傾向</p>
              <p className="text-sm text-slate-100">{outside.label}</p>
              <p className="text-[11px] text-slate-400">
                {outside.source === "mediapipe"
                  ? `オフセット: ${formatNumber(outside.valueNorm, 2)}x / 外側率 ${formatNumber(
                      (outside.outsideRatio ?? 0) * 100,
                      0
                    )}%`
                  : `Top→DS: ${formatNumber(outside.valueCm, 1)} cm${typeof outside.valueCm === "number" ? ` (${directionLabel(outside.valueCm)})` : ""}`}
              </p>
            </div>
          );
        })()}
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">下半身始動</p>
          <p className="text-sm text-slate-100">{labelLowerBodyLead(poseMetrics.metrics.lowerBodyLead)}</p>
          <p className="text-[11px] text-slate-400">
            差分: {formatNumber(poseMetrics.metrics.lowerBodyLead?.deltaFrames, 0)} frames
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">手打ち / 振り遅れ</p>
          <p className="text-sm text-slate-100">{labelHandVsChest(poseMetrics.metrics.handVsChest)}</p>
          <p className="text-[11px] text-slate-400">
            進行比: {formatNumber(poseMetrics.metrics.handVsChest?.ratio, 2)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">胸回転量（Top→Impact）</p>
          <p className="text-sm text-slate-100">{formatDeg(poseMetrics.metrics.chestRotationDeg)}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">前傾維持（肩-腰角度差）</p>
          <p className="text-sm text-slate-100">{formatDeg(poseMetrics.metrics.spineTiltDeltaDeg)}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">頭のブレ（肩中心）</p>
          <p className="text-sm text-slate-100">{formatNorm(poseMetrics.metrics.headSway?.distNorm)}</p>
          <p className="text-[11px] text-slate-400">
            Δx {formatNumber(poseMetrics.metrics.headSway?.dx, 3)} / Δy {formatNumber(poseMetrics.metrics.headSway?.dy, 3)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-1">
          <p className="text-slate-300">膝のブレ</p>
          <p className="text-sm text-slate-100">{formatNorm(poseMetrics.metrics.kneeSway?.distNorm)}</p>
          <p className="text-[11px] text-slate-400">
            Δx {formatNumber(poseMetrics.metrics.kneeSway?.dx, 3)} / Δy {formatNumber(poseMetrics.metrics.kneeSway?.dy, 3)}
          </p>
        </div>
      </div>
    </div>
  ) : null;

  const analyzerCoachBlock = isPro ? (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
      <p className="text-xs text-slate-400">AIコーチによる解説</p>
      <p className="text-sm text-slate-100 whitespace-pre-line">
        {(analyzerComment ?? '').trim() || '解析コメントを準備中です。'}
      </p>
    </div>
  ) : (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
      <p className="text-xs text-slate-400">AIコーチによる解説（PRO限定）</p>
      <p className="text-sm text-slate-200">PRO会員になるとAIコーチの解説が見られます。</p>
      <Link href="/pricing" className="text-sm text-slate-300 underline underline-offset-4 hover:text-slate-100">
        PROで解説を見る
      </Link>
    </div>
  );

  return (
    <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">スイングアナライザー</h2>
          <p className="text-xs text-slate-400 mt-1">スイングを定量的に解析</p>
          {reanalyzeLabel ? <p className="text-[11px] text-slate-500 mt-1">再解析: {reanalyzeLabel}</p> : null}
        </div>
      </div>

      {!isPro ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-200">{freeOneLiner}</p>
          {poseMetricsBlock}
          {analyzerCoachBlock}
          <div className="pt-1">
            <Link
              href="/pricing"
              className="text-sm text-slate-300 underline underline-offset-4 hover:text-slate-100"
            >
              どのフェーズで、どれくらいズレているかを見る（PRO）
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            {(typeof scoreDelta === 'number' || typeof impactDelta === 'number') && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                <p className="text-[11px] text-slate-400">前回比較</p>
                {typeof scoreDelta === 'number' && (
                  <p className={`text-sm font-semibold tabular-nums ${scoreDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {scoreDelta === 0 ? 'スコア変化なし' : `スコア ${scoreDelta >= 0 ? '+' : ''}${scoreDelta}点`}
                  </p>
                )}
                {typeof impactDelta === 'number' && impactTrend && (
                  <p className="text-xs text-slate-300 tabular-nums mt-1">
                    Impact {impactTrend}（差分 {sign(impactDelta)}{impactDelta.toFixed(1)}cm）
                  </p>
                )}
              </div>
            )}
          </div>

          {poseMetricsBlock}
          {analyzerCoachBlock}

          {overlayFrames?.length ? (
            <div className="w-full">
              <OnPlaneFrameOverlay
                frames={overlayFrames}
                tone={tone}
                addressLandmarks={addressLandmarks}
                handPoints={displayHandPoints}
                handTrace={displayHandTraceWithTop ?? undefined}
                phaseTimestamps={phaseTimestamps}
              />
            </div>
          ) : null}

        </div>
      )}
    </section>
  );
}
