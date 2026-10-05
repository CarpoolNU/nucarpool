import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReportReason, ReportStatus } from "@prisma/client";
import ReportsFiledSection from "./ReportsFiledSection";
import { trpcSpies } from "../../testing/trpcHarness";

/**
 * The profile's "Reports You've Filed" list.
 *
 * Pinned here: every state of the query reads as itself (loading, failed,
 * empty, a list), a resolved report says so and an open one does not, the
 * reporter's own words are shown as text, and none of it can submit the
 * profile form it sits beside.
 *
 * **Mocked onto a real React Query**, through the shared harness, rather than
 * onto a literal result object. The loading state is the reason: a hand-rolled
 * `{ isPending: true }` is a claim about what the component does with a flag,
 * whereas this is the flag React Query actually sets before a fetch resolves.
 * The error case then gets the app's real retry policy rather than an
 * invented one — see the comment on `failWith` below.
 */

type Row = {
  id: string;
  reportedName: string;
  reason: ReportReason;
  message: string | null;
  status: ReportStatus;
  filedAt: Date;
  updatedAt: Date;
};

/** What the next fetch resolves or rejects with. Set per test. */
let nextResult: () => Row[] = () => [];

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.reports.me": { query: () => nextResult() },
  }),
);

// The app's own query defaults, not an invented set: `requireActual` because
// the line above has replaced the module for everybody else. The retry rule is
// what makes the failure case below settle in one attempt rather than four.
const { defaultQueryOptions } = jest.requireActual("../../utils/trpc");

/**
 * A rejection the app's retry policy gives up on immediately.
 *
 * `defaultQueryOptions.retry` retries anything it cannot recognise three
 * times, with backoff, which is right in production and would leave this test
 * watching a spinner until it timed out. A code the policy treats as final is
 * the honest way to reach the error state — the same policy is running, not a
 * disabled one — and `UNAUTHORIZED` is what this query really fails with when
 * a session has expired underneath it.
 */
const failWith = (code: string) => () => {
  throw Object.assign(new Error("nope"), { data: { code } });
};

const renderSection = (ui = <ReportsFiledSection />) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: defaultQueryOptions } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

/*
 * Fixed instants, and midday UTC: `format` is local-time, and the suite runs
 * under both UTC and America/New_York - see `jest.shared.config.js`. Midday
 * keeps the calendar day the same in each.
 */
const FILED = new Date("2026-03-04T12:00:00.000Z");
const RESOLVED = new Date("2026-03-09T12:00:00.000Z");

const OPEN_REPORT: Row = {
  id: "report-open",
  reportedName: "Taylor",
  reason: ReportReason.HARASSMENT,
  message: "They kept messaging after I said no.",
  status: ReportStatus.OPEN,
  filedAt: FILED,
  updatedAt: FILED,
};

const REVIEWED_REPORT: Row = {
  id: "report-reviewed",
  reportedName: "Jordan",
  reason: ReportReason.NO_SHOW,
  message: null,
  status: ReportStatus.REVIEWED,
  filedAt: new Date("2025-11-19T12:00:00.000Z"),
  updatedAt: RESOLVED,
};

beforeEach(() => {
  jest.clearAllMocks();
  nextResult = () => [];
});

describe("ReportsFiledSection", () => {
  it("says so when nothing has been reported", async () => {
    renderSection();

    expect(
      screen.getByRole("heading", { name: "Reports You've Filed" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("You haven't reported anyone."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows the query as loading before it resolves, not as empty", () => {
    let release: (rows: Row[]) => void = () => undefined;
    nextResult = () =>
      new Promise<Row[]>((resolve) => {
        release = resolve;
      }) as unknown as Row[];

    renderSection();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(
      screen.queryByText("You haven't reported anyone."),
    ).not.toBeInTheDocument();

    release([]);
  });

  it("reports a failed load as a failure with a retry, not as an empty list", async () => {
    nextResult = failWith("UNAUTHORIZED");
    renderSection();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText("You haven't reported anyone."),
    ).not.toBeInTheDocument();

    const before = trpcSpies("user.reports.me").queryFn.mock.calls.length;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        trpcSpies("user.reports.me").queryFn.mock.calls.length,
      ).toBeGreaterThan(before),
    );
  });

  it("lists each report with who it was about, why, when, and where it stands", async () => {
    nextResult = () => [OPEN_REPORT, REVIEWED_REPORT];
    renderSection();

    const rows = within(await screen.findByRole("list")).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      "TaylorAwaiting reviewHarassment · Filed Mar 04 2026" +
        "They kept messaging after I said no.",
      "JordanReviewedDidn't show up · Filed Nov 19 2025Reviewed Mar 09 2026",
    ]);
  });

  /*
   * The point of the whole section: a reporter can see that an admin acted.
   * The open row is the control - `updatedAt` equals `filedAt` on a report
   * nothing has touched, so rendering it there unconditionally would show a
   * "resolution" date for a report with no resolution.
   */
  it("dates the resolution of a resolved report, and only a resolved one", async () => {
    nextResult = () => [OPEN_REPORT, REVIEWED_REPORT];
    const { container } = renderSection();

    await screen.findByRole("list");

    expect(screen.getByText("Reviewed Mar 09 2026")).toBeInTheDocument();
    expect(screen.queryByText(/^Awaiting review Mar/)).not.toBeInTheDocument();

    // The machine-readable instants, separately from the display text: these
    // are what survive a change of format, and what would break silently if
    // somebody stringified a date on the way through.
    const stamps = Array.from(container.querySelectorAll("time"));
    expect(stamps.map((stamp) => stamp.getAttribute("dateTime"))).toEqual([
      OPEN_REPORT.filedAt.toISOString(),
      REVIEWED_REPORT.filedAt.toISOString(),
      REVIEWED_REPORT.updatedAt.toISOString(),
    ]);
  });

  it("shows the reporter's own words as text, markup and all", async () => {
    nextResult = () => [
      { ...OPEN_REPORT, message: "<b>bold</b> & https://example.com" },
    ];
    const { container } = renderSection();

    expect(
      await screen.findByText("<b>bold</b> & https://example.com"),
    ).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("offers no way to withdraw or edit a report", async () => {
    nextResult = () => [OPEN_REPORT, REVIEWED_REPORT];
    renderSection();

    await screen.findByRole("list");
    // A report is evidence. The only control this section ever renders is the
    // failed-load retry, and that is not on this path.
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("cannot submit a form it is rendered inside", async () => {
    // It sits beside the profile's react-hook-form, as `BlockedUsersSection`
    // does. A default-typed button in the failure state would submit it, so a
    // retry would also run Save Changes.
    nextResult = failWith("UNAUTHORIZED");
    const onSubmit = jest.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    renderSection(
      <form onSubmit={onSubmit}>
        <ReportsFiledSection />
      </form>,
    );

    await screen.findByRole("alert");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Try again" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
