/**
 * `/safety` — the standing guidance page (SCRUM-624).
 *
 * Here rather than beside the route, because `pageExtensions` includes `.tsx`
 * and a file under `src/pages/` is also a URL. `scripts/check-page-routes.ts`
 * fails the build on one, so this follows the convention the Setup and
 * Profile page tests already use: import the route from outside the directory.
 *
 * **The absence of a provider is the point of the first test.** Every other
 * page here needs a session, a tRPC client or both, and this one is rendered
 * bare on purpose: the reader may be signed out, and a redirect to Azure AD is
 * the wrong answer to "what happens if I report someone". If somebody later
 * adds a `useSession` or a query to this page, that test fails rather than the
 * page quietly becoming unreachable to the people most likely to want it.
 */

import { render, screen } from "@testing-library/react";
import Safety from "../pages/safety";
import { REPORT_SNAPSHOT_MESSAGE_LIMIT } from "../utils/reports";

describe("the safety page", () => {
  it("renders with no session, no router and no tRPC provider", () => {
    render(<Safety />);

    expect(
      screen.getByRole("heading", { name: "Staying safe on NUCarpool" }),
    ).toBeInTheDocument();
  });

  it("puts emergency services ahead of the app", () => {
    render(<Safety />);

    const emergency = screen.getByRole("region", { name: "In an emergency" });
    expect(emergency).toHaveTextContent("call 911");
    expect(emergency).toHaveTextContent(
      "Nothing in this app is a substitute for emergency services.",
    );
  });

  it("says where Report and Block are", () => {
    render(<Safety />);

    const where = screen.getByRole("region", {
      name: "Where to find Report and Block",
    });
    expect(where).toHaveTextContent("three dots on their card");
    expect(where).toHaveTextContent("conversation");
  });

  /**
   * The claims below are the ones the server actually keeps. If any of these
   * stops being true, this page becomes a promise the product does not honour
   * — which is worse than having said nothing.
   */
  it("states what a report does, matching reports.create", () => {
    render(<Safety />);

    const report = screen.getByRole("region", { name: "What reporting does" });
    expect(report).toHaveTextContent("goes to the NUCarpool admins");
    expect(report).toHaveTextContent("not shown to the person you reported");
    expect(report).toHaveTextContent(
      `most recent ${REPORT_SNAPSHOT_MESSAGE_LIMIT} messages`,
    );
  });

  it("states what a block does, matching blocks.block", () => {
    render(<Safety />);

    const block = screen.getByRole("region", { name: "What blocking does" });
    expect(block).toHaveTextContent("Blocking works both ways.");
    expect(block).toHaveTextContent("The person you block is not told.");
    expect(block).toHaveTextContent("You can unblock someone at any time");
  });

  /**
   * The admin queue ends at a REVIEWED status and carries no enforcement
   * action, so the page must not imply one. A sentence promising suspension
   * or removal would be the single most damaging thing this page could say.
   */
  it("promises no enforcement outcome it cannot deliver", () => {
    const { container } = render(<Safety />);
    const text = container.textContent ?? "";

    // The control. A negative match over an empty string passes for the
    // wrong reason, and a page that failed to render would do exactly that.
    expect(text).toContain("What blocking does");

    expect(text).not.toMatch(
      /suspend|ban|remove(d)? from the app|delete(d)? their account/i,
    );
  });
});
