import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { findUserByEmail, getUserById, upsertGoogleUser } from "@/app/lib/userStore";
import { buildUserUsageState } from "@/app/lib/membership";

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
        }
      }
      return session;
    },
    async signIn({ account, profile, request }) {
      if (account?.provider !== "google") return false;
      const email = typeof profile?.email === "string" ? profile.email : null;
      const googleSub = account.providerAccountId ?? null;
      if (!googleSub || !email) return false;

      const anonymousUserId =
        request?.nextUrl?.searchParams?.get("anonymousUserId") ??
        request?.cookies?.get("anonymousUserId")?.value ??
        null;

      // Upsert しておく（匿名マージは API 側で anonymousUserId を受け取ったときに実施）
      await upsertGoogleUser({
        googleSub,
        email,
        anonymousUserId: anonymousUserId ?? null,
      });
      return true;
    },
  },
  // 環境変数は利用者が設定する前提
  secret: process.env.NEXTAUTH_SECRET,
});
