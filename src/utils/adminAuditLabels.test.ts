import {
  describeAuditAction,
  describeAuditDetails,
  describeAuditTarget,
  shortenAuditId,
} from "./adminAuditLabels";

const PERMISSION = "user.admin.updateUserPermission";
const RESOLVE = "user.admin.resolveReport";

/** A realistic cuid — long enough that the shortening actually fires. */
const CUID = "clx3k9a0b0000qwertyuiop12";

/** A second one, so a report id and a reported user id cannot be confused. */
const USER_CUID = "clx3k9a0b0000asdfghjkl345";

/** The caller's `getAllUsers` map, as a lookup over a plain object. */
const mapOf =
  (emails: Record<string, string | null>) =>
  (id: string): string | null | undefined =>
    emails[id];

/** Nothing resolves — a map that has not loaded, or holds neither id. */
const resolvesNothing = () => undefined;

describe("describeAuditAction", () => {
  it("names each known action in words rather than its procedure path", () => {
    expect(describeAuditAction(PERMISSION)).toBe("Permission changed");
    expect(describeAuditAction(RESOLVE)).toBe("Report resolved");
  });

  it("prints an unmapped action verbatim rather than blank", () => {
    expect(describeAuditAction("user.admin.somethingNew")).toBe(
      "user.admin.somethingNew",
    );
  });
});

describe("shortenAuditId", () => {
  it("keeps the trailing characters, which are what distinguish two cuids", () => {
    expect(shortenAuditId(CUID)).toBe("…tyuiop12");
  });

  it("leaves an id short enough to read alone, with no misleading ellipsis", () => {
    expect(shortenAuditId("user-2")).toBe("user-2");
  });
});

describe("describeAuditTarget", () => {
  it("shows the email when the target is a user the map resolved", () => {
    expect(
      describeAuditTarget(
        { action: PERMISSION, targetId: "user-2", targetUserId: null },
        mapOf({ "user-2": "target@northeastern.edu" }),
      ),
    ).toEqual({ text: "target@northeastern.edu" });
  });

  it("marks an unresolvable user target rather than printing a bare id", () => {
    expect(
      describeAuditTarget(
        { action: PERMISSION, targetId: CUID, targetUserId: null },
        resolvesNothing,
      ),
    ).toEqual({ text: "Unknown user (…tyuiop12)", title: CUID });
  });

  it("names the reported user, not the report, for a report target", () => {
    // The row's id is a report's, but the person the admin's decision was
    // about is the user that report named. `getAuditLog` resolves the one to
    // the other, so this cell can say who rather than which.
    expect(
      describeAuditTarget(
        { action: RESOLVE, targetId: CUID, targetUserId: USER_CUID },
        mapOf({ [USER_CUID]: "reported@northeastern.edu" }),
      ),
    ).toEqual({ text: "reported@northeastern.edu" });
  });

  it("ignores an email the report id itself happens to resolve to", () => {
    // Only `targetUserId` names a person on a report row. A user whose id
    // collided with the report's would still not be what the row is about.
    expect(
      describeAuditTarget(
        { action: RESOLVE, targetId: CUID, targetUserId: USER_CUID },
        mapOf({ [CUID]: "collision@northeastern.edu" }),
      ),
    ).toEqual({ text: "Unknown user (…ghjkl345)", title: USER_CUID });
  });

  it("marks a reported user the map cannot name, by their own id", () => {
    // A deleted or email-less account: `getAllUsers` filters `email: null`,
    // so it is absent from the map even though the report still names it.
    expect(
      describeAuditTarget(
        { action: RESOLVE, targetId: CUID, targetUserId: USER_CUID },
        resolvesNothing,
      ),
    ).toEqual({ text: "Unknown user (…ghjkl345)", title: USER_CUID });
  });

  it("falls back to the report id when the report itself is gone", () => {
    // `targetUserId` is null only when `getAuditLog` found no report for the
    // id, so there is no user to name and the report id is all that is left.
    expect(
      describeAuditTarget(
        { action: RESOLVE, targetId: CUID, targetUserId: null },
        resolvesNothing,
      ),
    ).toEqual({ text: "Report …tyuiop12", title: CUID });
  });

  it("prints the raw id for an unmapped action, whose target kind is unknown", () => {
    expect(
      describeAuditTarget(
        {
          action: "user.admin.somethingNew",
          targetId: CUID,
          targetUserId: null,
        },
        resolvesNothing,
      ),
    ).toEqual({ text: CUID });
  });

  it("omits the title when the id was never shortened", () => {
    expect(
      describeAuditTarget(
        { action: RESOLVE, targetId: "rep-1", targetUserId: null },
        resolvesNothing,
      ),
    ).toEqual({ text: "Report rep-1" });
  });

  it("treats a null email in the map as unresolved", () => {
    // `getAllUsers` selects a column Prisma types as nullable even though its
    // `where` excludes nulls, so the map's value can be `null` as well as
    // absent.
    expect(
      describeAuditTarget(
        { action: PERMISSION, targetId: CUID, targetUserId: null },
        mapOf({ [CUID]: null }),
      ),
    ).toEqual({ text: "Unknown user (…tyuiop12)", title: CUID });
  });
});

describe("describeAuditDetails", () => {
  it("turns a permission row's metadata into a sentence", () => {
    expect(
      describeAuditDetails(
        PERMISSION,
        JSON.stringify({ permission: "ADMIN" }),
        "user-2",
      ),
    ).toEqual({ text: "Set to ADMIN" });
  });

  it("names the report a resolution row acted on, since Target no longer does", () => {
    expect(
      describeAuditDetails(
        RESOLVE,
        JSON.stringify({ status: "REVIEWED" }),
        CUID,
      ),
    ).toEqual({ text: "Marked REVIEWED · report …tyuiop12", title: CUID });
  });

  it("omits the title when the report id needed no shortening", () => {
    expect(
      describeAuditDetails(
        RESOLVE,
        JSON.stringify({ status: "DISMISSED" }),
        "rep-1",
      ),
    ).toEqual({ text: "Marked DISMISSED · report rep-1" });
  });

  it("leaves the cell empty when the row carried no metadata", () => {
    expect(describeAuditDetails(PERMISSION, null, "user-2")).toEqual({
      text: "",
    });
  });

  it("falls back to the stored string when it is not parseable JSON", () => {
    expect(
      describeAuditDetails(PERMISSION, "not json at all", "user-2"),
    ).toEqual({ text: "not json at all" });
  });

  it("falls back when the JSON parses to something that is not an object", () => {
    // `JSON.parse` accepts these; indexing them for `permission` would not
    // throw, it would silently yield undefined.
    expect(describeAuditDetails(PERMISSION, "null", "user-2")).toEqual({
      text: "null",
    });
    expect(describeAuditDetails(PERMISSION, '"ADMIN"', "user-2")).toEqual({
      text: '"ADMIN"',
    });
    expect(describeAuditDetails(PERMISSION, "[1,2]", "user-2")).toEqual({
      text: "[1,2]",
    });
  });

  it("falls back when the object lacks the key this action describes", () => {
    expect(
      describeAuditDetails(PERMISSION, '{"unrelated":true}', "user-2"),
    ).toEqual({ text: '{"unrelated":true}' });
  });

  it("falls back when the expected key is present but not a string", () => {
    expect(
      describeAuditDetails(PERMISSION, '{"permission":42}', "user-2"),
    ).toEqual({ text: '{"permission":42}' });
  });

  it("falls back to the stored string for an unmapped action", () => {
    expect(
      describeAuditDetails("user.admin.somethingNew", '{"whatever":1}', CUID),
    ).toEqual({ text: '{"whatever":1}' });
  });
});
