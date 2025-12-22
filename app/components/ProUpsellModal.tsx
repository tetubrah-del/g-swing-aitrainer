"use client";

import Link from "next/link";

export default function ProUpsellModal(props: {
  open: boolean;
  title?: string;
  message: string;
  onClose: () => void;
  ctaHref?: string;
  ctaLabel?: string;
}) {
  if (!props.open) return null;

  const ctaHref = props.ctaHref ?? "/pricing";
  const ctaLabel = props.ctaLabel ?? "PROを見る";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={props.title ?? "PRO案内"}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-5 text-slate-100 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{props.title ?? "PROで利用できます"}</div>
            <div className="text-sm text-slate-300">{props.message}</div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md border border-slate-700 bg-slate-900/40 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
          >
            閉じる
          </button>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg border border-slate-700 bg-slate-900/30 px-3 py-2 text-sm text-slate-100 hover:border-slate-500"
          >
            今はしない
          </button>
          <Link
            href={ctaHref}
            className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            onClick={props.onClose}
          >
            {ctaLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}

