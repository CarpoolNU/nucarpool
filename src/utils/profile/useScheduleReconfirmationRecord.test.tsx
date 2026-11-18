/**
 * The record hook's account scoping, at the hook (SCRUM-733).
 *
 * `profileScheduleReconfirmation.test.tsx` covers what a person sees on
 * `/profile`. These are the two guards that page suite cannot reach, because
 * it always remounts between accounts: no account yet, and the account
 * changing under a mounted hook.
 */

import { renderHook } from "@testing-library/react";
import {
  scheduleReconfirmationKey,
  useScheduleReconfirmationRecord,
} from "./useScheduleReconfirmationRecord";

/** 9:00 AM to 5:00 AM on the Boston wall clock: stored `14:00` to `10:00`. */
const NINE_TO_FIVE = {
  startTime: new Date(Date.UTC(1970, 0, 1, 14)),
  endTime: new Date(Date.UTC(1970, 0, 1, 10)),
};

const CONFIRMED = {
  confirmed: {
    startMinute: 540,
    endMinute: 300,
    confirmedAt: "2026-11-01T12:00:00.000Z",
  },
  snoozed: null,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("useScheduleReconfirmationRecord", () => {
  it("reads nothing, writes nothing and reports not loaded before the account is known", () => {
    const { result } = renderHook(() =>
      useScheduleReconfirmationRecord(undefined),
    );

    expect(result.current.hasLoaded).toBe(false);
    result.current.confirm(NINE_TO_FIVE);
    result.current.snooze(NINE_TO_FIVE);
    expect(window.localStorage.length).toBe(0);
  });

  it("never reports one account's record as loaded for the next", () => {
    window.localStorage.setItem(
      scheduleReconfirmationKey("user-sam"),
      JSON.stringify(CONFIRMED),
    );
    const seen: { userId: string; confirmed: unknown }[] = [];
    const { rerender } = renderHook(
      ({ userId }: { userId: string }) => {
        const state = useScheduleReconfirmationRecord(userId);
        if (state.hasLoaded) {
          seen.push({ userId, confirmed: state.record.confirmed });
        }
        return state;
      },
      { initialProps: { userId: "user-sam" } },
    );

    rerender({ userId: "user-alex" });

    expect(seen.filter((s) => s.userId === "user-sam").length).toBeGreaterThan(
      0,
    );
    // Every loaded render for the second account shows its own (empty)
    // record, including the one before its effect has read storage.
    expect(seen.filter((s) => s.userId === "user-alex")).not.toEqual([]);
    for (const s of seen.filter((s) => s.userId === "user-alex")) {
      expect(s.confirmed).toBeNull();
    }
  });
});
