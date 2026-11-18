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
 * ## One record per account
 *
 * **Namespaced by user id, unlike `dismissal.ts`.** That file accepts two
 * accounts on one browser sharing a flag, because what is shared is a
 * preference about a sentence. Here it would be one person's answer standing
 * in for another's: someone who confirmed 9:00 AM to 5:00 AM would silence
 * the question for anyone else who signs in on that browser with the same
 * stored pair, about a schedule they never looked at. That is the failure
 * this notice exists to prevent, so the record follows the account.
 *
 * The cost is the one `dismissal.ts` named: the key carries the account's id,
 * a durable identifier, on a browser that may be shared. It carries nothing
 * else about the person. The id is the `user.me` row's, which the server
 * derives from the session, so it is the authenticated user and the same
 * row whose schedule the notice describes.
 *
 * ## What is stored
 *
 * `ScheduleReconfirmationRecord`, as JSON: which pair was confirmed and when,
 * and which pair was snoozed and until when. Times are Boston wall-clock
 * minutes. See `scheduleReconfirmation.ts` for why the pair is the key.
 */

/**
 * The storage key's prefix. Versioned, so a change to the record's shape can
 * start clean rather than misread an old one. Namespaced with the feature, as
 * `RIDER_DEMAND_DISMISSED_KEY` is.
 */
export const SCHEDULE_RECONFIRMATION_KEY_PREFIX =
  "nucarpool.scheduleReconfirmation.v1";

/** The storage key for one account's record. */
export const scheduleReconfirmationKey = (userId: string): string =>
  `${SCHEDULE_RECONFIRMATION_KEY_PREFIX}.${userId}`;

/** The stored record, or `null` when storage cannot be read at all. */
const readStoredRecord = (key: string): ScheduleReconfirmationRecord | null => {
  try {
    return parseReconfirmationRecord(window.localStorage.getItem(key));
  } catch {
    return null;
  }
};

/**
 * Persist the record. Silent on failure, because the caller has already
 * updated what is on screen, and a storage error is nothing the user can act
 * on.
 */
const writeStoredRecord = (
  key: string,
  record: ScheduleReconfirmationRecord,
): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Private browsing, blocked site data, or a quota that is already full.
  }
};

/**
 * Record that `userId` confirmed `pair`, with no hook. Used by onboarding,
 * whose SCRUM-732 "Keep overnight" is a confirmation and renders no notice to
 * update. Without it, someone who kept a long overnight schedule while
 * onboarding would be asked about it again on their first profile visit.
 *
 * Call it only once the save storing `pair` has succeeded.
 */
export const rememberConfirmedSchedule = (
  userId: string,
  pair: SchedulePair,
  now: Date = new Date(),
): void => {
  const stamp = scheduleStamp(pair);

  if (stamp) {
    const key = scheduleReconfirmationKey(userId);
    writeStoredRecord(
      key,
      withConfirmation(
        readStoredRecord(key) ?? EMPTY_RECONFIRMATION_RECORD,
        stamp,
        now,
      ),
    );
  }
};

export type ScheduleReconfirmationRecordState = {
  /**
   * True once this account's record has been read. The notice renders
   * nothing before it, including while `user.me` has not yet said who the
   * account is.
   */
  hasLoaded: boolean;
  record: ScheduleReconfirmationRecord;
  /**
   * "Yes, these hours are correct", or SCRUM-732's "Keep overnight" once the
   * save that stores the kept pair has succeeded.
   */
  confirm: (pair: SchedulePair) => void;
  /** "Remind me later". */
  snooze: (pair: SchedulePair) => void;
};

/** The record as read, and whose it is. */
type LoadedRecord = { userId: string; record: ScheduleReconfirmationRecord };

/**
 * `userId`'s record as state, for the profile page. `undefined` until
 * `user.me` has answered; the hook reads nothing and answers nothing until
 * then.
 *
 * **Read after mount, never during render.** `/profile` renders on the
 * server, where there is no `localStorage`, for the reason `dismissal.ts`
 * gives. `hasLoaded` lets the page render nothing until the answer is known.
 * The loaded record remembers whose it is, so a different account's id is
 * never shown the previous one's record while its own is read.
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
 * Only this account's key counts.
 */
export const useScheduleReconfirmationRecord = (
  userId: string | undefined,
): ScheduleReconfirmationRecordState => {
  const [loaded, setLoaded] = useState<LoadedRecord | null>(null);

  useEffect(() => {
    if (!userId) {
      return;
    }

    const key = scheduleReconfirmationKey(userId);
    const load = () =>
      setLoaded({
        userId,
        record: readStoredRecord(key) ?? EMPTY_RECONFIRMATION_RECORD,
      });

    load();

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) {
        load();
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [userId]);

  const current = userId && loaded?.userId === userId ? loaded : null;
  const record = current?.record ?? EMPTY_RECONFIRMATION_RECORD;

  const answer = useCallback(
    (
      pair: SchedulePair,
      apply: typeof withConfirmation | typeof withSnooze,
    ) => {
      const stamp = scheduleStamp(pair);

      if (!userId || !stamp) {
        return;
      }

      // Outside a `setLoaded` updater on purpose: StrictMode invokes those
      // twice, and a write is a side effect.
      const key = scheduleReconfirmationKey(userId);
      const next = apply(readStoredRecord(key) ?? record, stamp, new Date());
      setLoaded({ userId, record: next });
      writeStoredRecord(key, next);
    },
    [userId, record],
  );

  const confirm = useCallback(
    (pair: SchedulePair) => answer(pair, withConfirmation),
    [answer],
  );
  const snooze = useCallback(
    (pair: SchedulePair) => answer(pair, withSnooze),
    [answer],
  );

  return { hasLoaded: current !== null, record, confirm, snooze };
};
