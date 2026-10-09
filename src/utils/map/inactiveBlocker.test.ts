import { Role, Status } from "@prisma/client";
import { showsInactiveBlocker } from "./inactiveBlocker";

/**
 * The one condition that decides whether `InactiveBlocker` is on screen.
 *
 * Worth a test of its own rather than being left inline at each call site,
 * because three separate behaviours now read it - the blocker's own render,
 * the header's disabled state, and the mobile sheet's opening detent - and
 * they have to agree. A sheet that opens expanded because its copy of the
 * condition says "not blocked", over a blocker that rendered because its copy
 * said "blocked", is exactly the defect this predicate exists to make
 * impossible.
 */
describe("showsInactiveBlocker", () => {
  it("blocks an inactive RIDER and an inactive DRIVER", () => {
    expect(
      showsInactiveBlocker({ role: Role.RIDER, status: Status.INACTIVE }),
    ).toBe(true);
    expect(
      showsInactiveBlocker({ role: Role.DRIVER, status: Status.INACTIVE }),
    ).toBe(true);
  });

  it("leaves an active RIDER and an active DRIVER alone", () => {
    expect(
      showsInactiveBlocker({ role: Role.RIDER, status: Status.ACTIVE }),
    ).toBe(false);
    expect(
      showsInactiveBlocker({ role: Role.DRIVER, status: Status.ACTIVE }),
    ).toBe(false);
  });

  it("exempts a VIEWER at either status", () => {
    // A VIEWER has nothing to be inactive *from* - the role browses and
    // cannot connect - so the blocker has never applied to it, at either
    // status. Production holds 38 INACTIVE VIEWER rows, so this is a
    // combination that really occurs and not a theoretical one.
    expect(
      showsInactiveBlocker({ role: Role.VIEWER, status: Status.INACTIVE }),
    ).toBe(false);
    expect(
      showsInactiveBlocker({ role: Role.VIEWER, status: Status.ACTIVE }),
    ).toBe(false);
  });

  it("is false while the user is still in flight", () => {
    // `user.me` has not resolved on the first render. False is the safe
    // answer: it is what the page did before this predicate existed, and it
    // errs towards not blocking an account that may well be active.
    expect(showsInactiveBlocker({})).toBe(false);
    expect(showsInactiveBlocker({ role: Role.RIDER })).toBe(false);
    expect(showsInactiveBlocker({ status: Status.INACTIVE })).toBe(false);
  });
});
