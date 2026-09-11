/**
 * That the conversation header's mobile branch costs no avatar request.
 *
 * `MessageHeader` calls `useProfileImage(selectedUser.id)` above its
 * `if (ismobile)` branch, and that branch renders a back arrow and a name and
 * no avatar at all. So every mobile conversation opened fired an authenticated
 * presigned-URL request whose result was thrown away — and each one performs
 * an S3 `HeadObject` on the server. `staleTime` means reopening the *same*
 * conversation is free, so the cost is one wasted round trip per distinct
 * conversation per window.
 *
 * **Why this file mocks `trpc` onto real React Query rather than onto a spy,
 * and why it is a second file at all.** `MessageHeader.test.tsx` stubs
 * `useProfileImage` as a shape, which is right for the question that file asks
 * — which controls exist at each viewport — and useless for this one: a stubbed
 * hook makes no request either way, so it cannot tell a fix from a no-op. A
 * render-time spy on `useQuery` is no better, because it fires whether or not
 * the query is enabled. What has to be established is that **the fetch does
 * not go out**, so `useQuery` here is the real one behind a spy `queryFn` —
 * the same construction, and for the same reason, as
 * `utils/useProfileImage.test.tsx`. A module mock is per file, so this cannot
 * live beside the shape-stubbed suite.
 *
 * Measured against the pre-fix component, the mobile case reported **1**.
 */

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Role, Status } from "@prisma/client";
import MessageHeader from "./MessageHeader";
import { EnhancedPublicUser } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * A path rather than an absolute URL: `next/image` validates a remote `src`
 * against `images.remotePatterns` and throws for a host it does not know, so
 * an invented S3 hostname would fail the desktop render for a reason that has
 * nothing to do with this ticket.
 */
const AVATAR_URL = "/avatar.png";

const queryFn = jest.fn(async () => ({ url: AVATAR_URL }));

/**
 * `trpc.user.getPresignedDownloadUrl.useQuery` as the React Query call it
 * compiles down to. The `options` spread is what carries `enabled` through, so
 * a fix that built the flag but failed to pass it shows up here as a fetch
 * that still happens.
 */
jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        getPresignedDownloadUrl: {
          useQuery: (input: { userId?: string }, options: object) =>
            reactQuery.useQuery({
              queryKey: ["getPresignedDownloadUrl", input],
              queryFn: () => queryFn(),
              ...options,
            }),
        },
      },
    },
  };
});

restoreViewportAfterEach();

beforeEach(() => {
  queryFn.mockClear();
});

const SELECTED_USER = {
  id: "other-1",
  preferredName: "Riley",
  role: Role.DRIVER,
  status: Status.ACTIVE,
  carpoolId: null,
  isFavorited: false,
} as unknown as EnhancedPublicUser;

const renderHeader = (width: number) => {
  setViewportWidth(width);

  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MessageHeader
        selectedUser={SELECTED_USER}
        onAccept={() => undefined}
        onReject={() => undefined}
        onClose={() => undefined}
        groupId={null}
      />
    </QueryClientProvider>,
  );
};

describe("the mobile conversation header", () => {
  it("requests no avatar, because it renders none", () => {
    renderHeader(MOBILE_WIDTH);

    // The branch really did render - otherwise this would pass for a header
    // that failed to render anything at all.
    expect(screen.getByText("Riley")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to conversations" }),
    ).toBeInTheDocument();

    // The whole ticket. One authenticated presigned-URL request, and one S3
    // HeadObject behind it, per conversation opened on a phone.
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("renders neither an avatar nor its placeholder", () => {
    // The reason the request was pointless, stated as a property of the tree
    // rather than trusted: nothing on this branch consumes the three values
    // the hook returns.
    const { container } = renderHeader(MOBILE_WIDTH);

    expect(container.querySelector("img")).toBeNull();
    // `AiOutlineUser`, the "no picture" fallback, is the only svg the desktop
    // branch draws in that slot; the back arrow is the only one here.
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });
});

describe("the desktop conversation header", () => {
  it("still requests the avatar", () => {
    // The other side of the gate. A fix that simply stopped fetching would
    // pass every assertion above and break the header this hook exists for.
    renderHeader(DESKTOP_WIDTH);

    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("draws the avatar once the URL arrives", async () => {
    // AC: the desktop branch's avatar is unchanged. The other suite for this
    // component stubs the hook with a null URL, so this is the only place the
    // resolved path is exercised at all - and a gate that accidentally
    // disabled desktop too would show up here rather than in a review.
    renderHeader(DESKTOP_WIDTH);

    expect(
      await screen.findByAltText("Riley's Profile Image"),
    ).toBeInTheDocument();
  });

  it("shows a neutral placeholder while the URL resolves, not the fallback", () => {
    // AC: no loading state flashes. A disabled React Query observer is
    // `pending` with `fetchStatus: "idle"`, so a naive `isLoading` read goes
    // false while the query is merely held back - and this header would then
    // paint the "no picture" icon for a user who has one. `useProfileImage`
    // answers that with `isLoading || (!isHydrated && isPending)`, and the
    // gate must not undo it.
    const { container } = renderHeader(DESKTOP_WIDTH);

    // The placeholder is a bare div; the fallback is an svg. On the first
    // render the URL is unknown, so it must be the former.
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
