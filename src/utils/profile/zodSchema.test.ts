import { Role, Status } from "@prisma/client";
import { onboardSchema, profileDefaultValues } from "./zodSchema";
import { PROFILE_TEXT_MAX_LENGTH } from "../textLimits";

/**
 * `onboardSchema` is the gate that decides whether a profile is complete enough to
 * appear in matching. Everything below is about which fields are conditionally
 * required and which zero-ish values count as answered.
 */

const completeRider = {
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
  companyName: "Acme",
  companyAddress: "100 Congress St, Boston, MA",
  startAddress: "12 Highland Ave, Somerville, MA",
  preferredName: "Ada",
  pronouns: "they/them",
  daysWorking: [false, true, true, true, true, true, false],
  bio: "Commuting from Somerville",
  startTime: new Date(2024, 0, 1, 9),
  endTime: new Date(2024, 0, 1, 17),
  coopStartDate: new Date(2024, 0, 1),
  coopEndDate: new Date(2024, 5, 1),
  profilePicture: "",
};

/** The `path` of every issue the schema raised, for order-independent assertions. */
const issuePaths = (input: unknown): string[] => {
  const result = onboardSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => String(issue.path[0]));
};

describe("onboardSchema", () => {
  it("accepts a fully completed rider profile", () => {
    expect(onboardSchema.safeParse(completeRider).success).toBe(true);
  });

  it("accepts a fully completed driver profile with seats", () => {
    expect(
      onboardSchema.safeParse({
        ...completeRider,
        role: Role.DRIVER,
        seatAvail: 4,
      }).success,
    ).toBe(true);
  });

  it.each([
    "coopStartDate",
    "coopEndDate",
    "companyAddress",
    "startAddress",
    "startTime",
    "endTime",
  ])("requires %s for a non-viewer", (field) => {
    expect(issuePaths({ ...completeRider, [field]: null })).toContain(field);
  });

  it("requires at least one working day", () => {
    expect(
      issuePaths({
        ...completeRider,
        daysWorking: [false, false, false, false, false, false, false],
      }),
    ).toContain("daysWorking");
    expect(issuePaths({ ...completeRider, daysWorking: undefined })).toContain(
      "daysWorking",
    );
  });

  it("treats zero seats as an answer rather than a missing value", () => {
    // A rider legitimately offers zero seats, so 0 must not read as "unset".
    expect(issuePaths({ ...completeRider, seatAvail: 0 })).not.toContain(
      "seatAvail",
    );
    expect(issuePaths({ ...completeRider, seatAvail: undefined })).toContain(
      "seatAvail",
    );
  });

  it("rejects an empty company name but accepts an absent one", () => {
    expect(issuePaths({ ...completeRider, companyName: "" })).toContain(
      "companyName",
    );
    expect(
      issuePaths({ ...completeRider, companyName: undefined }),
    ).not.toContain("companyName");
  });

  it("rejects an empty string address the same way as a missing one", () => {
    expect(issuePaths({ ...completeRider, startAddress: "" })).toContain(
      "startAddress",
    );
    expect(issuePaths({ ...completeRider, companyAddress: "" })).toContain(
      "companyAddress",
    );
  });

  it("waives every conditional requirement for a viewer", () => {
    const bareViewer = { role: Role.VIEWER, status: Status.ACTIVE };

    expect(onboardSchema.safeParse(bareViewer).success).toBe(true);
  });

  it("reports every missing field at once rather than stopping at the first", () => {
    const paths = issuePaths({ role: Role.RIDER, status: Status.ACTIVE });

    expect(paths).toEqual(
      expect.arrayContaining([
        "coopEndDate",
        "coopStartDate",
        "seatAvail",
        "companyAddress",
        "startAddress",
        "daysWorking",
        "startTime",
        "endTime",
      ]),
    );
  });

  it.each([
    { seatAvail: -1, reason: "negative" },
    { seatAvail: 7, reason: "above the six seat maximum" },
    { seatAvail: 1.5, reason: "not a whole number" },
  ])("rejects a seat count that is $reason", ({ seatAvail }) => {
    expect(
      issuePaths({ ...completeRider, role: Role.DRIVER, seatAvail }),
    ).toContain("seatAvail");
  });

  it("accepts the six seat maximum", () => {
    expect(
      onboardSchema.safeParse({
        ...completeRider,
        role: Role.DRIVER,
        seatAvail: 6,
      }).success,
    ).toBe(true);
  });

  it("rejects a role or status outside the Prisma enums", () => {
    expect(issuePaths({ ...completeRider, role: "PASSENGER" })).toContain(
      "role",
    );
    expect(issuePaths({ ...completeRider, status: "PENDING" })).toContain(
      "status",
    );
  });
});

describe("profileDefaultValues", () => {
  it("starts a new profile as an active rider with no days selected", () => {
    expect(profileDefaultValues).toMatchObject({
      role: Role.RIDER,
      status: Status.ACTIVE,
      seatAvail: 0,
      daysWorking: [false, false, false, false, false, false, false],
    });
  });

  it("does not validate on its own, so onboarding cannot be submitted untouched", () => {
    expect(onboardSchema.safeParse(profileDefaultValues).success).toBe(false);
  });

  it("provides one entry per day of the week", () => {
    expect(profileDefaultValues.daysWorking).toHaveLength(7);
  });
});

describe("onboardSchema — text bounded by its column (SCRUM-231)", () => {
  // `companyName`, `preferredName`, `pronouns` and `bio` are all `VARCHAR(191)`.
  // The inputs cap typing and pasting; this catches anything set another way,
  // and turns an over-length value into a field error instead of a failed save.
  const fields = ["companyName", "preferredName", "pronouns", "bio"] as const;

  it.each(fields)("rejects an over-length %s", (field) => {
    expect(
      issuePaths({
        ...completeRider,
        [field]: "a".repeat(PROFILE_TEXT_MAX_LENGTH + 1),
      }),
    ).toContain(field);
  });

  it.each(fields)("accepts %s at exactly the column width", (field) => {
    expect(
      issuePaths({
        ...completeRider,
        [field]: "a".repeat(PROFILE_TEXT_MAX_LENGTH),
      }),
    ).not.toContain(field);
  });
});
