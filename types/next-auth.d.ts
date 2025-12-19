declare module "next-auth" {
  interface Session {
    user: {
      id?: string | null;
      email?: string | null;
      plan?: "anonymous" | "free" | "pro";
      hasProAccess?: boolean;
      freeAnalysisCount?: number | null;
      anonymousUserId?: string | null;
    };
  }
}
