import { useCallback, useEffect, useState } from "react";
import type { SchedulePair } from "../scheduleSpan";
import {
  EMPTY_RECONFIRMATION_RECORD,
  parseReconfirmationRecord,
  scheduleStamp,
  withConfirmation,
  withSnooze,
  type ScheduleReconfirmationRecord,
} from "./scheduleReconfirmation";

/**
 * Where this device remembers a schedule-reconfirmation answer (SCRUM-733).
 *
 * ## Why `localStorage` and not a column
 *
 * The same trade `riderDemand/dismissal.ts` records, made for the same
 * reason. SCRUM-733's Database Risk section says `Schema change: NO`, and a
 * column is not a small exception to that on this project. It needs a
 * committed migration, a `prisma db push` to staging, and a human-owned Deploy
 * Request into production, which must land before the code that reads it or
 * `user.me` fails for everyone. That is a great deal of machinery for about
 * eighteen people whose co-ops mostly end in 2026-12.
 *
 * **The limitation, stated rather than implied away.** An answer given on a
 * laptop does not reach the same person's phone, so they are asked once more
 * there. Clearing site data or browsing privately forgets it the same way.
 * Each answer costs one press, and the record is keyed on the schedule's
 * value, so the worst case is being asked again about a schedule, never being
 * told nothing about a changed one. If being asked on a second device proves
 * to matter, this interface is what a column would sit behind. Nothing that
 * calls it would change.
 *
 * **Not namespaced by user id**, for the reason `dismissal.ts` gives. Two
 * accounts on one browser share a record, and a record only suppresses the
 * notice for the exact pair it names, so a second account is spared only when
 * it stores the identical overnight schedule.
 *
 * ## What is stored
 *
 * `ScheduleReconfirmationRecord`, as JSON: which pair was confirmed and when,
 * and which pair was snoozed and until when. Times are Boston wall-clock
 * minutes, and nothing in it identifies the user. See
 * `scheduleReconfirmation.ts` for why the pair is the key.
 */

/**
 * The storage key. Versioned, so a change to the record's shape can start
 * clean rather than misread an old one. Namespaced with the feature, as
 * `RIDER_DEMAND_DISMISSED_KEY` is.
 */
export const SCHEDULE_RECONFIRMATION_KEY =
  "nucarpool.scheduleReconfirmation.v1";

/** The stored record, or `null` when storage cannot be read at all. */
const readStoredRecord = (): ScheduleReconfirmationRecord | null => {
  try {
    return parseReconfirmationRecord(
      window.localStorage.getItem(SCHEDULE_RECONFIRMATION_KEY),
    );
  } catch {
    return null;
  }
};

/**
 * Persist the record. Silent on failure, because the caller has already
 * updated what is on screen, and a storage error is nothing the user can act
 * on.
 */
const writeStoredRecord = (record: ScheduleReconfirmationRecord): void => {
  try {
    window.localStorage.setItem(
      SCHEDULE_RECONFIRMATION_KEY,
      JSON.stringify(record),
    );
  } catch {
    // Private browsing, blocked site data, or a quota that is already full.
  }
};

/**
 * Record that the user confirmed `pair`, with no hook. Used by onboarding,
 * whose SCRUM-732 "Keep overnight" is a confirmation and renders no notice to
 * update. Without it, someone who kept a long overnight schedule while
 * onboarding would be asked about it again on their first profile visit.
 */
export const rememberConfirmedSchedule = (
  pair: SchedulePair,
  now: Date = new Date(),
): void => {
  const stamp = scheduleStamp(pair);

  if (stamp) {
    writeStoredRecord(
      withConfirmation(
        readStoredRecord() ?? EMPTY_RECONFIRMATION_RECORD,
        stamp,
        now,
      ),
    );
  }
};

export type ScheduleReconfirmationRecordState = {
  /** True once storage has been read. The notice renders nothing before it. */
  hasLoaded: boolean;
  record: ScheduleReconfirmationRecord;
  /** "Yes, these hours are correct", or SCRUM-732's "Keep overnight". */
  confirm: (pair: SchedulePair) => void;
  /** "Remind me later". */
  snooze: (pair: SchedulePair) => void;
};

/**
 * The record as state, for the profile page.
 *
 * **Read after mount, never during render.** `/profile` renders on the
 * server, where there is no `localStorage`, for the reason `dismissal.ts`
 * gives. `hasLoaded` lets the page render nothing until the answer is known.
 *
 * **Each answer updates the screen before it writes**, so the notice goes on
 * the press and still goes when the write throws. It is built on the
 * freshest stored record, falling back to this tab's state, so an answer
 * given in another tab since this one loaded is merged rather than
 * overwritten.
 *
 * **Other tabs follow.** A `storage` event fires in every *other* tab of the
 * origin when one writes, so a notice answered in one tab leaves the rest on
 * the spot rather than on their next reload. `key === null` is a `clear()`.
 */
export const useScheduleReconfirmationRecord =
  (): ScheduleReconfirmationRecordState => {
    const [record, setRecord] = useState<ScheduleReconfirmationRecord>(
      EMPTY_RECONFIRMATION_RECORD,
    );
    const [hasLoaded, setHasLoaded] = useState(false);

    useEffect(() => {
      const load = () =>
        setRecord(readStoredRecord() ?? EMPTY_RECONFIRMATION_RECORD);

      load();
      setHasLoaded(true);

      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === SCHEDULE_RECONFIRMATION_KEY) {
          load();
        }
      };

      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }, []);

    const answer = useCallback(
      (
        pair: SchedulePair,
        apply: typeof withConfirmation | typeof withSnooze,
      ) => {
        const stamp = scheduleStamp(pair);

        if (!stamp) {
          return;
        }

        // Outside a `setRecord` updater on purpose: StrictMode invokes those
        // twice, and a write is a side effect.
        const next = apply(readStoredRecord() ?? record, stamp, new Date());
        setRecord(next);
        writeStoredRecord(next);
      },
      [record],
    );

    const confirm = useCallback(
      (pair: SchedulePair) => answer(pair, withConfirmation),
      [answer],
    );
    const snooze = useCallback(
      (pair: SchedulePair) => answer(pair, withSnooze),
      [answer],
    );

    return { hasLoaded, record, confirm, snooze };
  };
