import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";

/**
 * Loaded on demand, not statically.
 *
 * This gate is mounted in `_app`, so anything it imports at module scope lands
 * in the chunk every page pays for. Importing the modal directly cost +143 kB of
 * shared First Load JS - it pulls in `@headlessui/react` and, through
 * `trackEvent`, `mixpanel-browser` - and charged it to `/sign-in` and `/404` as
 * well. Almost nobody renders this dialog, so it is fetched only when they do.
 *
 * `ssr: false` because the gate cannot decide anything server-side anyway: the
 * session status is "loading" during SSR, so this always renders null there.
 */
const ComplianceModal = dynamic(
  () => import("./CompliancePortal").then((mod) => mod.ComplianceModal),
  { ssr: false },
);

/**
 * Shows the terms to any signed-in user who has not accepted them, wherever they
 * enter the app.
 *
 * Mounted once in `_app`, because the previous arrangement put the modal on the
 * onboarding page alone. An already-onboarded user with no consent
 * recorded is redirected past `/profile/setup` by `index.tsx`'s
 * `getServerSideProps`, so they never saw the terms - and their next profile save
 * set the flag anyway. Mounting per-page would leave the same gap open for any
 * page somebody forgot.
 *
 * Deliberately renders nothing until `user.me` has answered. Guessing "not
 * consented" while the query is in flight would flash a blocking dialog at users
 * who have already agreed.
 */
export const ComplianceGate = () => {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";

  const { data: user } = trpc.user.me.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  if (!isAuthenticated || !user || user.licenseSigned) {
    return null;
  }

  return <ComplianceModal />;
};
