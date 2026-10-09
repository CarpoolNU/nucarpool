import type { NextPage } from "next";
import Link from "next/link";
import PageTitle from "../components/PageTitle";
import { REPORT_SNAPSHOT_MESSAGE_LIMIT } from "../utils/reports";

/**
 * What reporting and blocking actually do, and what to do in an emergency.
 *
 * **No `getServerSideProps` and no session.** Every other page here either
 * redirects an anonymous visitor to sign-in or renders behind `user.me`. This
 * one must not: the reader may be a prospective user deciding whether to sign
 * up, or somebody who has just been signed out, and a redirect to Azure AD is
 * the wrong answer to "what happens if I report someone". Nothing on the page
 * is user data, so there is nothing to protect.
 *
 * **It claims only what the code does.** `user.reports.create` mails the
 * admins and tells the reported user nothing; `REPORT_URGENCY` makes
 * `SAFETY_CONCERN` the one reason that mails them immediately, with the rest
 * counted in the weekly digest; `user.blocks.block` notifies nobody, hides
 * both directions and deletes nothing; `user.blocks.unblock` reverses it.
 * Deliberately absent is any promise about what follows a review — the admin
 * queue ends at a REVIEWED status and carries no enforcement action, so a
 * sentence about accounts being removed would be a promise this product
 * cannot presently keep.
 */
const Safety: NextPage = () => (
  <>
    <PageTitle page="Safety" />
    <div className="font-montserrat h-full overflow-y-auto bg-stone-100">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="mb-6 text-3xl font-bold">Staying safe on NUCarpool</h1>

        <section
          aria-labelledby="emergency-heading"
          className="border-northeastern-red mb-8 rounded-lg border-l-4 bg-white p-5 shadow-sm"
        >
          <h2 id="emergency-heading" className="mb-2 text-xl font-bold">
            In an emergency
          </h2>
          <p className="mb-2 text-gray-800">
            If you are in immediate danger, call <strong>911</strong>. On or
            near campus you can also contact the Northeastern University Police
            Department.
          </p>
          <p className="text-gray-800">
            Nothing in this app is a substitute for emergency services. Report
            it here afterwards if you want to — but call first.
          </p>
        </section>

        <section aria-labelledby="where-heading" className="mb-8">
          <h2 id="where-heading" className="mb-2 text-2xl font-bold">
            Where to find Report and Block
          </h2>
          <p className="text-gray-800">
            Every other person you can see has a menu — the three dots on their
            card in your sidebar, and at the top of your conversation with them.
            It holds <strong>Report</strong> and <strong>Block</strong>. You do
            not need to be carpooling with somebody, or to have messaged them,
            to use either one.
          </p>
        </section>

        <section aria-labelledby="report-heading" className="mb-8">
          <h2 id="report-heading" className="mb-2 text-2xl font-bold">
            What reporting does
          </h2>
          <ul className="list-disc space-y-2 pl-5 text-gray-800">
            <li>
              Your report goes to the NUCarpool admins. It is not shown to the
              person you reported, and they are never told that you reported
              them.
            </li>
            <li>
              You choose a reason and can describe what happened. Reporting from
              a conversation also sends the admins its most recent{" "}
              {REPORT_SNAPSHOT_MESSAGE_LIMIT} messages, so you do not have to
              retype them.
            </li>
            <li>
              A report you file for a <strong>safety concern</strong> reaches
              the admins straight away. Other reasons are included in a weekly
              summary.
            </li>
            <li>
              Reporting someone offers to block them at the same time, and that
              box is ticked by default. You can untick it.
            </li>
            <li>
              Reports you have filed are listed under Account on your profile,
              with the status of each.
            </li>
          </ul>
        </section>

        <section aria-labelledby="block-heading" className="mb-8">
          <h2 id="block-heading" className="mb-2 text-2xl font-bold">
            What blocking does
          </h2>
          <ul className="list-disc space-y-2 pl-5 text-gray-800">
            <li>
              Blocking works both ways. You will not see each other in
              recommendations, on the map, in favorites, in requests or in
              messages, and neither of you can contact the other.
            </li>
            <li>
              The person you block is not told. There is no notification and no
              visible change on their side beyond no longer finding you.
            </li>
            <li>
              Nothing is deleted, and it is not permanent. You can unblock
              someone at any time from the Account section of your profile.
            </li>
            <li>
              If you are currently in a carpool group with somebody, leave the
              group first — blocking a fellow member is refused until then.
            </li>
          </ul>
        </section>

        <section aria-labelledby="before-heading" className="mb-8">
          <h2 id="before-heading" className="mb-2 text-2xl font-bold">
            Before you share a ride
          </h2>
          <ul className="list-disc space-y-2 pl-5 text-gray-800">
            <li>
              Arrange the first pickup somewhere public, and tell somebody else
              your plan.
            </li>
            <li>
              Keep the first conversations in the app, so that a report made
              later can include them.
            </li>
            <li>
              You are never obliged to accept a request, explain a refusal, or
              stay in a carpool that stops feeling right. Leaving a group needs
              no reason.
            </li>
          </ul>
        </section>

        <Link href="/" className="text-northeastern-red font-medium underline">
          Back to NUCarpool
        </Link>
      </div>
    </div>
  </>
);

export default Safety;
