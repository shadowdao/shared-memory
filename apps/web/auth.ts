import NextAuth from "next-auth";
import { env } from "@/lib/env";
import { oidClaim, resolveUserId } from "@/lib/auth/identity";
import { syncUserGroupsFromClaim } from "@/lib/auth/sync-groups";

/**
 * NextAuth (Auth.js v5) configuration.
 *
 * Uses a generic OIDC provider so any compliant identity provider works —
 * Authentik (the example we run in dev), EntraID, Keycloak, Okta, Auth0,
 * Zitadel, etc. The provider id is "oidc", which makes the callback URL
 * `/api/auth/callback/oidc`. Whichever IdP you're using needs that URL
 * registered as a redirect URI on its OAuth client.
 *
 * We store the user's OIDC `sub` + `iss` on first sign-in, upserting a row
 * in `users`. The internal user UUID lives on the JWT/session so
 * downstream code never has to re-resolve it.
 */
export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [
    {
      id: "oidc",
      name: "OIDC",
      type: "oidc",
      issuer: env().OIDC_ISSUER,
      clientId: env().OIDC_CLIENT_ID_WEB,
      clientSecret: env().OIDC_CLIENT_SECRET_WEB,
    },
  ],
  secret: env().NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
  // No custom `pages.signIn`: Auth.js serves its default provider-picker UI
  // at /api/auth/signin. Setting it to that exact path causes a redirect
  // loop because Auth.js redirects to the configured page → which is itself.
  callbacks: {
    async jwt({ token, account, profile }) {
      // On first call after sign-in, `account` + `profile` are populated.
      if (account && profile) {
        const sub = profile.sub;
        const iss = (profile.iss as string | undefined) ?? env().OIDC_ISSUER;
        if (!sub) throw new Error("OIDC profile missing `sub` claim");

        // Shared with the MCP path (lib/mcp/context.ts). On EntraID the `oid`
        // claim is what keeps the two surfaces resolving to one account —
        // `sub` differs per app registration there. See lib/auth/identity.ts.
        const userId = await resolveUserId({
          iss,
          sub,
          oid: oidClaim(profile),
          email: profile.email ?? null,
          name: profile.name ?? null,
          picture: (profile.picture as string | undefined) ?? null,
        });

        token.userId = userId;
        token.sub = sub;
        token.iss = iss;

        // Sync group memberships from the OIDC `groups` claim. Missing or
        // empty claim is treated as "user is in zero groups" — that path
        // wipes the user's existing memberships, which is the conservative
        // choice (don't keep stale grants alive if the IdP stopped
        // asserting them).
        //
        // The whole profile goes in, not just `profile.groups`: an absent
        // claim means one thing on its own and something else entirely next
        // to EntraID's overage markers, and only the second case must abort.
        // A GroupsOverageError thrown here fails the sign-in, which is the
        // intent — it leaves the user's existing memberships untouched
        // instead of silently deleting them.
        if (userId) {
          await syncUserGroupsFromClaim(userId, iss, profile);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId && typeof token.userId === "string") {
        session.user = { ...session.user, id: token.userId };
      }
      return session;
    },
  },
});

// ---------- module augmentation: typed session.user.id ----------

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

export type { Session } from "next-auth";
