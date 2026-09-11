import { Role, Status } from "@prisma/client";
import { updateUser } from "./updateUser";

/**
 * The payload `updateUser` sends to `user.edit`.
 *
 * Only the schedule times are asserted here, because they are the fields whose
 * *absence* and *nullness* mean different things and the ones this file used to
 * conflate: `userInfo.startTime?.toISOString()` yields `undefined` for `null`
 * as readily as for `undefined`, so a cleared schedule never left the browser.
 *
 * Worth having as a test rather than a comment. Reverting the call site to
 * optional chaining still **type-checks** — `string | undefined` is assignable
 * to `string | null | undefined` — so the compiler cannot catch a regression
 * here and nothing else did either.
 *
 * `updateUser` takes its mutation as an argument rather than calling a hook, so
 * a stub is all this needs.
 */

const mutationStub = () => {
  // Typed with its parameter so `mock.calls[0][0]` is a real element rather
  // than an index into an empty tuple - `jest.fn(async () => …)` infers zero
  // arguments and does not compile when read back.
  const mutateAsync = jest.fn(
    async (_input: Record<string, unknown>): Promise<undefined> => undefined,
  );

  return {
    mutation: { mutateAsync } as unknown as Parameters<
      typeof updateUser
    >[0]["mutation"],
    sent: () => mutateAsync.mock.calls[0][0],
  };
};

const userInfoWith = (times: {
  startTime: Date | null;
  endTime: Date | null;
}) =>
  ({
    role: Role.VIEWER,
    status: Status.ACTIVE,
    seatAvail: 0,
    companyName: "Acme",
    companyAddress: "Congress St, Boston, Massachusetts",
    companyCoordLng: -71.05,
    companyCoordLat: 42.36,
    startAddress: "Huntington Ave, Boston, Massachusetts",
    startCoordLng: -71.1,
    startCoordLat: 42.31,
    preferredName: "Sam",
    pronouns: "",
    daysWorking: [false, true, true, true, true, true, false],
    bio: "",
    coopStartDate: new Date("2026-01-31T00:00:00.000Z"),
    coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
    startStreet: "Huntington Ave",
    startCity: "Boston",
    startState: "Massachusetts",
    companyStreet: "Congress St",
    companyCity: "Boston",
    companyState: "Massachusetts",
    ...times,
  }) as unknown as Parameters<typeof updateUser>[0]["userInfo"];

describe("updateUser — schedule times on the wire", () => {
  it("sends null for a cleared time, so the server can clear the column", async () => {
    const { mutation, sent } = mutationStub();

    await updateUser({
      userInfo: userInfoWith({ startTime: null, endTime: null }),
      sessionName: "Sam",
      mutation,
    });

    expect(sent().startTime).toBeNull();
    expect(sent().endTime).toBeNull();
  });

  it("sends the ISO instant for a time that is set", async () => {
    const { mutation, sent } = mutationStub();

    await updateUser({
      userInfo: userInfoWith({
        startTime: new Date("1970-01-01T13:00:00.000Z"),
        endTime: new Date("1970-01-01T22:00:00.000Z"),
      }),
      sessionName: "Sam",
      mutation,
    });

    expect(sent().startTime).toBe("1970-01-01T13:00:00.000Z");
    expect(sent().endTime).toBe("1970-01-01T22:00:00.000Z");
  });

  it("distinguishes null from the string a set time produces", async () => {
    // The assertion that fails if the call site goes back to optional
    // chaining: `undefined` would satisfy neither branch below.
    const { mutation, sent } = mutationStub();

    await updateUser({
      userInfo: userInfoWith({
        startTime: null,
        endTime: new Date("1970-01-01T22:00:00.000Z"),
      }),
      sessionName: "Sam",
      mutation,
    });

    expect(sent().startTime).toBeNull();
    expect(sent().startTime).not.toBeUndefined();
    expect(typeof sent().endTime).toBe("string");
  });
});
