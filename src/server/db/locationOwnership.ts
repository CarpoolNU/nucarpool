import type { PrismaOrTransaction } from "./client";

/**
 * Location ownership.
 *
 * A `Location` row belongs to exactly one slot of exactly one `CarpoolSearch`.
 * It is never shared between users, and never shared between a user's own home
 * and company slots.
 *
 * `user.edit` used to "find or create" a Location by matching street, city,
 * state and streetAddress. Whoever saved a given address string first set the
 * coordinates for everyone who saved the same strings afterwards, because the
 * match ignored coordinates and there was no branch that updated them. Two
 * people on the same long street, the same campus or the same apartment block
 * collapsed onto one point — and since distance dominates `calculateScore`,
 * that is a matching bug, not a cosmetic one. It also made a user's own
 * coordinates uncorrectable: re-picking a nearby suggestion that parsed to the
 * same strings appeared to save and moved nothing.
 *
 * The rule below replaces that. Rewriting a row the caller exclusively owns is
 * safe precisely because nobody else can be looking at it.
 *
 * See src/server/db/README.md for the model.
 *
 * These helpers take `PrismaOrTransaction` rather than `PrismaClient` because
 * `user.edit` now calls them inside `prisma.$transaction`, and a transaction
 * client is not assignable to the full client. They must therefore
 * never call `$transaction` themselves.
 */

/** Every column of `Location` a profile save is responsible for. */
export type LocationFields = {
  street: string;
  city: string;
  state: string;
  streetAddress: string;
  coordLng: number;
  coordLat: number;
};

type ResolveArgs = {
  /** The caller's existing CarpoolSearch, or null when they have none yet. */
  carpoolSearchId: string | null;
  currentHomeLocationId: string | null;
  currentCompanyLocationId: string | null;
  home: LocationFields;
  company: LocationFields;
};

/**
 * True when every CarpoolSearch referencing `locationId` is `carpoolSearchId`
 * itself — i.e. rewriting the row cannot move anyone else's pin.
 *
 * `findMany` returns each CarpoolSearch once even when both of its columns
 * point at the row, so a search whose home and company are the same Location
 * comes back as a single reference. That case is disambiguated by the caller.
 */
const isExclusivelyOwnedBy = async (
  prisma: PrismaOrTransaction,
  locationId: string | null,
  carpoolSearchId: string | null,
): Promise<boolean> => {
  if (!locationId || !carpoolSearchId) {
    return false;
  }

  const referencingSearches = await prisma.carpoolSearch.findMany({
    where: {
      OR: [{ homeLocationId: locationId }, { companyLocationId: locationId }],
    },
    select: { id: true },
  });

  return (
    referencingSearches.length > 0 &&
    referencingSearches.every((search) => search.id === carpoolSearchId)
  );
};

/**
 * Returns the Location ids a profile save should point its CarpoolSearch at,
 * writing the submitted coordinates in every case.
 *
 * Updates a row in place when the caller exclusively owns it, and creates a
 * fresh one otherwise. Both branches leave the previous row referenced by
 * whoever else was using it, so no save can orphan a Location — including the
 * awkward case where a user's home and company currently point at the *same*
 * row, where home keeps it and company gets a new one.
 */
export const resolveOwnedLocations = async (
  prisma: PrismaOrTransaction,
  {
    carpoolSearchId,
    currentHomeLocationId,
    currentCompanyLocationId,
    home,
    company,
  }: ResolveArgs,
): Promise<{ homeLocationId: string; companyLocationId: string }> => {
  const [homeIsOwned, companyIsOwned] = await Promise.all([
    isExclusivelyOwnedBy(prisma, currentHomeLocationId, carpoolSearchId),
    isExclusivelyOwnedBy(prisma, currentCompanyLocationId, carpoolSearchId),
  ]);

  // Both slots pointing at one row is legal in today's data. Only one of them
  // can rewrite it — the second write would clobber the first — so home keeps
  // the row and company is given its own. Neither branch abandons it.
  const slotsShareOneRow =
    !!currentHomeLocationId &&
    currentHomeLocationId === currentCompanyLocationId;

  const homeLocationId = homeIsOwned
    ? (
        await prisma.location.update({
          where: { id: currentHomeLocationId as string },
          data: home,
        })
      ).id
    : (await prisma.location.create({ data: home })).id;

  const companyLocationId =
    companyIsOwned && !slotsShareOneRow
      ? (
          await prisma.location.update({
            where: { id: currentCompanyLocationId as string },
            data: company,
          })
        ).id
      : (await prisma.location.create({ data: company })).id;

  return { homeLocationId, companyLocationId };
};

/**
 * Location ids that no `CarpoolSearch` points at.
 *
 * Nothing creates these any more — `resolveOwnedLocations` never abandons a
 * row — but the find-or-create era left one behind on every address change,
 * and nothing has ever deleted them. Kept as a pure function so the set
 * arithmetic is tested without a database; the reads and the deletes live in
 * scripts/cleanup-orphan-locations.ts.
 *
 * `relationMode = "prisma"` means the database cannot answer this with a join
 * against a real foreign key, so both columns are gathered and diffed here.
 */
export const findOrphanLocationIds = (
  allLocationIds: readonly string[],
  references: readonly {
    homeLocationId: string | null;
    companyLocationId: string | null;
  }[],
): string[] => {
  const referenced = new Set<string>();
  for (const reference of references) {
    if (reference.homeLocationId) referenced.add(reference.homeLocationId);
    if (reference.companyLocationId) {
      referenced.add(reference.companyLocationId);
    }
  }
  return allLocationIds.filter((id) => !referenced.has(id));
};
