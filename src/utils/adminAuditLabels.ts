import type { AdminAuditAction } from "../server/adminAuditLog";

/**
 * How one `AdminAuditLog` row is worded in the admin UI.
 *
 * `AdminAuditAction`'s values are tRPC procedure paths — deliberately, so a new
 * admin mutation needs no schema change (see `server/adminAuditLog.ts`). That
 * choice makes a display layer necessary rather than optional: without one the
 * log shows `user.admin.updateUserPermission` to a human.
 *
 * Imported as `import type`, so `@prisma/client` — which `adminAuditLog.ts`
 * imports for `Prisma.AdminAuditLogUncheckedCreateInput` — stays out of the
 * client bundle. The action strings below are written out literally for the
 * same reason; `DISPLAY`'s type is what keeps them honest.
 */
type AuditDisplay = {
  /** The Action cell. */
  label: string;
  /** Which table `targetId` points at, which decides how Target renders. */
  targetKind: "user" | "report";
  /**
   * The Details cell, from the row's parsed metadata. Returns `null` when the
   * object does not carry what this action expects, which the caller turns
   * back into the raw stored string rather than a blank cell.
   */
  describe: (metadata: Record<string, unknown>) => string | null;
};

/** Reads `key` only when it holds a string, so a malformed row falls back. */
const stringField = (
  metadata: Record<string, unknown>,
  key: string,
): string | null =>
  typeof metadata[key] === "string" ? (metadata[key] as string) : null;

/**
 * Keyed by `AdminAuditAction` rather than `string`, which is the point: adding
 * a member to that union fails `yarn tsc` here until it is given wording, so
 * the log cannot quietly start printing procedure paths again.
 */
const DISPLAY: Record<AdminAuditAction, AuditDisplay> = {
  "user.admin.updateUserPermission": {
    label: "Permission changed",
    targetKind: "user",
    describe: (metadata) => {
      const permission = stringField(metadata, "permission");
      return permission && `Set to ${permission}`;
    },
  },
  "user.admin.resolveReport": {
    label: "Report resolved",
    targetKind: "report",
    describe: (metadata) => {
      const status = stringField(metadata, "status");
      return status && `Marked ${status}`;
    },
  },
};

/** `undefined` for an action this build has no wording for. */
const displayFor = (action: string): AuditDisplay | undefined =>
  DISPLAY[action as AdminAuditAction];

/** How much of a cuid is kept when one has to be shown to a person. */
const SHORT_ID_LENGTH = 8;

/**
 * The tail of an id, because a cuid's leading characters are timestamp-derived
 * and near-identical between rows written close together — a prefix would not
 * distinguish two of them. Ids already this short are returned untouched, so
 * the ellipsis never claims a truncation that did not happen.
 */
export const shortenAuditId = (id: string): string =>
  id.length <= SHORT_ID_LENGTH ? id : `…${id.slice(-SHORT_ID_LENGTH)}`;

/** A rendered cell: `title` carries the full id when `text` abbreviated one. */
export type AuditCell = { text: string; title?: string };

const cellForId = (
  id: string,
  format: (short: string) => string,
): AuditCell => {
  const short = shortenAuditId(id);
  return short === id
    ? { text: format(short) }
    : { text: format(short), title: id };
};

/** The Action cell. An unmapped action prints verbatim rather than blank. */
export const describeAuditAction = (action: string): string =>
  displayFor(action)?.label ?? action;

/**
 * The Target cell.
 *
 * `targetId` does not always name a user: `resolveReport` writes a report id
 * (`router/user/admin.ts`), so resolving every row against the user-email map
 * left those rows printing a bare cuid. The action says which table the id
 * belongs to, so `resolvedEmail` is consulted only where it can mean anything.
 *
 * @param resolvedEmail what the caller's user-email map returned for
 *   `targetId`. Absent for a deleted user, or for a target that is not a user
 *   at all. `null` as well as `undefined`, because `getAllUsers` selects a
 *   column Prisma types as nullable even though its `where` excludes nulls.
 */
export const describeAuditTarget = (
  action: string,
  targetId: string,
  resolvedEmail: string | null | undefined,
): AuditCell => {
  const display = displayFor(action);

  // Unknown action: its target kind is unknowable, so claiming either one
  // would be a guess. The raw id is the honest answer.
  if (!display) {
    return { text: targetId };
  }

  if (display.targetKind === "report") {
    return cellForId(targetId, (short) => `Report ${short}`);
  }

  return resolvedEmail
    ? { text: resolvedEmail }
    : cellForId(targetId, (short) => `Unknown user (${short})`);
};

/**
 * The Details cell, from the row's `metadata` column — JSON this server wrote,
 * so the fallbacks guard against an older row or a newer build rather than
 * against untrusted input.
 *
 * Every failure path returns the stored string unchanged: a cell showing raw
 * JSON is worse than one showing a sentence, but far better than an empty cell
 * that hides that the row said anything at all.
 */
export const describeAuditDetails = (
  action: string,
  metadata: string | null,
): string => {
  if (!metadata) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return metadata;
  }

  // `JSON.parse` happily yields null, a string, a number or an array. Indexing
  // any of those for a field would not throw — it would silently read
  // undefined — so they are rejected here rather than inside `describe`.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return metadata;
  }

  return (
    displayFor(action)?.describe(parsed as Record<string, unknown>) ?? metadata
  );
};
