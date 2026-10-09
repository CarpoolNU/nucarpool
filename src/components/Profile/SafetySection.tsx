import SafetyGuidanceLink from "../SafetyGuidanceLink";

/**
 * The profile's standing route to `/safety`.
 *
 * It sits under Account beside `BlockedUsersSection` and `ReportsFiledSection`
 * because those two are where a user already goes to see what they have
 * blocked and reported, and this answers the question they arrive with. The
 * dialogs link to the same page, but only once somebody has already opened one
 * — this is the entry point for a reader who has not.
 *
 * Deliberately a link rather than the guidance itself. The page is reachable
 * without a session; duplicating its text here would put the same sentences
 * behind sign-in and let the two drift.
 */
const SafetySection = () => (
  <section aria-labelledby="safety-heading" className="pb-8">
    <h2
      id="safety-heading"
      className="font-montserrat mt-4 mb-4 text-2xl font-bold"
    >
      Safety
    </h2>
    <p className="text-gray-700">
      What reporting and blocking do, where to find them, and what to do in an
      emergency.
    </p>
    <p className="mt-2">
      <SafetyGuidanceLink />
    </p>
  </section>
);

export default SafetySection;
