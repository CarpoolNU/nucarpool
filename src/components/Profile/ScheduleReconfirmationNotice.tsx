import { useEffect, useId, useRef } from "react";

type ScheduleReconfirmationNoticeProps = {
  /** The stored schedule in words, from `planScheduleReconfirmation`. */
  schedule: string;
  /**
   * The Carpool tab is showing, so the schedule pickers are right below. The
   * notice then says to change them there instead of offering to go there.
   */
  showsSchedulePickers: boolean;
  onConfirm: () => void;
  onUpdate: () => void;
  onRemindLater: () => void;
};

/**
 * "Please confirm your work schedule" (SCRUM-733): asks the owner of a stored
 * schedule that may have a wrong AM or PM whether it is right, on opening the
 * profile. `planScheduleReconfirmation` decides who sees it.
 *
 * **It asks and never asserts.** The schedules it appears for have the shape
 * a wrong meridiem leaves, but real long shifts have it too, and nothing in
 * the data can tell them apart. So the copy says that *some* schedules came
 * out wrong and asks the user to check theirs. It never says theirs is. The
 * schedule is shown exactly as stored, in the words the pickers' own summary
 * uses, with the length that gives a mis-pick away: "9:00 AM to 5:00 AM the
 * next day (20 hours)". It never suggests a replacement such as 5:00 PM. That
 * would be the guess this exists to avoid.
 *
 * **Inline, not a dialog**, because it is not in the way of anything. The
 * user may have opened the profile to do something else entirely, and none
 * of its three answers is urgent. A `section` named by its heading, so it is
 * reachable by landmark and heading navigation and says what it is when
 * focus lands in it.
 *
 * **None of the three writes to the server.** "Yes, these hours are correct"
 * and "Remind me later" are remembered on this device; "Update my schedule"
 * only opens the Carpool tab, where the change is the user's own save.
 *
 * **Focus never falls to the page.** "Update my schedule" is not rendered on
 * the Carpool tab, so pressing it removes the button that had focus. Focus
 * goes to the heading instead, from where Tab reaches the remaining answers
 * and then the pickers. It does not go to a picker, because an antd picker
 * opens its panel on focus.
 *
 * Every button is `type="button"`, as in `RiderDemandNotice`: one without a
 * type inside a form submits it.
 *
 * The confirm button is darker than `OvernightScheduleModal`'s gray "Keep",
 * deliberately. White on that lighter gray measures about 2.6:1, under the
 * 4.5:1 WCAG AA asks of 16px text, and here confirming is one of the two
 * answers most people will give rather than the unusual one.
 */
const ScheduleReconfirmationNotice = ({
  schedule,
  showsSchedulePickers,
  onConfirm,
  onUpdate,
  onRemindLater,
}: ScheduleReconfirmationNoticeProps) => {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingOnPickers = useRef(false);

  useEffect(() => {
    if (showsSchedulePickers && focusHeadingOnPickers.current) {
      focusHeadingOnPickers.current = false;
      headingRef.current?.focus();
    }
  }, [showsSchedulePickers]);

  return (
    <section
      aria-labelledby={headingId}
      className="border-northeastern-red/30 font-montserrat mb-6 rounded-xl border bg-stone-50 p-4 text-left"
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="mb-2 text-lg font-semibold"
      >
        Please confirm your work schedule
      </h2>
      <p className="mb-2">
        We have improved how work hours are entered. Some schedules saved before
        then came out with the wrong AM or PM, so please check yours.
      </p>
      <p className="mb-2">
        Your saved schedule is <strong>{schedule}</strong>.
      </p>
      <p className="mb-4">
        {showsSchedulePickers
          ? "Is this correct? If not, change your start or end time below and save."
          : "Is this correct?"}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-gray-600 px-4 py-2 font-bold text-white hover:bg-gray-900 focus:ring-2 focus:ring-black focus:outline-hidden"
        >
          Yes, these hours are correct
        </button>
        {!showsSchedulePickers && (
          <button
            type="button"
            onClick={() => {
              focusHeadingOnPickers.current = true;
              onUpdate();
            }}
            className="bg-northeastern-red rounded px-4 py-2 font-bold text-white hover:bg-red-700 focus:ring-2 focus:ring-black focus:outline-hidden"
          >
            Update my schedule
          </button>
        )}
        <button
          type="button"
          onClick={onRemindLater}
          className="rounded px-4 py-2 font-bold text-stone-600 underline hover:text-black"
        >
          Remind me later
        </button>
      </div>
    </section>
  );
};

export default ScheduleReconfirmationNotice;
