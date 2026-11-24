import type { CommunityHostPort } from "../host/CommunityHostPort";
import { ContentUnavailableError, HandleInvalidError } from "../shared/errors";
import { parseHandle } from "./domain/handle";
import type { ProfileReader, StoredProfile } from "./ports";

/**
 * Resolves a handle a viewer is allowed to look at, or refuses.
 *
 * **One implementation, two call sites**, and that is the entire reason this
 * is a free function rather than a method. The profile header is served by
 * `identity` and the profile's post list by `content`; if each enforced the
 * refusal rule itself, the two endpoints could drift and one of them would
 * eventually answer a question the other declines — which on this surface is
 * not an inconsistency but a disclosure.
 *
 * **Three refusals, one error.** A handle nobody has claimed, a handle that
 * could never be claimed, and a handle belonging to someone the viewer has a
 * block with are all `ContentUnavailableError` with the same message, which
 * transport maps to NOT_FOUND. Spec §7.2: a viewer who can tell them apart can
 * walk the handle space and learn which handles belong to people they have
 * blocked, turning a block list into a partial handle-to-person map.
 */
export const requireVisibleProfile = async (
  profiles: Pick<ProfileReader, "findByHandleNormalized">,
  host: CommunityHostPort,
  viewerUserId: string,
  rawHandle: string,
): Promise<{
  profile: StoredProfile;
  /**
   * The viewer's block counterparts, returned rather than discarded so a
   * caller that needs them next — the post list does — gets them without a
   * second host round trip.
   */
  excludeAuthorIds: readonly string[];
}> => {
  // **The same parser the claim path uses**, so `Avery` and `avery` resolve to
  // one profile. A string it refuses cannot name a stored profile, because
  // every stored handle passed through here on its way in — so an unparseable
  // handle is "no such handle" rather than a validation error. Reporting it as
  // BAD_REQUEST would be a second, distinguishable refusal on a surface whose
  // refusals are deliberately identical.
  let normalized: string;
  try {
    normalized = parseHandle(rawHandle).normalized;
  } catch (error) {
    if (error instanceof HandleInvalidError) {
      throw new ContentUnavailableError();
    }
    throw error;
  }

  const profile = await profiles.findByHandleNormalized(normalized);
  if (!profile) {
    throw new ContentUnavailableError();
  }

  // `getBlockedCounterpartIds` answers in both directions, so one check covers
  // a viewer who blocked this person and a viewer this person blocked.
  const excludeAuthorIds = await host.getBlockedCounterpartIds(viewerUserId);
  if (excludeAuthorIds.includes(profile.userId)) {
    throw new ContentUnavailableError();
  }

  return { profile, excludeAuthorIds };
};
