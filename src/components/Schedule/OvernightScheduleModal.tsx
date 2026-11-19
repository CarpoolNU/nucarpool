import {
  Description,
  Dialog,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import type { OvernightScheduleQuestion } from "../../utils/scheduleSpan";

type OvernightScheduleModalProps = {
  question: OvernightScheduleQuestion;
  onKeep: () => void;
  onChange: () => void;
};

/**
 * Asks whether a schedule that ends at or before it starts is meant
 * (SCRUM-732). Rendered from `useOvernightScheduleConfirmation`'s `question`.
 *
 * **"Change times" is the default** - it has focus, and Escape, the backdrop
 * and nothing-pressed all mean it - because a wrong AM or PM is far more
 * common than a night shift in what this asks about, and a reflexive Enter
 * should not save the mistake. Keeping the schedule is one deliberate press.
 *
 * The question names both times and the shift's length. The length is what
 * gives a mis-pick away: a day shift with a wrong meridiem reads "20 hours".
 *
 * The panel is `UnsavedModal`'s, width floor included - see the measurement
 * recorded there for why the floor is capped at the viewport rather than
 * fixed. The button row wraps rather than overflowing where two labels do not
 * fit side by side.
 */
function OvernightScheduleModal({
  question,
  onKeep,
  onChange,
}: OvernightScheduleModalProps) {
  const fullDay = question.kind === "fullDay";

  return (
    <Dialog open onClose={onChange} className="relative z-50">
      <div className="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <DialogPanel className="relative flex w-1/3 min-w-[min(22rem,100%)] flex-col justify-center rounded-lg bg-white px-6 py-10 text-center shadow-lg">
          <DialogTitle
            as="h3"
            className="mb-4 text-xl font-semibold lg:text-2xl"
          >
            {fullDay
              ? "Is this a 24-hour shift?"
              : "Does your shift run overnight?"}
          </DialogTitle>
          <Description className="mb-2 text-gray-700">
            {fullDay
              ? `Your schedule starts and ends at ${question.start}, so it is 24 hours long.`
              : `Your schedule is ${question.start} to ${question.end}, so it ends the next day, ${question.length} after it starts.`}
          </Description>
          <p className="mb-6 text-gray-700">
            If that is not right, check AM and PM on both times.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              type="button"
              onClick={onKeep}
              className="rounded bg-gray-600 px-4 py-2 font-bold text-white hover:bg-gray-900 focus:ring-2 focus:ring-black focus:outline-hidden"
            >
              {fullDay ? "Keep 24 hours" : "Keep overnight"}
            </button>
            <button
              type="button"
              autoFocus
              onClick={onChange}
              className="bg-northeastern-red rounded px-4 py-2 font-bold text-white hover:bg-red-700 focus:ring-2 focus:ring-black focus:outline-hidden"
            >
              Change times
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
export default OvernightScheduleModal;
