import { render, screen, within } from "@testing-library/react";
import RequestFunnelChart from "./RequestFunnelChart";

/**
 * The request funnel as an admin reads it. The chart is markup, not canvas, so
 * unlike its siblings it can be rendered here and asserted on directly.
 *
 * What these guard against is a misreading: the counts are a snapshot
 * of today, and an unlabelled bar reads as a lifetime conversion rate. So the
 * caption is asserted in every state, the empty one included, and no state may
 * print `NaN`.
 */

const SNAPSHOT_CAPTION = /current state, not lifetime/i;

describe("RequestFunnelChart", () => {
  it("shows sent, accepted and riders-in-a-group counts in a table", () => {
    render(
      <RequestFunnelChart
        funnel={{ requestsSent: 10, requestsAccepted: 4, ridersInGroup: 3 }}
      />,
    );

    const table = screen.getByRole("table");
    const rowFor = (name: string) =>
      within(table).getByRole("row", { name: new RegExp(name) });

    expect(rowFor("Requests sent")).toHaveTextContent("10");
    expect(rowFor("Requests accepted")).toHaveTextContent("4");
    expect(rowFor("Requests accepted")).toHaveTextContent("40%");
    expect(rowFor("Riders in a group")).toHaveTextContent("3");
    expect(rowFor("Riders in a group")).toHaveTextContent("75%");
  });

  it("carries the snapshot caption", () => {
    render(
      <RequestFunnelChart
        funnel={{ requestsSent: 10, requestsAccepted: 4, ridersInGroup: 3 }}
      />,
    );

    expect(screen.getByText(SNAPSHOT_CAPTION)).toBeInTheDocument();
  });

  it("explains why drivers are absent from the last stage", () => {
    render(
      <RequestFunnelChart
        funnel={{ requestsSent: 10, requestsAccepted: 4, ridersInGroup: 3 }}
      />,
    );

    expect(screen.getByText(/drivers are not counted/i)).toBeInTheDocument();
  });

  it("names the section for assistive technology", () => {
    render(
      <RequestFunnelChart
        funnel={{ requestsSent: 10, requestsAccepted: 4, ridersInGroup: 3 }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Request Funnel" }),
    ).toBeInTheDocument();
  });

  describe("with zero requests", () => {
    const empty = { requestsSent: 0, requestsAccepted: 0, ridersInGroup: 0 };

    it("renders an empty state and no table", () => {
      render(<RequestFunnelChart funnel={empty} />);

      expect(screen.getByText(/no requests have been sent/i)).toBeVisible();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("prints no NaN or Infinity anywhere", () => {
      const { container } = render(<RequestFunnelChart funnel={empty} />);

      expect(container.textContent).not.toMatch(/NaN|Infinity/);
    });

    it("still carries the snapshot caption", () => {
      render(<RequestFunnelChart funnel={empty} />);

      expect(screen.getByText(SNAPSHOT_CAPTION)).toBeInTheDocument();
    });
  });

  describe("when riders in a group outnumber accepted requests", () => {
    // A rider whose request row was erased, or whose group predates acceptances
    // being recorded: 1 sent, 0 accepted, 1 grouped.
    const inverted = { requestsSent: 1, requestsAccepted: 0, ridersInGroup: 1 };

    it("shows the real count with no rate, and says why", () => {
      render(<RequestFunnelChart funnel={inverted} />);

      const row = within(screen.getByRole("table")).getByRole("row", {
        name: /Riders in a group/,
      });

      expect(row).toHaveTextContent("1");
      expect(row).not.toHaveTextContent("%");
      expect(screen.getByText(/larger than the one before it/i)).toBeVisible();
    });

    it("prints no NaN or Infinity", () => {
      const { container } = render(<RequestFunnelChart funnel={inverted} />);

      expect(container.textContent).not.toMatch(/NaN|Infinity/);
    });
  });

  it("omits the explanation when every stage is within the one before it", () => {
    render(
      <RequestFunnelChart
        funnel={{ requestsSent: 10, requestsAccepted: 4, ridersInGroup: 3 }}
      />,
    );

    expect(
      screen.queryByText(/larger than the one before it/i),
    ).not.toBeInTheDocument();
  });
});
