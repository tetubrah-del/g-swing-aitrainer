export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const raw = (process.env.ADMIN_EMAILS ?? "").trim();
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  return allowed.includes(normalized);
}

