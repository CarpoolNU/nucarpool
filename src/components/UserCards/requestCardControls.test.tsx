import { render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import { SentCard } from "./SentCard";
import { ReceivedCard } from "./ReceivedCard";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * What a Requests-tab card offers, and what it deliberately does not
 * (SCRUM-422).
 *
 * Both card types make the same `UserCard` call with the same props, so the
 * contract below is one contract and is tested once here rather than copied
 * into two near-identical files.
 *
 * **This test pins a decision, not a fix.** It passes against the code before
 * SCRUM-422 as well as after, and that is the point rather than an oversight:
 * the change was to delete a `onViewRouteClick` prop that both cards required,
 * were passed at all four call sites, and silently dropped. Deleting it
 * altered no rendered output, so no assertion here could fail beforehand.
 * What these tests prevent is the *opposite* mistake - someone reading the
 * dropped prop as an omission and "restoring" it, which would put a View Route
 * button back on a request card.
 *
 * That would be wrong, and git says so. `b3886a4` (2024-09-26) removed
 * `onViewRouteClick={props.onViewRouteClick}` from `SentCard`'s `UserCard`
 * call, and `0373de2` a week later added the Map tab to `MessagePanel`, whose
 * effect calls `onViewRouteClick` when the tab is opened. View Route *moved*
 * off the card and into the conversation. It is one tap deeper - open the
 * card, switch to Map - on both platforms, since `MessagePanel` has no
 * `isMobile` branch at all.
 *
 * So the card's single job is to open the conversation, and that is what is
 * asserted: exactly one control, named for what it does.
 */

/** `mixpanel.init` runs at module scope; see SCRUM-417. */
jest.mock("../../utils/mixpanel", () => ({
  trackEvent: jest.fn(),
  trackViewRoute: jest.fn(),
}));

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: { recommendations: { me: { invalidate: jest.fn() } } },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
    },
  },
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

const OTHER_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  startCoordLng: -71.09,
  startCoordLat: 42.34,
  companyAddress: "2 Elsewhere Ave",
  companyCoordLng: -71.08,
  companyCoordLat: 42.35,
  daysWorking: "1,1,1,1,1,0,0",
  startTime: new Date("2026-01-05T13:00:00.000Z"),
  endTime: new Date("2026-01-05T22:00:00.000Z"),
  coopStartDate: new Date("2026-01-05T00:00:00.000Z"),
  coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
  carpoolId: null,
  isFavorited: false,
} as unknown as EnhancedPublicUser;

/** A RIDER viewer, so a DRIVER counterpart is compatible and no notice shows. */
const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

/** Built from `preferredName`, the same value the heading reads. */
const OPEN_CONVERSATION = "Open conversation with Riley";

const CARDS = [
  ["SentCard", SentCard],
  ["ReceivedCard", ReceivedCard],
] as const;

const renderCard = (Card: (typeof CARDS)[number][1]) =>
  render(
    <UserContext.Provider value={VIEWER}>
      <Card
        otherUser={OTHER_USER}
        onClick={() => undefined}
        selectedUser={null}
        isUnread={false}
      />
    </UserContext.Provider>,
  );

describe.each(CARDS)("%s controls", (_name, Card) => {
  describe.each([
    ["mobile", MOBILE_WIDTH],
    ["desktop", DESKTOP_WIDTH],
  ])("at %s width", (_label, width) => {
    beforeEach(() => {
      setViewportWidth(width);
    });

    it("offers exactly one control, and it opens the conversation", () => {
      renderCard(Card);

      // The exact set, not a presence check. A View Route or Connect button
      // reappearing here is the regression this file exists to catch, and
      // either would slip past `getByRole(…, { name: OPEN_CONVERSATION })`.
      const labels = screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent);

      expect(labels).toEqual([OPEN_CONVERSATION]);
    });

    it("does not offer View Route", () => {
      // Stated separately from the count above because it is the specific
      // claim SCRUM-422 decided, and a reader looking for it should find it
      // by name. View Route lives in the conversation's Map tab.
      renderCard(Card);

      expect(
        screen.queryByRole("button", { name: /view route/i }),
      ).not.toBeInTheDocument();
    });
  });
});
