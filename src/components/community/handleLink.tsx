/**
 * An author's handle, as a link to their profile.
 *
 * **One component for all three places a handle appears** — the feed row, the
 * post header, and every comment — because the handle is the only identity
 * this product has and it should behave identically wherever it is read. Three
 * copies of an anchor would eventually be two copies and a `<span>`.
 *
 * It keeps the weight the plain text had, so the metadata line does not
 * suddenly read as a row of links; what the link adds is the hover and focus
 * treatment every other destination in this module uses.
 *
 * Product UI — merges into NUCarpool.
 */
import Link from "next/link";
import { profileHref } from "./profileView";

export const HandleLink = ({ handle }: { handle: string }) => (
  <Link
    href={profileHref(handle)}
    className="hover:text-northeastern-red focus-visible:outline-northeastern-red font-bold text-gray-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
  >
    {handle}
  </Link>
);
