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
      describeAuditTarget(PERMISSION, "user-2", "target@northeastern.edu"),
    ).toEqual({ text: "target@northeastern.edu" });
  });

  it("marks an unresolvable user target rather than printing a bare id", () => {
    expect(describeAuditTarget(PERMISSION, CUID, undefined)).toEqual({
      text: "Unknown user (…tyuiop12)",
      title: CUID,
    });
  });

  it("labels a report target, which has no user to resolve to", () => {
    expect(describeAuditTarget(RESOLVE, CUID, undefined)).toEqual({
      text: "Report …tyuiop12",
      title: CUID,
    });
  });

  it("ignores an email that happens to collide with a report id", () => {
    // `resolveReport` writes a report id; a user whose id matched it would
    // still not be what the row is about.
    expect(
      describeAuditTarget(RESOLVE, CUID, "someone@northeastern.edu"),
    ).toEqual({ text: "Report …tyuiop12", title: CUID });
  });

  it("prints the raw id for an unmapped action, whose target kind is unknown", () => {
    expect(
      describeAuditTarget("user.admin.somethingNew", CUID, undefined),
    ).toEqual({ text: CUID });
  });

  it("omits the title when the id was never shortened", () => {
    expect(describeAuditTarget(RESOLVE, "rep-1", undefined)).toEqual({
      text: "Report rep-1",
    });
  });
});

describe("describeAuditDetails", () => {
  it("turns each known action's metadata into a sentence", () => {
    expect(
      describeAuditDetails(PERMISSION, JSON.stringify({ permission: "ADMIN" })),
    ).toBe("Set to ADMIN");
    expect(
      describeAuditDetails(RESOLVE, JSON.stringify({ status: "REVIEWED" })),
    ).toBe("Marked REVIEWED");
  });

  it("leaves the cell empty when the row carried no metadata", () => {
    expect(describeAuditDetails(PERMISSION, null)).toBe("");
  });

  it("falls back to the stored string when it is not parseable JSON", () => {
    expect(describeAuditDetails(PERMISSION, "not json at all")).toBe(
      "not json at all",
    );
  });

  it("falls back when the JSON parses to something that is not an object", () => {
    // `JSON.parse` accepts these; indexing them for `permission` would not
    // throw, it would silently yield undefined.
    expect(describeAuditDetails(PERMISSION, "null")).toBe("null");
    expect(describeAuditDetails(PERMISSION, '"ADMIN"')).toBe('"ADMIN"');
    expect(describeAuditDetails(PERMISSION, "[1,2]")).toBe("[1,2]");
  });

  it("falls back when the object lacks the key this action describes", () => {
    expect(describeAuditDetails(PERMISSION, '{"unrelated":true}')).toBe(
      '{"unrelated":true}',
    );
  });

  it("falls back when the expected key is present but not a string", () => {
    expect(describeAuditDetails(PERMISSION, '{"permission":42}')).toBe(
      '{"permission":42}',
    );
  });

  it("falls back to the stored string for an unmapped action", () => {
    expect(
      describeAuditDetails("user.admin.somethingNew", '{"whatever":1}'),
    ).toBe('{"whatever":1}');
  });
});
