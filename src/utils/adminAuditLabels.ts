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

/** A rendered cell: `title` carries the full id when `text` abbreviated one. */
export type AuditCell = { text: string; title?: string };

type AuditDisplay = {
  /** The Action cell. */
  label: string;
  /**
   * Which table `targetId` points at, which decides whose email the Target
   * cell names: the target itself for `"user"`, the user the target *refers
   * to* for `"report"`.
   */
  targetKind: "user" | "report";
  /**
   * The Details cell, from the row's parsed metadata and its `targetId`.
   * Returns `null` when the object does not carry what this action expects,
   * which the caller turns back into the raw stored string rather than a
   * blank cell.
   */
  describe: (
    metadata: Record<string, unknown>,
    targetId: string,
  ) => AuditCell | null;
};

/** Reads `key` only when it holds a string, so a malformed row falls back. */
const stringField = (
  metadata: Record<string, unknown>,
  key: string,
): string | null =>
  typeof metadata[key] === "string" ? (metadata[key] as string) : null;

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

const cellForId = (
  id: string,
  format: (short: string) => string,
): AuditCell => {
  const short = shortenAuditId(id);
  return short === id
    ? { text: format(short) }
    : { text: format(short), title: id };
};

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
      return permission ? { text: `Set to ${permission}` } : null;
    },
  },
  "user.admin.resolveReport": {
    label: "Report resolved",
    targetKind: "report",
    /*
     * Names the report as well as the status. Target spends this row's cell on
     * the reported user, so Details is the only place left that says which of
     * several reports about that person was resolved.
     */
    describe: (metadata, targetId) => {
      const status = stringField(metadata, "status");
      return status
        ? cellForId(targetId, (short) => `Marked ${status} · report ${short}`)
        : null;
    },
  },
};

/** `undefined` for an action this build has no wording for. */
const displayFor = (action: string): AuditDisplay | undefined =>
  DISPLAY[action as AdminAuditAction];

/** The Action cell. An unmapped action prints verbatim rather than blank. */
export const describeAuditAction = (action: string): string =>
  displayFor(action)?.label ?? action;

/** The identity columns of one `getAuditLog` row. */
export type AuditTargetRow = {
  action: string;
  /** Whatever the action acted on: a user for a permission change, a report
   *  for a resolution. */
  targetId: string;
  /**
   * The user `targetId` names or refers to, resolved server-side — the
   * report's `reportedUserId` for a resolution row. `null` when the action's
   * target is a user already, and when no report survives under `targetId`.
   */
  targetUserId: string | null;
};

/**
 * The Target cell: the person an admin's decision was about.
 *
 * `targetId` does not always name one. `resolveReport` writes a report id
 * (`router/user/admin.ts`), so for those rows the person is the report's
 * reported user, which `getAuditLog` resolves into `targetUserId`. The action
 * says which of the two ids to put a name to.
 *
 * @param resolveEmail the caller's `getAllUsers` map. Returns `null` or
 *   `undefined` for an id it does not hold — a deleted user, or one whose
 *   `email` is null, which that query filters out. Both, because it selects a
 *   column Prisma types as nullable even though its `where` excludes nulls.
 */
export const describeAuditTarget = (
  row: AuditTargetRow,
  resolveEmail: (id: string) => string | null | undefined,
): AuditCell => {
  const display = displayFor(row.action);

  // Unknown action: its target kind is unknowable, so claiming either one
  // would be a guess. The raw id is the honest answer.
  if (!display) {
    return { text: row.targetId };
  }

  const personId =
    display.targetKind === "report" ? row.targetUserId : row.targetId;

  // Only reachable for a report whose row has gone: a `"user"` target is its
  // own person. Nothing names a user here, so the report id is what is left.
  if (!personId) {
    return cellForId(row.targetId, (short) => `Report ${short}`);
  }

  const email = resolveEmail(personId);

  // Falls back on the *person's* id rather than the row's, so a report whose
  // user cannot be named stays distinguishable from one that is gone entirely.
  return email
    ? { text: email }
    : cellForId(personId, (short) => `Unknown user (${short})`);
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
  targetId: string,
): AuditCell => {
  if (!metadata) {
    return { text: "" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return { text: metadata };
  }

  // `JSON.parse` happily yields null, a string, a number or an array. Indexing
  // any of those for a field would not throw — it would silently read
  // undefined — so they are rejected here rather than inside `describe`.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { text: metadata };
  }

  return (
    displayFor(action)?.describe(
      parsed as Record<string, unknown>,
      targetId,
    ) ?? { text: metadata }
  );
};
