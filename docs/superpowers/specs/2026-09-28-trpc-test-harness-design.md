# A shared tRPC test harness

**Date:** 2026-09-28
**Status:** Approved for implementation, phase 1
**Baseline:** `ba0ef68` (`origin/main`)

## Why

An audit of the whole suite found that NUCarpool's tests are not duplicated
and are not broken. `yarn test` runs **195 suites / 3,658 tests green in 53s**,
with zero `.skip`, zero `.todo`, zero `.only` and zero assertion-free bodies.
Fingerprinting all 2,168 test bodies with comments stripped found 7 real
exact-duplicate groups (~0.3%), nearly all of them independent ops scripts
asserting their own `--apply` guard with a common shape - parallel coverage of
separate modules, not redundancy.

What the suite does have is duplicated **scaffolding**. There are 218
hand-rolled `jest.mock` call sites. Forty separate files each write their own
mock of `src/utils/trpc`, totalling **971 lines** of near-identical factory
blocks at a median of 23 lines each - 492 of them in the phase 1 cohort and
479 in the phase 2 cohort.

Worse than the volume is that those forty files are split across two idioms of
different fidelity:

| Cohort                                | Files | Shape                                                               |
| ------------------------------------- | ----- | ------------------------------------------------------------------- |
| Plain-object fake                     | 25    | `jest.mock("utils/trpc", () => ({ … useQuery: () => ({ data }) }))` |
| Fake tRPC on a **real** `QueryClient` | 15    | delegates to `jest.requireActual("@tanstack/react-query")`          |
| Real React Query, no tRPC mock        | 5     | hooks exercised directly                                            |

The five files in the third row mock no tRPC at all and are **out of scope
throughout**: they exercise hooks directly and have no scaffolding to share.

The 15-file cohort is the mature pattern and is already the de-facto standard
for anything asserting load, error or invalidation behaviour. The 25-file
cohort is structurally unable to catch a whole class of defect, because a
hand-written result object cannot reproduce React Query's own state machine:

- A **disabled** query reports `isLoading: false`, which a plain fake makes
  indistinguishable from _ready_. This is the trap that forced
  `HELD_QUERY_STATE` into `src/utils/queryState.ts`.
- A `useInfiniteQuery` always sends a `direction` key, so a `.strict()` tRPC
  input rejects page one in production while both the caller test and the
  mocked component test pass.

## Goal

One harness, built on the real React Query client, that every tRPC-mocking test
uses - collapsing the scaffolding **and** lifting the 25 weak-fake files to the
fidelity the other 15 already have.

## Non-goals

Two things are deliberately out of scope, and should stay out on any later edit
of this spec.

- **The 20% comment density is not waste.** Across the suite, 12,466 of 63,259
  test lines are comments, and some files run to 50%. That is the documented
  house style and it carries real rationale - why `transformIgnorePatterns` is
  empty, why naming a Tailwind utility in a test ships it as CSS. Removing it
  would read as simplification and be data loss.
- **The mandatory file splits stay split.** `*.db.test.ts` is a separate Jest
  project that needs MySQL; `*.console.test.tsx` must be its own file because
  React caches each warning per attribute name at module scope; `.ts` versus
  `.tsx` is the node/jsdom project selector. Only the _optional_ splits are
  candidates, and only in phase 4.

## Design

### Module

`src/testing/trpcHarness.ts`, exporting `buildTrpcMock(spec)`.

The spec is a flat map from a dotted procedure path to a stub descriptor; the
builder expands it into the nested object `trpc` callers expect.

```ts
jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getAllUsers": { query: () => [] },
    "user.admin.updateUserPermission": { mutation: true },
  }),
);
```

### The `require`-inside-factory form is load-bearing

`jest.mock` factories are hoisted above imports, so a top-level
`import { buildTrpcMock }` fails with _"The module factory of `jest.mock()` is
not allowed to reference any out-of-scope variables"_. Calling `require` inside
the factory is the only shape that works. This was verified with a throwaway
probe before this spec was written, not assumed.

### Surface

Four hooks, which is the complete set in use across all 40 call sites:

| Hook                               | Behaviour                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useQuery(input, options)`         | delegates to the real `useQuery`, `queryKey: [path, input]`, `queryFn` a spy calling the stub, `...options` spread **last** so `enabled` carries through |
| `useMutation(options)`             | real `useMutation` over a spy `mutationFn`, so `onSuccess`/`onError` fire on the real timeline                                                           |
| `useInfiniteQuery(input, options)` | real `useInfiniteQuery`, so `direction` and `pageParam` reach the stub and an over-strict input surfaces                                                 |
| `useUtils()`                       | nested object of `invalidate`/`refetch`/`cancel` spies mirroring the spec's paths                                                                        |

The `...options` spread ordering is the single most important detail: a fix
that computes a gate but forgets to pass it must show up as a fetch that still
happens.

### Accessors

`buildTrpcMock` returns the object `jest.mock` must hand back, which cannot
also carry the spies - a test asserting a call count would otherwise have to
walk the nested tree by hand. The harness therefore also exports
`trpcSpies(path)`, resolving a dotted path to that procedure's
`{ queryFn, mutationFn, invalidate, refetch }` spies, and `resetTrpcSpies()`
for `beforeEach`. Both read a module-level registry populated by
`buildTrpcMock`, which is safe because Jest gives each suite its own module
registry.

## Phasing

Each phase independently passes CI and is its own ticket and its own PR.

**Phase 1 - build the harness, migrate the 15 real-`QueryClient` files.**
Same fidelity in, same fidelity out, so any behaviour change is a harness bug
rather than a discovered defect. This proves the API against the mature pattern
before it is asked to change anything.

Cohort: `AdminAuditLog`, `AdminData.downloadData`, `AdminData.queryError`,
`AdminReports`, `UserManagement.queryError`, `UserManagement`,
`MessageContent.threadStates`, `MessageHeader.avatarRequest`,
`MessagePanel.conversationSwitch`, `sendMessageThreadRefresh`,
`profileQueryError`, `profileSaveAndContinue`, `setupQueryError`,
`recommendationsQueryGate`, `ConnectModal.closeAfterSend`.

**Phase 2 - migrate the 25 plain-fake files.** This is the fidelity upgrade and
the only phase expected to surface failures. Split by area so each stays
reviewable: components root (6), Group (4), Messages (4), Setup (3),
UserCards (3), UserActions (2), Map (1), Profile (1), Sidebar (1).

**Phase 3 - the other hot mocks.** `next-auth/react` (14 files),
`useProfileImage` (14), `react-toastify` (12), `next/router` (10).

**Phase 4 - optional file merges.** `ProfilePicture` (4 files, 652 lines, 19
tests, all four opening with the same two `jest.mock` blocks) collapses to one.
`AdminData`, `UserManagement`, `MessageHeader`, `ExploreSidebar`, `GroupPage`,
`ConnectModal`, `MessageContent` likewise. `MessagePanel` is **excluded**: its
two files carry deliberately divergent mocks, one shallow and one deep with
Pusher, so merging costs more than it saves.

## Testing

`src/testing/trpcHarness.test.tsx` covers the four hook shapes, the nested-path
expansion, and - as the regression guard for the whole rationale - that a
disabled query reports `isLoading: false` with `isPending: true` and
`isFetching: false`, distinct from a ready one. The probe measured exactly that,
so the assertion is a recorded measurement rather than a guess.

Per migrated file the bar is: **identical test count, still green.** In phase 1
any deviation is a harness defect. In phase 2 a newly failing test is triaged as
a real finding, filed as its own issue per the discovered-issue workflow, and
**not** papered over by weakening the harness.

## Expected outcome

The 971 lines of tRPC mock blocks become roughly 200. Phase 3 removes a further
comparable volume. No test is deleted, and no coverage is lost; 25 files gain
coverage they could not previously have.
