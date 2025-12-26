import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { findUserByEmail, getUserById, upsertGoogleUser } from "@/app/lib/userStore";
import { buildUserUsageState } from "@/app/lib/membership";
import { recordRegistration } from "@/app/lib/referralTracking";

const getAuthSecret = () => {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "dev-nextauth-secret";
  if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) {
    console.warn("[auth] Using fallback dev secret; set NEXTAUTH_SECRET in production.");
  }
  return secret;
};

// NextAuth v5 style exports
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  trustHost: true,
  callbacks: {
    async jwt({ token, account, profile }) {
      // 初回サインイン時のみ Google 情報をトークンへセット
      if (account?.provider === "google") {
        if (profile?.email) token.email = profile.email;
        // NextAuth が sub をセットするが、念のため providerAccountId を優先
        token.sub = account.providerAccountId ?? token.sub;
      }
      return token;
    },
    async session({ session, token }) {
      const sub = typeof token.sub === "string" ? token.sub : null;
      const email = typeof token.email === "string" ? token.email : null;
      if (!session.user) session.user = {};
      session.user.email = email;
      session.user.id = sub;

      // 追加で plan/usage を載せる（存在すれば）
      if (sub) {
        const account = (await getUserById(sub)) ?? (email ? await findUserByEmail(email) : null);
        if (account) {
          const anonymousId = (account.anonymousIds ?? [])[0] ?? null;
          const usage = await buildUserUsageState({
            user: account,
            anonymousUserId: anonymousId,
          });
          session.user.plan = usage.plan;
          session.user.hasProAccess = usage.hasProAccess;
          session.user.freeAnalysisCount = usage.freeAnalysisCount;
          session.user.anonymousUserId = usage.anonymousUserId;
          session.user.entitlements = usage.entitlements;
        } else if (email) {
          // 未保存なら最小限で upsert
          const created = await upsertGoogleUser({ googleSub: sub, email, anonymousUserId: null });
          const usage = await buildUserUsageState({
            user: created,
            anonymousUserId: null,
          });
          session.user.plan = usage.plan;
          session.user.hasProAccess = usage.hasProAccess;
          session.user.freeAnalysisCount = usage.freeAnalysisCount;
          session.user.anonymousUserId = usage.anonymousUserId;
          session.user.entitlements = usage.entitlements;
        }
      }
      return session;
    },
    async signIn({ account, profile, request }) {
      if (account?.provider !== "google") return false;
      const email = typeof profile?.email === "string" ? profile.email : null;
      const profileName = typeof (profile as { name?: unknown } | null)?.name === "string" ? (profile as { name: string }).name : null;
      const googleSub = account.providerAccountId ?? null;
      if (!googleSub || !email) return false;

      const existing = (await getUserById(googleSub)) ?? (email ? await findUserByEmail(email) : null);
      const anonymousUserId =
        request?.nextUrl?.searchParams?.get("anonymousUserId") ??
        request?.cookies?.get("anonymousUserId")?.value ??
        null;

      // Upsert しておく（匿名マージは API 側で anonymousUserId を受け取ったときに実施）
      await upsertGoogleUser({
        googleSub,
        email,
        anonymousUserId: anonymousUserId ?? null,
        // Only use Google profile name for the very first create; user can edit later in Profile screen.
        nickname: existing?.nickname ? null : profileName,
      });

      // Registration tracking (new sign-up only). Incentives are intentionally not implemented here.
      if (!existing) {
        const referral = request?.cookies?.get("referral_code")?.value ?? null;
        recordRegistration({
          userId: googleSub,
          referralCode: referral && /^[A-Za-z0-9_-]{8,64}$/.test(referral) ? referral : null,
        });
      }
      return true;
    },
  },
  secret: getAuthSecret(),
});
