import SharePageClient from "./SharePageClient";

function isValidReferralCode(code: string | null | undefined): code is string {
  if (!code) return false;
  return /^[A-Za-z0-9_-]{8,64}$/.test(code);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export default async function SharePage(props: {
  params: Promise<{ analysisId: string }> | { analysisId: string };
  searchParams: Promise<{ ref?: string; s?: string; t?: string }> | { ref?: string; s?: string; t?: string };
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const ref = isValidReferralCode(searchParams?.ref) ? searchParams.ref : null;
  const initial = {
    totalScore: toNumberOrNull(searchParams?.s),
    createdAt: toNumberOrNull(searchParams?.t),
  };

  return <SharePageClient analysisId={params.analysisId} referralCode={ref} initial={initial} />;
}
