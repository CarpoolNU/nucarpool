/**
 * Which renders `useIsHydrated` reports `false` for (SCRUM-423).
 *
 * The hook's value is only interesting *during* a render, so every test here
 * records it from inside a render function rather than reading a settled
 * value - the same technique, and for the same reason, as
 * `useIsMobile.test.tsx`'s "during the first render" block.
 *
 * The asymmetry between the two cases below is the whole design. A
 * `useState(false)` plus mount effect would report `false` on the first render
 * of both, deferring work for every consumer in the app to fix a problem only
 * the hydrating ones have. These tests fail against that shape.
 */

import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import useIsHydrated from "./useIsHydrated";

/** Records the hook's value on every render pass of a throwaway component. */
const probe = () => {
  const seen: boolean[] = [];
  const Probe = () => {
    const hydrated = useIsHydrated();
    seen.push(hydrated);
    return <div>{hydrated ? "client" : "server"}</div>;
  };
  return { seen, Probe };
};

describe("useIsHydrated on a fresh client mount", () => {
  it("is true on the very first render, with no corrective pass", () => {
    const { seen, Probe } = probe();

    render(<Probe />);

    /*
     * De-duplicated rather than indexed, because `jest.setup.dom.ts` renders
     * inside StrictMode and StrictMode double-invokes render functions. A
     * single-element set is what rules out a corrective second render - which
     * is exactly what the `useState` form would produce here, and what makes
     * it the wrong primitive for `useProfileImage` to gate on.
     */
    expect([...new Set(seen)]).toEqual([true]);
  });
});

describe("useIsHydrated under hydration", () => {
  it("is false on the pass that matches the server, then true", async () => {
    const { seen, Probe } = probe();

    // `getServerSnapshot`: the server cannot know the client has taken over.
    expect(renderToString(<Probe />)).toBe("<div>server</div>");

    /*
     * Built with `createElement` rather than `innerHTML`, which this repo's
     * lint bans. `useIsMobile.test.tsx` establishes the pattern and the
     * `renderToString` assertion above is what pins the equivalence.
     */
    const container = document.createElement("div");
    const serverRendered = document.createElement("div");
    serverRendered.textContent = "server";
    container.appendChild(serverRendered);
    document.body.appendChild(container);

    seen.length = 0;
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    try {
      await act(async () => {
        hydrateRoot(container, <Probe />);
      });

      // The discarded pass, marked. This is the render during which a
      // hydrating `DropDownMenu` must not start its avatar query.
      expect(seen[0]).toBe(false);
      expect(seen[seen.length - 1]).toBe(true);
      expect(container.textContent).toBe("client");

      /*
       * The reason this hook reads through a store instead of a `typeof
       * window` check or a `useState` initialiser: server and hydration pass
       * agree by construction, so there is nothing for React to complain
       * about. Scoped to this hydration only - jsdom cannot produce a
       * windowless server render, so a real page's mismatch behaviour is not
       * assertable here. See `src/testing/viewport.ts`.
       */
      const hydrationComplaints = consoleError.mock.calls.filter((call) =>
        JSON.stringify(call).toLowerCase().includes("hydrat"),
      );
      expect(hydrationComplaints).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
