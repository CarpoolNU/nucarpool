/**
 * The group-details form hook (SCRUM-377).
 *
 * `groupDetails.test.ts` already covers the pure functions this hook calls -
 * `resolveGroupDetails`, `normalizeDetails`, `trimDetails`. What it cannot
 * reach is the React wiring those functions were extracted *away* from, which
 * is where the interesting invariants live: a sync effect that must not
 * overwrite what the driver is typing, and a save path whose two previous bugs
 * were both about ordering rather than about values.
 *
 * This file also stands as the pattern for testing a hook that talks to tRPC.
 * `trpc` is mocked as a shape rather than through a real client and provider:
 * the hook's contract is "calls `updatePreferences`, invalidates two queries",
 * and a real QueryClient would test @tanstack/react-query instead. The mocks
 * are configured per test in `beforeEach` rather than inside the `jest.mock`
 * factories, because a factory runs while the module under test is being
 * required - before any `const` in this file is initialised - so anything it
 * closed over would be read in its temporal dead zone.
 *
 * **Every `stored` value below is referentially stable across renders, and has
 * to be.** The sync effect is keyed on the identity of `stored` and sets state
 * to a freshly built object, so a caller that passes a new object literal each
 * render never converges: effect, setState, render, new object, effect. Writing
 * `stored: makeStored()` inline in `renderHook` reproduces that in about ninety
 * seconds of climbing memory and then a 4GB heap-limit abort, which is how it
 * was found. `GroupPage.tsx` is safe because both of its call sites pass React
 * Query data (`user`, `group?.preferences`) straight through, and that is
 * referentially stable between fetches - but nothing in the hook says so, and
 * nothing stops the next caller from building the object. SCRUM-389; this file
 * does not work around it silently.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { useGroupDetails } from "./useGroupDetails";
import { DEFAULT_GROUP_DETAILS, StoredGroupPreferences } from "./groupDetails";

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: jest.fn(),
    user: {
      groups: {
        updatePreferences: {
          useMutation: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedTrpc = trpc as unknown as {
  useUtils: jest.Mock;
  user: { groups: { updatePreferences: { useMutation: jest.Mock } } };
};

const mockedToast = toast as unknown as {
  success: jest.Mock;
  error: jest.Mock;
};

/** Frozen so an accidental in-place edit fails loudly instead of leaking. */
const STORED: StoredGroupPreferences = Object.freeze({
  groupNotes: "Leaves from Ruggles at 7:45",
  groupMusicPreference: "Podcasts",
  groupConversationStyle: "Light chat",
});

/** A second stable value, for the tests that need `stored` to change. */
const STORED_UNTRIMMED: StoredGroupPreferences = Object.freeze({
  groupNotes: "  padded note  ",
  groupMusicPreference: " Pop ",
  groupConversationStyle: "Quiet",
});

let invalidateMe: jest.Mock;
let invalidateGroupsMe: jest.Mock;
let mutateAsync: jest.Mock;
/** The `onSuccess` the hook handed to `useMutation`, so it can be fired. */
let onMutationSuccess: (() => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();

  invalidateMe = jest.fn();
  invalidateGroupsMe = jest.fn();
  mutateAsync = jest.fn().mockResolvedValue(undefined);
  onMutationSuccess = undefined;

  mockedTrpc.useUtils.mockReturnValue({
    user: {
      me: { invalidate: invalidateMe },
      groups: { me: { invalidate: invalidateGroupsMe } },
    },
  });

  mockedTrpc.user.groups.updatePreferences.useMutation.mockImplementation(
    (options?: { onSuccess?: () => void }) => {
      onMutationSuccess = options?.onSuccess;
      return { mutateAsync };
    },
  );
});

type StoredProp = StoredGroupPreferences | null | undefined;

/** `renderHook` with a `stored` that the test can change between renders. */
const renderWithStored = (initial: StoredProp, canEdit = true) =>
  renderHook(
    ({ value }: { value: StoredProp }) =>
      useGroupDetails({ stored: value, canEdit }),
    { initialProps: { value: initial } },
  );

describe("useGroupDetails", () => {
  describe("reading stored preferences", () => {
    it("resolves the stored columns on the first render, before any effect", () => {
      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: true }),
      );

      // The `useState` initializer, not the effect. A form that started empty
      // and filled in a tick later flashes blank every time it opens.
      expect(result.current.details).toEqual({
        notes: "Leaves from Ruggles at 7:45",
        musicPreference: "Podcasts",
        conversationStyle: "Light chat",
      });
    });

    it("fills the form once the query resolves", () => {
      const { result, rerender } = renderWithStored(undefined);

      expect(result.current.details).toEqual(DEFAULT_GROUP_DETAILS);

      rerender({ value: STORED });

      expect(result.current.details.notes).toBe("Leaves from Ruggles at 7:45");
    });

    it("does not overwrite what the driver has typed while the query is still loading", () => {
      const { result, rerender } = renderWithStored(undefined);

      act(() => {
        result.current.setDetails({
          notes: "half-typed note",
          musicPreference: "",
          conversationStyle: "",
        });
      });

      // Same `undefined` again - a parent re-rendering for any other reason.
      // The effect's `stored !== undefined` guard is the only thing between
      // this and the driver's text being replaced by defaults mid-sentence,
      // and it is unreachable without a DOM.
      rerender({ value: undefined });

      expect(result.current.details.notes).toBe("half-typed note");
    });

    it("clears the form when the query resolves to no row at all", () => {
      const { result, rerender } = renderWithStored(STORED);

      expect(result.current.details.notes).toBe("Leaves from Ruggles at 7:45");

      // `null` is "loaded, and there is nothing", which is a real answer and
      // must be applied. Only `undefined` means "not loaded yet". Collapsing
      // the two - `if (stored)` instead of `if (stored !== undefined)` - would
      // leave a stale form after the row went away, and would still pass the
      // test above.
      rerender({ value: null });

      expect(result.current.details).toEqual(DEFAULT_GROUP_DETAILS);
    });
  });

  describe("saving", () => {
    it("writes trimmed values once and reports success", async () => {
      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED_UNTRIMMED, canEdit: true }),
      );

      await act(async () => {
        await result.current.save({ successMessage: "Group details saved" });
      });

      // `normalizeDetails` already trimmed these on the way in, so the
      // assertion that matters is that `save` does not re-clamp or re-slice -
      // it sends what the form holds.
      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(mutateAsync).toHaveBeenCalledWith({
        notes: "padded note",
        musicPreference: "Pop",
        conversationStyle: "Quiet",
      });
      expect(mockedToast.success).toHaveBeenCalledWith("Group details saved");
      expect(mockedToast.error).not.toHaveBeenCalled();
      expect(result.current.isSaving).toBe(false);
    });

    it("trims whitespace the driver typed rather than storing it", async () => {
      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: true }),
      );

      act(() => {
        result.current.setDetails({
          notes: "   ",
          musicPreference: "  Rock  ",
          conversationStyle: "\tTalkative\n",
        });
      });

      await act(async () => {
        await result.current.save({ successMessage: "saved" });
      });

      // A form the driver blanked out must store "", not "   " - `stored`
      // holding whitespace would count as "saved" on the next read and keep
      // the legacy fallback switched off, which is correct, but it would also
      // render as a mysteriously non-empty field.
      expect(mutateAsync).toHaveBeenCalledWith({
        notes: "",
        musicPreference: "Rock",
        conversationStyle: "Talkative",
      });
    });

    it("does not save for a rider", async () => {
      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: false }),
      );

      await act(async () => {
        await result.current.save({ successMessage: "should not appear" });
      });

      // Riders read the same value. The server refuses the write too, but a
      // request that produces a success toast on a 403 is its own bug.
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(mockedToast.success).not.toHaveBeenCalled();
      expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it("surfaces a failed write instead of claiming success", async () => {
      mutateAsync.mockRejectedValue(new Error("Notes are too long"));

      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: true }),
      );

      await act(async () => {
        await result.current.save({ successMessage: "should not appear" });
      });

      // The predecessor of this hook `await`ed a `mutate()` that returns void,
      // so the success toast fired whether or not the write landed. That is the
      // regression this asserts against - and `isSaving` clearing in `finally`
      // is what keeps the button usable after a failure.
      expect(mockedToast.success).not.toHaveBeenCalled();
      expect(mockedToast.error).toHaveBeenCalledWith(
        "Could not save your group details: Notes are too long",
      );
      expect(result.current.isSaving).toBe(false);
    });

    it("describes a non-Error rejection rather than rendering undefined", async () => {
      mutateAsync.mockRejectedValue("not an Error");

      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: true }),
      );

      await act(async () => {
        await result.current.save({ successMessage: "should not appear" });
      });

      expect(mockedToast.error).toHaveBeenCalledWith(
        "Could not save your group details: unknown error",
      );
    });

    it("refuses a second save while the first is still in flight", async () => {
      let release: () => void = () => undefined;
      mutateAsync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const { result } = renderHook(() =>
        useGroupDetails({ stored: STORED, canEdit: true }),
      );

      act(() => {
        void result.current.save({ successMessage: "saved" });
      });

      await waitFor(() => expect(result.current.isSaving).toBe(true));

      // `result.current.save` is the *re-rendered* callback, which is the one
      // a button would be holding now that `isSaving` is true. Double-clicking
      // Save must not issue two writes.
      await act(async () => {
        await result.current.save({ successMessage: "saved" });
      });

      expect(mutateAsync).toHaveBeenCalledTimes(1);

      await act(async () => {
        release();
      });

      await waitFor(() => expect(result.current.isSaving).toBe(false));
    });

    it("invalidates both queries that carry these values", () => {
      renderHook(() => useGroupDetails({ stored: STORED, canEdit: true }));

      expect(onMutationSuccess).toBeDefined();
      onMutationSuccess?.();

      // Two, because `user.me` feeds the no-group form and `groups.me` feeds
      // the one riders read. Invalidating only one leaves the other screen
      // showing the previous preferences until it refetches for another reason.
      expect(invalidateMe).toHaveBeenCalledTimes(1);
      expect(invalidateGroupsMe).toHaveBeenCalledTimes(1);
    });
  });
});
