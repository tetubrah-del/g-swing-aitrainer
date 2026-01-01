import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type OnPlaneSectionProps = {
  onPlaneData: unknown;
  isPro: boolean;
  overlayFrames?: Array<{ url: string; label: string }> | null;
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

function OnPlaneFrameOverlay(props: {
  frames: Array<{ url: string; label: string }>;
  referencePlane?: PlaneLine01 | null;
  referencePlaneEvidence?: PlaneLine01 | null;
  zoneThetaDeg?: number | null;
  zoneAnchor?: { x: number; y: number } | null;
  zoneUpperPoint?: { x: number; y: number } | null;
  zoneLowerPoint?: { x: number; y: number } | null;
  zoneUnstable?: boolean;
  addressLandmarks?: {
    clubhead?: { x: number; y: number } | null;
    grip?: { x: number; y: number } | null;
    ball?: { x: number; y: number } | null;
    shoulder?: { x: number; y: number } | null;
    hip?: { x: number; y: number } | null;
  } | null;
  handPoints?: { top?: { x: number; y: number } | null; downswing?: { x: number; y: number } | null; impact?: { x: number; y: number } | null } | null;
  handTrace?: Array<{ x: number; y: number; phase?: string }>;
  deviations?: { top: number; late: number; impact: number } | null;
  tone: ScoreTone;
}) {
  const frames = props.frames.filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'));
  const addressFrame = frames.find((f) => f.label === 'Address') ?? null;
  const [viewMode, setViewMode] = useState<'overlay' | 'address'>(() => (addressFrame ? 'address' : 'overlay'));
  const displayFrames = viewMode === 'address' && addressFrame ? [addressFrame] : frames;

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

  const opacity = viewMode === 'overlay' ? (displayFrames.length >= 3 ? 0.32 : 0.38) : 1.0;
  const borderOf = (label: string) =>
    label === 'Address'
      ? 'border-emerald-400/30'
      : label === 'Backswing'
        ? 'border-violet-400/30'
        : label === 'Top'
      ? 'border-sky-400/30'
      : label === 'Downswing'
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
                    : f.label === 'Downswing'
                      ? 'bg-amber-200'
                      : f.label === 'Impact'
                        ? 'bg-rose-300'
                        : 'bg-slate-300'
                }`}
              />
              {f.label}
            </span>
          ))}
          {addressFrame ? (
            <div className="ml-2 inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('overlay')}
                className={`rounded-full px-2 py-1 text-[11px] ${
                  viewMode === 'overlay' ? 'bg-slate-200/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                重ね
              </button>
              <button
                type="button"
                onClick={() => setViewMode('address')}
                className={`rounded-full px-2 py-1 text-[11px] ${
                  viewMode === 'address' ? 'bg-slate-200/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Address
              </button>
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
              className={`absolute inset-0 h-full w-full object-contain ${viewMode === 'overlay' ? 'mix-blend-screen' : 'mix-blend-normal'}`}
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
            {/* On-plane zone (shoulder/hip wedge or band around reference line) */}
            {props.zoneUpperPoint && props.zoneLowerPoint && props.zoneAnchor ? (
              (() => {
                const isUnstable = !!props.zoneUnstable;
                const anchor01 = props.zoneAnchor;
                const upper01 = props.zoneUpperPoint;
                const lower01 = props.zoneLowerPoint;
                if (!anchor01 || !upper01 || !lower01) return null;
                const anchorUse = {
                  x: clamp(anchor01.x, 0, 1) * 100,
                  y: clamp(anchor01.y, 0, 1) * viewBoxHeight,
                };
                const upperUse = {
                  x: clamp(upper01.x, 0, 1) * 100,
                  y: clamp(upper01.y, 0, 1) * viewBoxHeight,
                };
                const lowerUse = {
                  x: clamp(lower01.x, 0, 1) * 100,
                  y: clamp(lower01.y, 0, 1) * viewBoxHeight,
                };
                const norm = (dx: number, dy: number) => {
                  const len = Math.hypot(dx, dy);
                  if (!Number.isFinite(len) || len < 1e-6) return null;
                  return { x: dx / len, y: dy / len };
                };
                const dirUpper = norm(upperUse.x - anchorUse.x, upperUse.y - anchorUse.y);
                const dirLower = norm(lowerUse.x - anchorUse.x, lowerUse.y - anchorUse.y);
                if (!dirUpper || !dirLower) return null;

                const rayToBox = (x0: number, y0: number, vx: number, vy: number): { x: number; y: number } | null => {
                  const eps = 1e-6;
                  const candidates: Array<{ t: number; x: number; y: number }> = [];

                  if (Math.abs(vx) > eps) {
                    const tLeft = (0 - x0) / vx;
                    const yLeft = y0 + tLeft * vy;
                    if (tLeft >= 0 && yLeft >= 0 && yLeft <= viewBoxHeight) candidates.push({ t: tLeft, x: 0, y: yLeft });
                    const tRight = (100 - x0) / vx;
                    const yRight = y0 + tRight * vy;
                    if (tRight >= 0 && yRight >= 0 && yRight <= viewBoxHeight) candidates.push({ t: tRight, x: 100, y: yRight });
                  }
                  if (Math.abs(vy) > eps) {
                    const tTop = (0 - y0) / vy;
                    const xTop = x0 + tTop * vx;
                    if (tTop >= 0 && xTop >= 0 && xTop <= 100) candidates.push({ t: tTop, x: xTop, y: 0 });
                    const tBottom = (viewBoxHeight - y0) / vy;
                    const xBottom = x0 + tBottom * vx;
                    if (tBottom >= 0 && xBottom >= 0 && xBottom <= 100) candidates.push({ t: tBottom, x: xBottom, y: viewBoxHeight });
                  }
                  if (!candidates.length) return null;
                  candidates.sort((a, b) => a.t - b.t);
                  return { x: candidates[0]!.x, y: candidates[0]!.y };
                };

                const endUpper = rayToBox(anchorUse.x, anchorUse.y, dirUpper.x, dirUpper.y);
                const endLower = rayToBox(anchorUse.x, anchorUse.y, dirLower.x, dirLower.y);
                if (!endUpper || !endLower) return null;

                const centerDir = norm((dirUpper.x + dirLower.x) / 2, (dirUpper.y + dirLower.y) / 2);
                const endCenter = centerDir ? rayToBox(anchorUse.x, anchorUse.y, centerDir.x, centerDir.y) : null;
                const poly = `${anchorUse.x},${anchorUse.y} ${endUpper.x},${endUpper.y} ${endLower.x},${endLower.y}`;

                const zoneFill = isUnstable ? 'rgba(253,230,138,0.12)' : 'rgba(253,230,138,0.18)';
                const centerStroke = isUnstable ? 'rgba(226,232,240,0.18)' : 'rgba(226,232,240,0.26)';
                const blueEdge = isUnstable ? 'rgba(59,130,246,0.35)' : 'rgba(59,130,246,0.55)';
                const redEdge = isUnstable ? 'rgba(244,63,94,0.32)' : 'rgba(244,63,94,0.52)';

                return (
                  <>
                    <polygon points={poly} fill={zoneFill} />
                    {endCenter ? (
                      <line
                        x1={anchorUse.x}
                        y1={anchorUse.y}
                        x2={endCenter.x}
                        y2={endCenter.y}
                        stroke={centerStroke}
                        strokeWidth="1.2"
                        strokeDasharray="4 3"
                        strokeLinecap="round"
                      />
                    ) : null}
                    <line
                      x1={anchorUse.x}
                      y1={anchorUse.y}
                      x2={endUpper.x}
                      y2={endUpper.y}
                      stroke={blueEdge}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                    <line
                      x1={anchorUse.x}
                      y1={anchorUse.y}
                      x2={endLower.x}
                      y2={endLower.y}
                      stroke={redEdge}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </>
                );
              })()
            ) : props.referencePlane ? (
              <>
                {(() => {
                  const thetaDeg = Number.isFinite(props.zoneThetaDeg as number) ? clamp(Number(props.zoneThetaDeg), 4, 20) : 10;
                  const isUnstable = !!props.zoneUnstable;

                  const p = props.referencePlane!;
                  const x1 = p.x1 * 100;
                  const y1 = p.y1 * viewBoxHeight;
                  const x2 = p.x2 * 100;
                  const y2 = p.y2 * viewBoxHeight;
                  const dx = x2 - x1;
                  const dy = y2 - y1;
                  const l = Math.hypot(dx, dy);
                  if (!Number.isFinite(l) || l < 1e-6) return null;

                  // Orient the zone "upwards" from the anchor (towards smaller y) to match typical address-plane visualization.
                  let ux = dx / l;
                  let uy = dy / l;
                  if (uy > 0) {
                    ux *= -1;
                    uy *= -1;
                  }
                  const ang = (thetaDeg * Math.PI) / 180;
                  const rot = (vx: number, vy: number, a: number) => ({
                    x: vx * Math.cos(a) - vy * Math.sin(a),
                    y: vx * Math.sin(a) + vy * Math.cos(a),
                  });

                  const anchor = props.referencePlaneEvidence
                    ? {
                        x: ((props.referencePlaneEvidence.x1 + props.referencePlaneEvidence.x2) / 2) * 100,
                        y: ((props.referencePlaneEvidence.y1 + props.referencePlaneEvidence.y2) / 2) * viewBoxHeight,
                      }
                    : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };

                  const anchor01 = props.zoneAnchor ?? null;
                  const anchorUse = anchor01
                    ? { x: clamp(anchor01.x, 0, 1) * 100, y: clamp(anchor01.y, 0, 1) * viewBoxHeight }
                    : anchor;
                  const upper01 = props.zoneUpperPoint ?? null;
                  const upperUse = upper01
                    ? { x: clamp(upper01.x, 0, 1) * 100, y: clamp(upper01.y, 0, 1) * viewBoxHeight }
                    : null;

                  // Ray-box intersection from anchor (t >= 0), returning the nearest boundary hit.
                  const rayToBox = (x0: number, y0: number, vx: number, vy: number): { x: number; y: number } | null => {
                    const eps = 1e-6;
                    const candidates: Array<{ t: number; x: number; y: number }> = [];

                    if (Math.abs(vx) > eps) {
                      const tLeft = (0 - x0) / vx;
                      const yLeft = y0 + tLeft * vy;
                      if (tLeft >= 0 && yLeft >= 0 && yLeft <= viewBoxHeight) candidates.push({ t: tLeft, x: 0, y: yLeft });
                      const tRight = (100 - x0) / vx;
                      const yRight = y0 + tRight * vy;
                      if (tRight >= 0 && yRight >= 0 && yRight <= viewBoxHeight) candidates.push({ t: tRight, x: 100, y: yRight });
                    }
                    if (Math.abs(vy) > eps) {
                      const tTop = (0 - y0) / vy;
                      const xTop = x0 + tTop * vx;
                      if (tTop >= 0 && xTop >= 0 && xTop <= 100) candidates.push({ t: tTop, x: xTop, y: 0 });
                      const tBottom = (viewBoxHeight - y0) / vy;
                      const xBottom = x0 + tBottom * vx;
                      if (tBottom >= 0 && xBottom >= 0 && xBottom <= 100) candidates.push({ t: tBottom, x: xBottom, y: viewBoxHeight });
                    }
                    if (!candidates.length) return null;
                    candidates.sort((a, b) => a.t - b.t);
                    return { x: candidates[0]!.x, y: candidates[0]!.y };
                  };

                  const dirMinus = rot(ux, uy, -ang);
                  const dirPlus = rot(ux, uy, ang);

                  const signedDelta = (() => {
                    if (!upperUse) return null;
                    const baseAng = Math.atan2(uy, ux);
                    const vAng = Math.atan2(upperUse.y - anchorUse.y, upperUse.x - anchorUse.x);
                    return Math.atan2(Math.sin(vAng - baseAng), Math.cos(vAng - baseAng));
                  })();
                  // Ensure upper boundary (towards address shoulder) is blue.
                  const blueDir = signedDelta != null && signedDelta > 0 ? dirPlus : dirMinus;
                  const redDir = signedDelta != null && signedDelta > 0 ? dirMinus : dirPlus;

                  const endBlue = rayToBox(anchorUse.x, anchorUse.y, blueDir.x, blueDir.y);
                  const endRed = rayToBox(anchorUse.x, anchorUse.y, redDir.x, redDir.y);
                  const endCenter = rayToBox(anchorUse.x, anchorUse.y, ux, uy);
                  if (!endBlue || !endRed) return null;
                  const poly = `${anchorUse.x},${anchorUse.y} ${endBlue.x},${endBlue.y} ${endRed.x},${endRed.y}`;

                  // Match the classic visualization: yellow zone between blue/red boundary rays.
                  const zoneFill = isUnstable ? 'rgba(253,230,138,0.12)' : 'rgba(253,230,138,0.18)';
                  const centerStroke = isUnstable ? 'rgba(226,232,240,0.18)' : 'rgba(226,232,240,0.26)';
                  const blueEdge = isUnstable ? 'rgba(59,130,246,0.35)' : 'rgba(59,130,246,0.55)';
                  const redEdge = isUnstable ? 'rgba(244,63,94,0.32)' : 'rgba(244,63,94,0.52)';

                  return (
                    <>
                      <polygon points={poly} fill={zoneFill} />
                      {endCenter ? (
                        <line
                          x1={anchorUse.x}
                          y1={anchorUse.y}
                          x2={endCenter.x}
                          y2={endCenter.y}
                          stroke={centerStroke}
                          strokeWidth="1.2"
                          strokeDasharray="4 3"
                          strokeLinecap="round"
                        />
                      ) : null}
                      <line
                        x1={anchorUse.x}
                        y1={anchorUse.y}
                        x2={endBlue.x}
                        y2={endBlue.y}
                        stroke={blueEdge}
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                      <line
                        x1={anchorUse.x}
                        y1={anchorUse.y}
                        x2={endRed.x}
                        y2={endRed.y}
                        stroke={redEdge}
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </>
                  );
                })()}
              </>
            ) : props.deviations ? (
              (() => {
                const scale = (cm: number) => clamp(cm * 2.2, -18, 18);
                const p0 = { x: 18, y: viewBoxHeight * 0.21 };
                const p1 = { x: 52, y: viewBoxHeight * 0.53 };
                const p2 = { x: 88, y: viewBoxHeight * 0.92 };
                const base = `M ${p0.x} ${p0.y} Q ${p1.x} ${p1.y} ${p2.x} ${p2.y}`;
                const path = `M ${p0.x + scale(props.deviations.top)} ${p0.y} Q ${p1.x + scale(props.deviations.late)} ${p1.y} ${p2.x + scale(props.deviations.impact)} ${p2.y}`;
                const trajStroke =
                  'rgba(253, 230, 138, 0.92)';
                return (
                  <>
                    <path d={base} stroke="rgba(148,163,184,0.55)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
                    <path d={path} stroke={trajStroke} strokeWidth="1.6" fill="none" strokeLinecap="round" />

                    {/* Legend */}
                    <g>
                      <rect x="70" y={Math.max(4.5, viewBoxHeight - 7.6)} width="28" height="5.6" rx="1.8" fill="rgba(2,6,23,0.55)" />
                      <g transform={`translate(71.5, ${Math.max(5.8, viewBoxHeight - 6.3)})`}>
                        <circle cx="1.2" cy="1.6" r="0.9" fill="rgba(148,163,184,0.75)" />
                        <text x="3.1" y="2.45" fontSize="1.9" fill="rgba(226,232,240,0.92)">
                          ゾーン
                        </text>
                        <circle cx="14.2" cy="1.6" r="0.9" fill={trajStroke} />
                        <text x="16.1" y="2.45" fontSize="1.9" fill="rgba(226,232,240,0.92)">
                          手元
                        </text>
                      </g>
                    </g>
                  </>
                );
              })()
            ) : null}

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
                <g>
                  {ball ? dot(ball, 'rgba(241,245,249,0.95)', 'rgba(2,6,23,0.65)') : null}
                  {club ? dot(club, 'rgba(253,230,138,0.95)', 'rgba(2,6,23,0.65)') : null}
                  {grip ? dot(grip, 'rgba(52,211,153,0.95)', 'rgba(2,6,23,0.65)') : null}
                  {shoulder ? dot(shoulder, 'rgba(125,211,252,0.95)', 'rgba(2,6,23,0.65)') : null}
                  {hip ? dot(hip, 'rgba(248,113,113,0.92)', 'rgba(2,6,23,0.65)') : null}
                </g>
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
                      ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1), phase: (p.phase ?? '').toLowerCase() }
                      : null,
                  )
                  .filter((p): p is { x: number; y: number; phase: string } => !!p) ?? [];

              const allPts = tracePts.length >= 2 ? tracePts : pts.map((p) => ({ ...p, phase: '' }));
              if (allPts.length < 2) return null;

              const backswingPts = tracePts.filter((p) => p.phase.includes('top') || p.phase.includes('back'));
              const downswingPts = tracePts.filter((p) => p.phase.includes('down'));
              const fallbackBackPts = top && down ? [top, down] : null;
              const fallbackDownPts = down && impact ? [down, impact] : null;

              // Zone membership (downswing only). Uses the same definition as backend: angle band around reference line.
              const zoneMeta = (() => {
                const line = props.referencePlane ?? null;
                if (!line) return null;
                const dx = line.x2 - line.x1;
                const dy = line.y2 - line.y1;
                const len = Math.hypot(dx, dy);
                if (!Number.isFinite(len) || len < 1e-6) return null;
                const ux = dx / len;
                const uy = dy / len;
                const baseAng = Math.atan2(uy, ux);
                const thetaDeg = Number.isFinite(props.zoneThetaDeg as number) ? clamp(Number(props.zoneThetaDeg), 4, 20) : 10;
                const thetaRad = (thetaDeg * Math.PI) / 180;
                const anchor =
                  props.zoneAnchor ??
                  (hp?.downswing ?? null) ??
                  (hp?.impact ?? null) ??
                  (hp?.top ?? null) ??
                  ({ x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 } as { x: number; y: number });
                return { baseAng, thetaRad, ux, uy, anchor };
              })();

              const wrapAngleRad = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
              const isInZone = (p: { x: number; y: number }) => {
                if (!zoneMeta) return null;
                const vx = p.x - zoneMeta.anchor.x;
                const vy = p.y - zoneMeta.anchor.y;
                const vl = Math.hypot(vx, vy);
                if (!Number.isFinite(vl) || vl < 1e-6) return true;
                const ang = Math.atan2(vy, vx);
                const d = Math.abs(wrapAngleRad(ang - zoneMeta.baseAng));
                return d <= zoneMeta.thetaRad;
              };

              const toPath = (points: Array<{ x: number; y: number }>) =>
                points.map((p) => `${p.x * 100} ${p.y * viewBoxHeight}`).join(' L ');

              const buildClassifiedPaths = (points: Array<{ x: number; y: number }>) => {
                if (points.length < 2) return { inside: [] as string[], outside: [] as string[] };
                const inside: string[] = [];
                const outside: string[] = [];
                let current: Array<{ x: number; y: number }> = [];
                let currentInside: boolean | null = null;
                let prev = points[0]!;
                const firstInside = isInZone(prev) ?? true;
                currentInside = firstInside;
                current = [prev];
                for (let i = 1; i < points.length; i += 1) {
                  const next = points[i]!;
                  const nextInside = isInZone(next) ?? currentInside ?? true;
                  if (nextInside === currentInside) {
                    current.push(next);
                  } else {
                    const path = toPath(current);
                    if (currentInside) inside.push(path);
                    else outside.push(path);
                    currentInside = nextInside;
                    current = [prev, next];
                  }
                  prev = next;
                }
                const lastPath = toPath(current);
                if (currentInside) inside.push(lastPath);
                else outside.push(lastPath);
                return { inside, outside };
              };

              const fullPath = tracePts.length >= 2 ? toPath(tracePts) : null;
              const backPath =
                backswingPts.length >= 2 ? toPath(backswingPts) : fallbackBackPts ? toPath(fallbackBackPts) : null;
              const downPaths =
                downswingPts.length >= 2
                  ? buildClassifiedPaths(downswingPts.map((p) => ({ x: p.x, y: p.y })))
                  : null;
              const fallbackDownPath = !downPaths && fallbackDownPts ? toPath(fallbackDownPts) : null;

              return (
                <>
                  {fullPath ? (
                    <path d={`M ${fullPath}`} stroke="rgba(226,232,240,0.12)" strokeWidth="1.0" fill="none" strokeLinecap="round" />
                  ) : null}
                  {backPath ? (
                    <path d={`M ${backPath}`} stroke="rgba(125, 211, 252, 0.75)" strokeWidth="2.1" fill="none" strokeLinecap="round" />
                  ) : null}
                  {downPaths ? (
                    <>
                      {downPaths.outside.map((p, idx) => (
                        <path key={`ds-out-${idx}`} d={`M ${p}`} stroke="rgba(253, 230, 138, 0.28)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                      ))}
                      {downPaths.inside.map((p, idx) => (
                        <path key={`ds-in-${idx}`} d={`M ${p}`} stroke="rgba(253, 230, 138, 0.96)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                      ))}
                    </>
                  ) : downswingPts.length >= 2 ? (
                    <path d={`M ${toPath(downswingPts)}`} stroke="rgba(253, 230, 138, 0.96)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                  ) : fallbackDownPath ? (
                    <path d={`M ${fallbackDownPath}`} stroke="rgba(253, 230, 138, 0.96)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                  ) : null}
                  {top ? <circle cx={top.x * 100} cy={top.y * viewBoxHeight} r="1.3" fill="rgba(125, 211, 252, 0.95)" /> : null}
                  {down ? <circle cx={down.x * 100} cy={down.y * viewBoxHeight} r="1.3" fill="rgba(253, 230, 138, 0.95)" /> : null}
                  {impact ? <circle cx={impact.x * 100} cy={impact.y * viewBoxHeight} r="1.3" fill="rgba(251, 113, 133, 0.95)" /> : null}
                </>
              );
            })()}

            {/* Legend (place away from top phase tabs) */}
            <g>
              <rect x="40" y={Math.max(4.5, viewBoxHeight - 7.6)} width="58" height="5.6" rx="1.8" fill="rgba(2,6,23,0.55)" />
                <g transform={`translate(57.5, ${Math.max(5.8, viewBoxHeight - 6.3)})`}>
                  <g transform="translate(-16.5, 0)">
                  <rect x="0.2" y="0.6" width="7" height="2.0" rx="0.7" fill="rgba(56,189,248,0.18)" stroke="rgba(56,189,248,0.45)" strokeWidth="0.2" />
                  <text x="8.6" y="2.45" fontSize="1.75" fill="rgba(226,232,240,0.92)">
                    ゾーン
                  </text>
                  <line x1="20" y1="1.6" x2="26" y2="1.6" stroke="rgba(125, 211, 252, 0.75)" strokeWidth="1.3" strokeLinecap="round" />
                  <text x="27.8" y="2.45" fontSize="1.75" fill="rgba(226,232,240,0.92)">
                    Back
                  </text>
                  <line x1="39.8" y1="1.6" x2="45.8" y2="1.6" stroke="rgba(253, 230, 138, 0.92)" strokeWidth="1.8" strokeLinecap="round" />
                  <text x="47.6" y="2.45" fontSize="1.75" fill="rgba(226,232,240,0.92)">
                    Down
                  </text>
                </g>
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

const resolvePlaneEvidenceLine = (onPlaneData: unknown, which: 'backswing' | 'downswing'): PlaneLine01 | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const candidates =
    which === 'backswing'
      ? [
          obj.backswing_plane_evidence,
          obj.backswingPlaneEvidence,
          obj.back_plane_evidence,
          obj.backPlaneEvidence,
          getObj(obj.visual)?.backswing_plane_evidence,
          getObj(obj.visual)?.backswingPlaneEvidence,
        ]
      : [
          obj.reference_plane_evidence,
          obj.referencePlaneEvidence,
          obj.downswing_plane_evidence,
          obj.downswingPlaneEvidence,
          obj.down_plane_evidence,
          obj.downPlaneEvidence,
          getObj(obj.visual)?.downswing_plane_evidence,
          getObj(obj.visual)?.downswingPlaneEvidence,
        ];
  for (const c of candidates) {
    const line = normalizePlaneLine01(c);
    if (line) return line;
  }
  return null;
};

const resolvePlaneConfidence = (onPlaneData: unknown): 'high' | 'medium' | 'low' | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const c = obj.plane_confidence ?? obj.planeConfidence;
  if (c === 'high' || c === 'medium' || c === 'low') return c;
  return null;
};

const resolveZoneThetaDeg = (onPlaneData: unknown): number | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const n = readNumber(obj.zone_theta_deg ?? obj.zoneThetaDeg ?? getObj(obj.visual)?.zone_theta_deg ?? getObj(obj.visual)?.zoneThetaDeg);
  if (n == null) return null;
  return clamp(n, 4, 20);
};

type OnPlaneZoneEval = {
  on_plane_rating: 'A' | 'B' | 'C' | 'D';
  zone_stay_ratio: string;
  primary_deviation: 'outside' | 'inside' | 'none';
  key_observation: string;
  coaching_comment: string;
};

const resolveZoneEval = (onPlaneData: unknown): OnPlaneZoneEval | null => {
  const obj = getObj(onPlaneData);
  if (!obj) return null;
  const rating = readString(obj.on_plane_rating ?? obj.onPlaneRating);
  const zoneStay = readString(obj.zone_stay_ratio ?? obj.zoneStayRatio);
  const primary = readString(obj.primary_deviation ?? obj.primaryDeviation);
  const keyObs = readString(obj.key_observation ?? obj.keyObservation);
  const coach = readString(obj.coaching_comment ?? obj.coachingComment);
  if (!(rating === 'A' || rating === 'B' || rating === 'C' || rating === 'D')) return null;
  if (!zoneStay || !(primary === 'outside' || primary === 'inside' || primary === 'none')) return null;
  if (!keyObs || !coach) return null;
  return { on_plane_rating: rating, zone_stay_ratio: zoneStay, primary_deviation: primary, key_observation: keyObs, coaching_comment: coach };
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

const resolveHandTrace = (onPlaneData: unknown): Array<{ x: number; y: number; phase?: string }> | null => {
  const obj = getObj(onPlaneData);
  const raw = obj?.hand_trace ?? obj?.handTrace;
  if (!Array.isArray(raw)) return null;
  const out: Array<{ x: number; y: number; phase?: string }> = [];
  for (const entry of raw) {
    const e = getObj(entry);
    if (!e) continue;
    const x = readNumber(e.x);
    const y = readNumber(e.y);
    if (x == null || y == null) continue;
    const to01 = (n: number) => (Math.abs(n) > 1.5 ? n / 100 : n);
    out.push({ x: clamp(to01(x), 0, 1), y: clamp(to01(y), 0, 1), phase: readString(e.phase) ?? undefined });
  }
  return out.length ? out : null;
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
  const { onPlaneData, isPro, overlayFrames } = props;
  const score = resolveScore100(onPlaneData);
  const tone = resolveTone(score ?? 0);
  const toneClass = toneClasses(tone);

  const summary = resolveSummary(onPlaneData);
  const downswingPlaneRaw = resolvePlaneLine(onPlaneData, 'downswing');
  const downswingPlaneEvidenceRaw = resolvePlaneEvidenceLine(onPlaneData, 'downswing');
  const handPointsRaw = resolveHandPoints(onPlaneData);
  const handTraceRaw = resolveHandTrace(onPlaneData);
  const zoneAnchorRaw = resolveZoneAnchorPoint(onPlaneData);
  const shoulderRaw = resolveAddressShoulderPoint(onPlaneData);
  const hipRaw = resolveAddressHipPoint(onPlaneData);
  const addressLandmarksRaw = resolveAddressLandmarks(onPlaneData);
  const zoneEval = resolveZoneEval(onPlaneData);
  const zoneThetaDeg = resolveZoneThetaDeg(onPlaneData) ?? null;

  // Display heuristic:
  // If extracted shaft-vector lines consistently tilt "right-up -> left-down" (negative slope),
  // flip X for visualization so the plane aligns with the most common DTL expectation (left-up -> right-down).
  // This does NOT change stored data; it only affects rendering.
  const shouldFlipX = (() => {
    if (addressLandmarksRaw?.ball && addressLandmarksRaw?.grip) {
      const ballX = addressLandmarksRaw.ball.x;
      const gripX = addressLandmarksRaw.grip.x;
      if (Number.isFinite(ballX) && Number.isFinite(gripX) && Math.abs(ballX - gripX) > 0.05) {
        // In DTL, grip should be left of ball; if reversed, flip X.
        return gripX > ballX;
      }
    }
    const l = downswingPlaneRaw;
    if (!l) return false;
    const dx = lineDx(l);
    const dy = lineDy(l);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    // If mostly vertical, don't flip.
    if (Math.abs(dx) < 0.02) return false;
    // Treat dy positive as "downwards". If dx is negative with dy positive -> negative slope.
    return dy >= 0 ? dx < 0 : dx > 0;
  })();

  const downswingPlane = downswingPlaneRaw ? (shouldFlipX ? flipXLine(downswingPlaneRaw) : downswingPlaneRaw) : null;
  const downswingPlaneEvidence = downswingPlaneEvidenceRaw
    ? shouldFlipX
      ? flipXLine(downswingPlaneEvidenceRaw)
      : downswingPlaneEvidenceRaw
    : null;
  const handPoints = (() => {
    if (!handPointsRaw) return null;
    if (!shouldFlipX) return handPointsRaw;
    return {
      top: handPointsRaw.top ? flipXPoint01(handPointsRaw.top) : null,
      downswing: handPointsRaw.downswing ? flipXPoint01(handPointsRaw.downswing) : null,
      impact: handPointsRaw.impact ? flipXPoint01(handPointsRaw.impact) : null,
    };
  })();
  const handTrace = (() => {
    if (!handTraceRaw) return null;
    if (!shouldFlipX) return handTraceRaw;
    return handTraceRaw.map((p) => ({ ...p, x: 1 - p.x }));
  })();
  const zoneAnchorPoint = (() => {
    if (!zoneAnchorRaw) return null;
    if (!shouldFlipX) return zoneAnchorRaw;
    return { x: 1 - zoneAnchorRaw.x, y: zoneAnchorRaw.y };
  })();
  const zoneUpperPoint = (() => {
    if (!shoulderRaw) return null;
    if (!shouldFlipX) return shoulderRaw;
    return { x: 1 - shoulderRaw.x, y: shoulderRaw.y };
  })();
  const zoneLowerPoint = (() => {
    if (!hipRaw) return null;
    if (!shouldFlipX) return hipRaw;
    return { x: 1 - hipRaw.x, y: hipRaw.y };
  })();
  const addressLandmarks = (() => {
    if (!addressLandmarksRaw) return null;
    if (!shouldFlipX) return addressLandmarksRaw;
    const flip = (p: { x: number; y: number } | null | undefined) => (p ? { x: 1 - p.x, y: p.y } : null);
    return {
      clubhead: flip(addressLandmarksRaw.clubhead),
      grip: flip(addressLandmarksRaw.grip),
      ball: flip(addressLandmarksRaw.ball),
      shoulder: flip(addressLandmarksRaw.shoulder),
      hip: flip(addressLandmarksRaw.hip),
    };
  })();
  const planeConfidence = resolvePlaneConfidence(onPlaneData);
  const hasPlaneEvidence = !!downswingPlaneEvidence;
  const zoneUnstable = !!downswingPlane && !((planeConfidence === 'high' || planeConfidence === 'medium') || hasPlaneEvidence);

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

  return (
    <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">オンプレーン診断</h2>
          <p className="text-xs text-slate-400 mt-1">手元（グリップ中心）のダウンスイング軌道が、参照プレーンのゾーン内をどれだけ通過できているか</p>
        </div>
        {typeof score === 'number' ? (
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] ring-1 ${toneClass.ring} ${toneClass.bg} ${toneClass.text}`}>
            {tone === 'green' ? '良好' : tone === 'yellow' ? '要調整' : '要改善'}
          </span>
        ) : null}
      </div>

      {!isPro ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <p className={`text-4xl font-bold tracking-tight tabular-nums ${toneClass.text}`}>
                {typeof score === 'number' ? score : '--'}
                <span className="text-base font-semibold text-slate-300 ml-1">点</span>
              </p>
            </div>
          </div>
          <p className="text-sm text-slate-200">{freeOneLiner}</p>
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
            <div className="flex items-baseline gap-3">
              <p className={`text-4xl font-bold tracking-tight tabular-nums ${toneClass.text}`}>
                {typeof score === 'number' ? score : '--'}
                <span className="text-base font-semibold text-slate-300 ml-1">点</span>
              </p>
              {typeof score === 'number' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">グレード</span>
                  <span className="rounded-full border border-slate-700 bg-slate-950/40 px-2 py-1 text-xs font-semibold text-slate-100">
                    {resolveGrade(score)}
                  </span>
                </div>
              ) : null}
            </div>

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

          {zoneEval ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <p className="text-xs text-slate-400">ゾーン評価（ダウンスイング）</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-slate-700 bg-slate-950/30 px-2 py-1 text-xs font-semibold text-slate-100">
                  {zoneEval.on_plane_rating}
                </span>
                <span className="text-xs text-slate-300">
                  {zoneEval.on_plane_rating === 'A'
                    ? 'オンプレーン'
                    : zoneEval.on_plane_rating === 'B'
                      ? 'ややアウトサイド傾向'
                      : zoneEval.on_plane_rating === 'C'
                        ? 'アウトサイドイン傾向'
                        : 'インサイド過多'}
                </span>
                <span className="text-xs text-slate-400">・</span>
                <span className="text-xs text-slate-300">ゾーン内滞在率 {zoneEval.zone_stay_ratio}</span>
                <span className="text-xs text-slate-400">・</span>
                <span className="text-xs text-slate-300">
                  最大逸脱{' '}
                  {zoneEval.primary_deviation === 'none'
                    ? 'なし'
                    : zoneEval.primary_deviation === 'outside'
                      ? '外側'
                      : '内側'}
                </span>
              </div>
              <p className="text-sm text-slate-200 mt-2">{zoneEval.key_observation}</p>
              <p className="text-sm text-slate-200 mt-1">{zoneEval.coaching_comment}</p>
            </div>
          ) : null}

          {overlayFrames?.length ? (
            <div className="w-full">
              <OnPlaneFrameOverlay
                frames={overlayFrames}
                tone={tone}
                referencePlane={downswingPlane}
                referencePlaneEvidence={downswingPlaneEvidence}
                zoneThetaDeg={zoneThetaDeg}
                zoneAnchor={zoneAnchorPoint ?? handPoints?.downswing ?? handPoints?.impact ?? handPoints?.top ?? null}
                zoneUpperPoint={zoneUpperPoint}
                zoneLowerPoint={zoneLowerPoint}
                zoneUnstable={zoneUnstable}
                addressLandmarks={addressLandmarks}
                handPoints={handPoints}
                handTrace={handTrace ?? undefined}
                deviations={
                  typeof top === 'number' && typeof late === 'number' && typeof impact === 'number'
                    ? { top, late, impact }
                    : null
                }
              />
            </div>
          ) : null}

          {zoneUnstable && (
            <p className="text-[11px] text-slate-400 -mt-1">
              ※ 参照ゾーンは推定が不安定なため、ガイドとして表示しています（評価はゾーン内滞在で行います）。
            </p>
          )}

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs text-slate-400">フェーズ別ズレ内訳</p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Top → Downswing</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof top === 'number' ? `${sign(top)}${top.toFixed(1)}cm` : '--'}
                </p>
                {typeof top === 'number' ? <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(top)}</p> : null}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Downswing後半</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof late === 'number' ? `${sign(late)}${late.toFixed(1)}cm` : '--'}
                </p>
                {typeof late === 'number' ? <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(late)}</p> : null}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <p className="text-[11px] text-slate-400">Impact</p>
                <p className="text-lg font-semibold tabular-nums text-slate-100 mt-1">
                  {typeof impact === 'number' ? `${sign(impact)}${impact.toFixed(1)}cm` : '--'}
                </p>
                {typeof impact === 'number' ? (
                  <p className="text-[11px] text-slate-400 mt-0.5">{directionLabel(impact)}</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs text-slate-400">因果サマリ</p>
            <p className="text-sm text-slate-200 mt-2">{proCausalSummary}</p>
          </div>
        </div>
      )}
    </section>
  );
}
