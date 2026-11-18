import { useRef, useState } from "react";
import {
  OvernightScheduleQuestion,
  planOvernightScheduleQuestion,
  SchedulePair,
} from "../scheduleSpan";

/**
 * The save-time question for a schedule that ends at or before it starts
 * (SCRUM-732), shared by `/profile` and `/profile/setup`.
 *
 * `confirmSchedule` resolves `true` when the save may go ahead - nothing to ask,
 * or the user kept the schedule - and `false` when they chose to change it.
 * It is a promise rather than a flag so it can sit inline in a save handler
 * that is already async and already returns early on a failed check: the
 * profile page's Save and Continue awaits the same `onSubmit`, so a question
 * there pauses the save *and* the navigation behind it, and "Change times"
 * cancels both. Re-running the save from the modal instead would have lost
 * which of the two the user had pressed.
 *
 * `question` is what the page renders `OvernightScheduleModal` from; `keep` and
 * `change` are its two answers. Closing the modal any other way - Escape, the
 * backdrop - is `change`, because a schedule nobody confirmed is not saved.
 *
 * The confirmed pair is remembered for the life of the page, so a save the
 * server refuses does not ask again when it is retried. What is *stored* needs
 * no memory: `planOvernightScheduleQuestion` never asks about it.
 */
export const useOvernightScheduleConfirmation = () => {
  const [question, setQuestion] = useState<OvernightScheduleQuestion | null>(
    null,
  );
  const answer = useRef<((keep: boolean) => void) | null>(null);
  const confirmed = useRef<SchedulePair | null>(null);

  const confirmSchedule = (
    schedule: SchedulePair,
    stored: SchedulePair,
  ): Promise<boolean> => {
    const next = planOvernightScheduleQuestion({
      schedule,
      stored,
      confirmed: confirmed.current,
    });

    if (!next) {
      return Promise.resolve(true);
    }

    // A second save while the first is still waiting on its answer (a double
    // press) settles the first as unanswered, so no save is left pending
    // forever behind a modal that has moved on to the second.
    answer.current?.(false);

    return new Promise<boolean>((resolve) => {
      answer.current = (keep) => {
        answer.current = null;
        setQuestion(null);
        if (keep) {
          confirmed.current = {
            startTime: schedule.startTime,
            endTime: schedule.endTime,
          };
        }
        resolve(keep);
      };
      setQuestion(next);
    });
  };

  return {
    question,
    confirmSchedule,
    keep: () => answer.current?.(true),
    change: () => answer.current?.(false),
  };
};
