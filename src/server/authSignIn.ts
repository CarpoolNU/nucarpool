import type { DeployEnv } from "../utils/env/browser";

/**
 * Who is allowed to sign in, decided separately from the endpoint that asks.
 *
 * Production is Azure AD only, so the tenant decides and nothing here needs to.
 * Staging additionally offers Google (`[...nextauth].ts`), and that provider had
 * no restriction of any kind: `authOptions.callbacks` held only `session`, there
 * was no `signIn` callback anywhere in the repository, and `GoogleProvider` was
 * constructed without an `hd` hint. Any Google account on the internet could
 * therefore create a staging user — in front of a database holding 1,298 real
 * people's names, addresses, home locations and message history, copied from
 * production by SCRUM-74.
 *
 * Kept out of `src/pages/api/auth/` deliberately. Under `src/pages/` a filename
 * is also a route, so a co-located test would be compiled and served as one —
 * the same reason `pusherChannelAuth.ts` sits here rather than beside its
 * endpoint, and `scripts/check-page-routes.js` enforces it.
 */

/**
 * Domains that identify a member of the university.
 *
 * Both are live in staging today: of its 1,298 users, 1,281 are
 * `northeastern.edu` and 3 are `husky.neu.edu`. Accepting these through Google
 * is consistent with production accepting them through Azure AD — Google only
 * issues an account for an address whose mailbox the holder has verified, so a
 * `northeastern.edu` Google account means the holder controls a Northeastern
 * mailbox.
 */
export const INSTITUTIONAL_EMAIL_DOMAINS = [
  "northeastern.edu",
  "husky.neu.edu",
] as const;

/**
 * Domains accepted in staging on top of the institutional ones, for testers
 * signing in with a personal account.
 *
 * **This is the weak part of the control, and it is deliberate.** Anyone can
 * register a `gmail.com` address, so this narrows the door rather than closing
 * it. It is here because 14 real `gmail.com` accounts exist in staging and are
 * the reason the Google provider was enabled at all; excluding them would lock
 * the actual testers out of the environment on the next deploy, which is a
 * certain harm traded against an uncertain one.
 *
 * The same list appears in `email.ts`, which refuses to send staging mail
 * anywhere but `gmail.com` — so a tester on any other domain could sign in and
 * then receive no notifications, which is its own argument for keeping the two
 * in agreement.
 *
 * Tightening this to the specific tester addresses, or to addresses that
 * already exist in the database, is a strictly better control and needs a list
 * this repository should not carry. See SCRUM-344 for that decision.
 */
export const STAGING_GUEST_EMAIL_DOMAINS = ["gmail.com"] as const;

/**
 * The domain of an email address, lower-cased, or `null` if there is not
 * exactly one usable one.
 *
 * Split on the **last** `@` rather than the first, because the local part may
 * legally contain one when quoted — `"a@b"@northeastern.edu` is one address at
 * `northeastern.edu`, not two. Everything after the last `@` is the domain.
 */
export const emailDomain = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) {
    return null;
  }

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 ? domain : null;
};

export type SignInAttempt = {
  /** `account.provider` from NextAuth — `undefined` when it supplies no account. */
  provider: string | undefined;
  /** `user.email`, which is `null` for a provider that returns no address. */
  email: string | null | undefined;
  env: DeployEnv;
};

/**
 * Whether NextAuth should let this sign-in proceed.
 *
 * Only Google is gated. Azure AD is left exactly as it was, in every
 * environment, because its tenant already restricts who can authenticate and
 * because production sign-in is not a thing this change should be able to
 * break. A provider this function does not recognise is allowed for the same
 * reason — the decision to add one belongs with whoever adds it, and silently
 * refusing it would look like an outage rather than a policy.
 */
export const isSignInAllowed = ({
  provider,
  email,
  env,
}: SignInAttempt): boolean => {
  if (provider !== "google") {
    return true;
  }

  // Google is only configured when `NEXT_PUBLIC_ENV` is `staging`, so reaching
  // here in another environment means the provider list and this check
  // disagree. Refuse rather than guess: the browser.ts comment names exactly
  // this hazard — "set it in production by mistake and anyone with a Google
  // account could bypass Northeastern SSO" — and this is the second lock on
  // that door.
  if (env !== "staging") {
    return false;
  }

  if (!email) {
    return false;
  }

  const domain = emailDomain(email);
  if (!domain) {
    return false;
  }

  // Exact equality, not a suffix test: `northeastern.edu.example.com` ends with
  // an allowed domain but is not one.
  return (
    (INSTITUTIONAL_EMAIL_DOMAINS as readonly string[]).includes(domain) ||
    (STAGING_GUEST_EMAIL_DOMAINS as readonly string[]).includes(domain)
  );
};
