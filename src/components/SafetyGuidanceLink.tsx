import Link from "next/link";

/**
 * The one link to `/safety`, used by both moderation dialogs and the profile.
 *
 * A component rather than three `Link`s because the destination and the
 * wording are the part that has to stay the same: a user who meets this text
 * in the report dialog and again in the block dialog should recognise it as
 * the same place, and a route rename should not be able to fix two of the
 * three call sites.
 *
 * `/safety` deliberately takes no session. The page is reachable whether or
 * not the reader is signed in, because the moment someone wants it is not a
 * moment to meet a sign-in redirect.
 */
const SafetyGuidanceLink = ({ className }: { className?: string }) => (
  <Link
    href="/safety"
    className={className ?? "text-northeastern-red font-medium underline"}
  >
    Reporting, blocking and staying safe
  </Link>
);

export default SafetyGuidanceLink;
