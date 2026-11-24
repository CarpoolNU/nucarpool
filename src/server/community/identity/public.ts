import type { StoredProfile } from "./ports";

/**
 * A profile as any community member may see it.
 *
 * **This type has no field for `userId`.** That is the enforcement mechanism,
 * not a convention: leaking the platform identity behind a handle is not a
 * matter of forgetting to delete a property, it requires adding a field to a
 * type whose name says it is public. The precedent is `publicUser.ts`'s
 * `convertCarpoolSearchToPublic`.
 */
export type PublicProfile = {
  handle: string;
  /** Month granularity. A precise join timestamp is a correlation handle. */
  memberSince: string;
};

export const toPublicProfile = (profile: StoredProfile): PublicProfile => ({
  handle: profile.handle,
  memberSince: profile.dateCreated.toISOString().slice(0, 7),
});
