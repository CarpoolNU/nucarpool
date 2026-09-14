/**
 * The point-click handler used to be a single module-scope variable, which two
 * things made wrong at once.
 *
 * Every map overwrote it. That was invisible while the page built exactly one
 * map and never destroyed it, but the map is now torn down and rebuilt across
 * a client-side navigation, and a second map's handler replaced the first's
 * globally while the first map's listeners still referenced the old closure.
 *
 * And nothing ever cleared it, so the handler - which closes over a
 * `setPopupUser` bound to a specific mounted page - outlived that page.
 *
 * Keying the handler to its map fixes both: two maps cannot collide, and the
 * entry is unreachable once the map is.
 */

import type { Map } from "mapbox-gl";
import {
  createPointClickHandler,
  getPointClickHandler,
  setPointClickHandler,
} from "./handlers";

/** Only identity matters here - nothing in this module calls the map. */
const fakeMap = (name: string) => ({ name }) as unknown as Map;

describe("point click handlers", () => {
  it("has no handler for a map that has not registered one", () => {
    expect(getPointClickHandler(fakeMap("unregistered"))).toBeNull();
  });

  it("gives each map back its own handler", () => {
    const first = fakeMap("first");
    const second = fakeMap("second");
    const firstHandler = jest.fn();
    const secondHandler = jest.fn();

    setPointClickHandler(first, firstHandler);
    setPointClickHandler(second, secondHandler);

    expect(getPointClickHandler(first)).toBe(firstHandler);
    expect(getPointClickHandler(second)).toBe(secondHandler);
  });

  /**
   * The regression the module-scope variable caused: registering the second
   * map's handler used to leave the first map answering with it.
   */
  it("does not let a second map overwrite the first map's handler", () => {
    const first = fakeMap("first");
    const firstHandler = jest.fn();

    setPointClickHandler(first, firstHandler);
    setPointClickHandler(fakeMap("second"), jest.fn());

    expect(getPointClickHandler(first)).toBe(firstHandler);
  });

  it("reports the users under the tapped point", () => {
    const setPopupUser = jest.fn();
    const handler = createPointClickHandler(setPopupUser);
    const rider = { id: "rider-1" };

    handler({
      features: [{}],
      point: { x: 10, y: 20 },
      target: {
        getStyle: () => ({
          layers: [
            { id: "riders", type: "symbol" },
            { id: "clusters", type: "circle" },
          ],
        }),
        queryRenderedFeatures: () => [{ properties: rider }],
      },
      // The real event carries far more than this handler reads.
    } as never);

    expect(setPopupUser).toHaveBeenCalledWith([rider]);
  });
});
