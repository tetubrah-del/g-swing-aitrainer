import type { PoseMetrics, PoseTracePoint } from "@/app/lib/swing/poseMetrics";

type PoseMetricsSectionProps = {
  poseMetrics?: PoseMetrics | null;
};

const formatNumber = (value: number | null | undefined, digits = 2) => {
  if (value == null || !Number.isFinite(value)) return "--";
  const factor = Math.pow(10, digits);
  return `${Math.round(value * factor) / factor}`;
};

const formatDeg = (value: number | null | undefined) => {
  const n = formatNumber(value, 1);
  return n === "--" ? n : `${n}°`;
};

const formatNorm = (value: number | null | undefined) => {
  const n = formatNumber(value, 2);
  return n === "--" ? n : `${n}x`;
};

const buildPath = (points: PoseTracePoint[]) =>
  points
    .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x * 100} ${p.y * 100}`)
    .join(" ");

const splitTrace = (points: PoseTracePoint[]) => {
  const backswing: PoseTracePoint[] = [];
  const downswing: PoseTracePoint[] = [];
  points.forEach((p) => {
    if (p.phase === "backswing") backswing.push(p);
    else downswing.push(p);
  });
  return { backswing, downswing };
};

const labelLowerBodyLead = (lead?: PoseMetrics["metrics"]["lowerBodyLead"] | null) => {
  const status = lead?.lead ?? "unclear";
  if (status === "lower_body") return "下半身先行";
  if (status === "chest") return "胸先行";
  return "判定不能";
};

const labelHandVsChest = (handVs?: PoseMetrics["metrics"]["handVsChest"] | null) => {
  const status = handVs?.classification ?? "unclear";
  if (status === "hand_first") return "手打ち寄り";
  if (status === "torso_first") return "振り遅れ寄り";
  if (status === "mixed") return "混合";
  return "判定中";
};

export default function PoseMetricsSection(props: PoseMetricsSectionProps) {
  const poseMetrics = props.poseMetrics;
  if (!poseMetrics) return null;

  const tracePoints = Array.isArray(poseMetrics.handTrace) ? poseMetrics.handTrace : [];
  const { backswing, downswing } = splitTrace(tracePoints);
  const hasTrace = backswing.length + downswing.length >= 2;

  return (
    <section className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">MediaPipe 指標（β）</h2>
        <p className="text-[11px] text-slate-400 mt-1">LLM を使わずにポーズのみで算出しています。</p>
      </div>

      {hasTrace && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-200">手元軌道（アドレス→インパクト）</p>
            <div className="flex items-center gap-3 text-[11px] text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> BS
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-300" /> DS
              </span>
            </div>
          </div>
          <div className="relative w-full overflow-hidden rounded-lg bg-slate-900/60">
            <svg viewBox="0 0 100 100" className="h-48 w-full">
              <rect x="0" y="0" width="100" height="100" fill="transparent" />
              {backswing.length >= 2 && (
                <path d={buildPath(backswing)} stroke="#38bdf8" strokeWidth="1.8" fill="none" />
              )}
              {downswing.length >= 2 && (
                <path d={buildPath(downswing)} stroke="#fbbf24" strokeWidth="1.8" fill="none" />
              )}
              {poseMetrics.handKeypoints?.address && (
                <circle cx={poseMetrics.handKeypoints.address.x * 100} cy={poseMetrics.handKeypoints.address.y * 100} r="2.4" fill="#94a3b8" />
              )}
              {poseMetrics.handKeypoints?.top && (
                <circle cx={poseMetrics.handKeypoints.top.x * 100} cy={poseMetrics.handKeypoints.top.y * 100} r="2.4" fill="#38bdf8" />
              )}
              {poseMetrics.handKeypoints?.impact && (
                <circle cx={poseMetrics.handKeypoints.impact.x * 100} cy={poseMetrics.handKeypoints.impact.y * 100} r="2.4" fill="#fbbf24" />
              )}
            </svg>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">下半身始動</p>
          <p className="text-sm text-slate-100">{labelLowerBodyLead(poseMetrics.metrics.lowerBodyLead)}</p>
          <p className="text-[11px] text-slate-400">
            差分: {formatNumber(poseMetrics.metrics.lowerBodyLead?.deltaFrames, 0)} frames
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">手打ち / 振り遅れ</p>
          <p className="text-sm text-slate-100">{labelHandVsChest(poseMetrics.metrics.handVsChest)}</p>
          <p className="text-[11px] text-slate-400">
            進行比: {formatNumber(poseMetrics.metrics.handVsChest?.ratio, 2)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">胸回転量（Top→Impact）</p>
          <p className="text-sm text-slate-100">{formatDeg(poseMetrics.metrics.chestRotationDeg)}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">前傾維持（肩-腰角度差）</p>
          <p className="text-sm text-slate-100">{formatDeg(poseMetrics.metrics.spineTiltDeltaDeg)}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">頭のブレ（肩中心）</p>
          <p className="text-sm text-slate-100">{formatNorm(poseMetrics.metrics.headSway?.distNorm)}</p>
          <p className="text-[11px] text-slate-400">
            Δx {formatNumber(poseMetrics.metrics.headSway?.dx, 3)} / Δy {formatNumber(poseMetrics.metrics.headSway?.dy, 3)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-1">
          <p className="text-slate-300">膝のブレ</p>
          <p className="text-sm text-slate-100">{formatNorm(poseMetrics.metrics.kneeSway?.distNorm)}</p>
          <p className="text-[11px] text-slate-400">
            Δx {formatNumber(poseMetrics.metrics.kneeSway?.dx, 3)} / Δy {formatNumber(poseMetrics.metrics.kneeSway?.dy, 3)}
          </p>
        </div>
      </div>
    </section>
  );
}
