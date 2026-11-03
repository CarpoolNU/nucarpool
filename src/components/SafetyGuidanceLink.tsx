import Link from "next/link";
import { trackLinkClicked } from "../utils/mixpanel";

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
 *
 * **`surface` is required, with no default.** The three callers are the whole
 * point of the event: a reader who opens the guidance from the report dialog
 * is in a different situation from one browsing it in their profile, and a
 * default would quietly collapse the two the first time somebody added a
 * fourth caller. Making it required costs one argument and makes the omission
 * a compile error instead of a dashboard that silently under-counts.
 */
const SafetyGuidanceLink = ({
  className,
  surface,
}: {
  className?: string;
  surface: string;
}) => (
  <Link
    href="/safety"
    className={className ?? "text-northeastern-red font-medium underline"}
    onClick={() => trackLinkClicked({ link: "safety", surface })}
  >
    Reporting, blocking and staying safe
  </Link>
);

export default SafetyGuidanceLink;
