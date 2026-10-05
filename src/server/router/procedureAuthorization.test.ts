import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import { adminRouter, protectedRouter } from "./createRouter";
import type { Context } from "./context";

/**
 * Every tRPC procedure is classified, and every classification is enforced.
 *
 * `authorization.test.ts` beside this file tests the middleware contract in
 * depth - the positive paths, the MANAGER gate, the session-with-no-user case.
 * What it could not do is tell you about a procedure nobody remembered to add
 * to it. Its tables are hand-kept, so `getAuditLog` shipped with no rejection
 * test at all, and `user.recommendations.me`, `mapbox.geoJsonUserList`,
 * `mapbox.getDirections`, `user.blocks.me` and `user.blocks.unblock` had no
 * anonymous-caller test either. Changing `getAuditLog` from `adminRouter` to
 * `protectedRouter` - one word - would have handed every signed-in student the
 * actor and target ids of every permission change in the system, and left the
 * suite green.
 *
 * So this file does not list procedures to test. It reads the router and
 * requires that every procedure in it appears in `PROCEDURE_AUTHORIZATION`
 * below. A new procedure fails `covers every procedure in appRouter` until
 * somebody writes down what it is, and the write-down is then checked three
 * ways:
 *
 *   1. **Structurally**, against the middleware the procedure was actually
 *      built with. This is the check that catches a downgrade, and it needs no
 *      input, no mock and no resolver - `adminRouter` and `protectedRouter`
 *      are different objects, so a procedure cannot claim one and carry the
 *      other.
 *   2. **Behaviourally, anonymous**, over every gated procedure.
 *   3. **Behaviourally, as a USER**, over every admin procedure.
 *
 * (2) and (3) are possible for *every* procedure, including those that take
 * required input, because the auth middleware runs before input validation -
 * the property `authorization.test.ts` pins directly in "rejects an anonymous
 * caller of a procedure with input, before validating it". Each procedure is
 * therefore invoked with `undefined`, and a gate that rejects is the only
 * reason the call can fail with UNAUTHORIZED rather than BAD_REQUEST.
 */

/** What authorization a procedure is required to carry. */
type ProcedureClass = "public" | "protected" | "admin";

/**
 * The classification of every procedure in `appRouter`.
 *
 * Adding a row is a deliberate act and the only way to make the suite pass
 * again after adding a procedure. Pick the class the procedure *should* have,
 * not the one it happens to have: the tests below compare this against the
 * real middleware, so a wrong row fails rather than being adopted.
 *
 * `admin` means `adminRouter`, which rejects `permission === "USER"`. Note
 * that `updateUserPermission` carries a further MANAGER-only check inside its
 * resolver; that is not an authorization *class* and is tested where it lives,
 * in `authorization.test.ts`.
 */
const PROCEDURE_AUTHORIZATION: Record<string, ProcedureClass> = {
  "user.me": "protected",
  "user.edit": "protected",
  "user.getPresignedUrl": "protected",
  "user.getPresignedDownloadUrl": "protected",
  "user.recordProfilePictureUpload": "protected",
  "user.acceptTerms": "protected",
  "user.completeTutorial": "protected",
  "user.favorites.me": "protected",
  "user.favorites.edit": "protected",
  "user.messages.getUnreadMessageCount": "protected",
  "user.messages.conversation": "protected",
  "user.messages.sendMessage": "protected",
  "user.messages.markMessagesAsRead": "protected",
  "user.recommendations.me": "protected",
  "user.requests.me": "protected",
  "user.requests.create": "protected",
  "user.requests.delete": "protected",
  "user.groups.me": "protected",
  "user.groups.create": "protected",
  "user.groups.delete": "protected",
  "user.groups.edit": "protected",
  "user.groups.updatePreferences": "protected",
  "user.emails.sendRequestNotification": "protected",
  "user.emails.sendMessageNotification": "protected",
  "user.emails.sendAcceptanceNotification": "protected",
  "user.blocks.me": "protected",
  "user.blocks.block": "protected",
  "user.blocks.unblock": "protected",
  "user.reports.create": "protected",
  // `me` lists only the caller's own reports, scoped by `ctx.session` and
  // taking no input at all - so "signed in" really is the whole gate here,
  // and a downgrade to `public` would expose nothing, because an anonymous
  // caller has no reports. It is `protected` because there is no caller to
  // scope to without a session, not as a second line of defence.
  "user.reports.me": "protected",
  // The admin surface. Each of these reads or writes something a student must
  // not reach: the full user table, the dashboard aggregates, the report queue
  // (which carries message text from reported conversations), the permission
  // register, and the audit log of who changed whose permission.
  "user.admin.getAllUsers": "admin",
  "user.admin.getDateRange": "admin",
  "user.admin.getDashboardSeries": "admin",
  "user.admin.getDashboardStats": "admin",
  "user.admin.updateUserPermission": "admin",
  "user.admin.getAuditLog": "admin",
  "user.admin.getReports": "admin",
  "user.admin.resolveReport": "admin",
  // Mapbox spends API quota and `geoJsonUserList` returns other users'
  // start and end coordinates, so none of these is public either.
  "mapbox.search": "protected",
  "mapbox.geoJsonUserList": "protected",
  "mapbox.getDirections": "protected",
};

/**
 * Tripwire, in the spirit of `MIN_EXPECTED_PAGES` in
 * `scripts/check-page-routes.js`. The dangerous failure of this file is not a
 * failing test but a vacuous one: if a tRPC upgrade moved or renamed
 * `_def.procedures`, every sweep below would iterate an empty list and pass.
 * There are 40 procedures today; this refuses to run a check much weaker than
 * that while pretending otherwise.
 */
const MIN_EXPECTED_PROCEDURES = 35;

/**
 * tRPC's internals, read deliberately.
 *
 * `_def` is not part of the public API and these casts are the admission of
 * that. It is still the right subject: the question "what gate is this
 * procedure built with" has no behavioural answer that does not also run the
 * resolver, and the structural answer is exact. An upgrade that changes the
 * shape fails the tripwire above rather than quietly passing.
 */
type ProcedureInternals = {
  _def: { middlewares: unknown[]; type: string };
};

const routerProcedures = (): Record<string, ProcedureInternals> =>
  (
    appRouter as unknown as {
      _def: { procedures: Record<string, ProcedureInternals> };
    }
  )._def.procedures;

/**
 * The two gate middlewares, taken from the exported builders rather than from
 * `createRouter.ts`'s unexported `isProtected`/`isAdmin`.
 *
 * That is the stronger reference: it is the same object a procedure gets by
 * being declared `protectedRouter.query(...)`, so identity comparison answers
 * "was this built with that builder" and not merely "does it use a middleware
 * that resembles it". A third builder added later matches neither and
 * classifies as `public`, which fails against whatever its map row says - the
 * new gate has to be taught to this file before its procedures pass.
 */
const gateOf = (builder: unknown) =>
  (builder as ProcedureInternals)._def.middlewares[0];

const PROTECTED_GATE = gateOf(protectedRouter);
const ADMIN_GATE = gateOf(adminRouter);

/**
 * `includes` rather than `middlewares[0]`, so wrapping a builder in a further
 * `.use(...)` later does not silently reclassify everything it builds.
 */
const classOf = (procedure: ProcedureInternals): ProcedureClass | "both" => {
  const middlewares = procedure._def.middlewares;
  const isProtected = middlewares.includes(PROTECTED_GATE);
  const isAdmin = middlewares.includes(ADMIN_GATE);

  if (isProtected && isAdmin) {
    return "both";
  }
  return isAdmin ? "admin" : isProtected ? "protected" : "public";
};

const classifiedPaths = Object.keys(PROCEDURE_AUTHORIZATION);

const pathsOfClass = (wanted: ProcedureClass) =>
  classifiedPaths.filter((path) => PROCEDURE_AUTHORIZATION[path] === wanted);

/**
 * A `ctx.prisma` that cannot be used without saying so.
 *
 * Every assertion below is "the gate rejected this caller", and the way that
 * claim goes wrong is the resolver running anyway. A plain mock would let it
 * run and return `undefined` from every delegate; this records the first
 * property touched and throws, so a removed gate reports *which* resolver got
 * through instead of failing somewhere further downstream.
 */
const refusingPrisma = () => {
  const touched: string[] = [];
  const prisma = new Proxy(
    {},
    {
      get: (_target, property) => {
        const key = String(property);
        touched.push(key);
        throw new Error(
          `the resolver reached ctx.prisma.${key}; the authorization gate did not reject this caller`,
        );
      },
    },
  );

  return { prisma, touched };
};

const buildSession = (permission: Permission): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id: "user-1",
    isOnboarded: true,
    tutorialCompleted: true,
    permission,
  },
});

/**
 * Resolves a dotted procedure path against a caller.
 *
 * `appRouter.createCaller` returns the nested shape the frontend sees, so
 * `user.admin.getAuditLog` is three property reads. Walking the string is what
 * lets the sweeps be driven by the router's own path list rather than by hand.
 */
const invoke = (session: Session | null, path: string) => {
  const { prisma, touched } = refusingPrisma();
  const caller = appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

  const procedure = path
    .split(".")
    .reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      caller as unknown as Record<string, unknown>,
    ) as unknown as (input?: unknown) => Promise<unknown>;

  return { call: () => procedure(undefined), touched };
};

/**
 * Asserts a caller was rejected by a gate, and that nothing else rejected it
 * first.
 *
 * The code matters as much as the rejection. `BAD_REQUEST` would mean input
 * validation answered before the gate - a pass for the wrong reason, and the
 * thing that would make this whole file meaningless if the middleware order
 * ever changed.
 */
const expectGateRejection = async (session: Session | null, path: string) => {
  const { call, touched } = invoke(session, path);

  await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(touched).toEqual([]);
};

describe("PROCEDURE_AUTHORIZATION", () => {
  it("reads a plausible number of procedures off the router", () => {
    expect(Object.keys(routerProcedures()).length).toBeGreaterThanOrEqual(
      MIN_EXPECTED_PROCEDURES,
    );
  });

  it("distinguishes the protected gate from the admin gate", () => {
    // If these were ever the same object every classification below would be
    // meaningless, and `adminRouter` would be `protectedRouter` in any case.
    expect(PROTECTED_GATE).toBeDefined();
    expect(ADMIN_GATE).toBeDefined();
    expect(PROTECTED_GATE).not.toBe(ADMIN_GATE);
  });

  it("covers every procedure in appRouter, and no procedure that is gone", () => {
    // One assertion over sorted sets rather than two `contains` loops: the
    // failure output then names both the unclassified procedure and the stale
    // row, which are the two ways this drifts.
    expect(classifiedPaths.slice().sort()).toEqual(
      Object.keys(routerProcedures()).sort(),
    );
  });

  it("classifies nothing as public", () => {
    /*
     * `CLAUDE.md` records that plain `procedure` is public and currently
     * unused, and every procedure is gated today. This pins that: a public
     * procedure is the one class with no gate at all, so adding one should
     * require editing an assertion that says out loud that none existed.
     */
    expect(pathsOfClass("public")).toEqual([]);
  });
});

describe("the gate each procedure was built with", () => {
  it.each(classifiedPaths)(
    "builds %s with the middleware its classification names",
    (path) => {
      const procedure = routerProcedures()[path];

      expect(procedure).toBeDefined();
      expect(classOf(procedure!)).toBe(PROCEDURE_AUTHORIZATION[path]);
    },
  );
});

describe("an anonymous caller", () => {
  /*
   * `session: null` is what `createContext` produces when the request carries
   * no cookie. Every gated procedure, with no exceptions list - which is the
   * point of the sweep.
   */
  const gated = classifiedPaths.filter(
    (path) => PROCEDURE_AUTHORIZATION[path] !== "public",
  );

  it.each(gated)("is rejected by %s", async (path) => {
    await expectGateRejection(null, path);
  });
});

describe("a USER-permission caller", () => {
  /*
   * Only the admin procedures. A USER is *supposed* to get through a
   * `protectedRouter` gate, so sweeping those here would run every resolver in
   * the app against a prisma that refuses - testing nothing and failing
   * everywhere.
   */
  it.each(pathsOfClass("admin"))("is rejected by %s", async (path) => {
    await expectGateRejection(buildSession(Permission.USER), path);
  });
});
