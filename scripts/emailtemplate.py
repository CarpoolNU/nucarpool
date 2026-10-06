"""Publish the SES email templates this app sends.

**This script mutates AWS.** It is the only script in `scripts/` that writes to
something other than the database, and the only one that was not dry-run by
default: importing it built an SES client from `.env` and `main()` overwrote
every live template immediately, printing neither the account nor the region it
was pointed at. It now follows the convention the other scripts here use.

    python3 scripts/emailtemplate.py                  # dry run, writes nothing
    python3 scripts/emailtemplate.py --apply          # publish
    python3 scripts/emailtemplate.py --base-url URL   # override the link target

Dependencies are in `scripts/requirements.txt`:

    python3 -m pip install -r scripts/requirements.txt

Credentials come from `.env` via the suffixed names the rest of the app uses
(`ACCESS_KEY_ID_AWS`, `SECRET_ACCESS_KEY_AWS`, `REGION_AWS` — see CLAUDE.md).
The dry run prints the account, the region and the link target before anything
is written, because **nothing else tells you which account you are about to
publish into** and a template published from one account is served to that
account's recipients.

The app deploy that emits the suffixed template variables must land before the
templates that read them are published. Record the run in the PR description or
a Jira comment, the way `scripts/README.md` describes — there is no run-state
table in this repository.

## Template variables

`preferredName`, `OtherUser` and `message` are user-controlled, and SES does
not escape template substitutions — see
https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html

One `TemplateData` blob feeds both parts of a template, so each part reads its
own variables and `generateEmailParams` in `src/server/emailParams.ts` emits the
same value under both:

    HtmlPart -> {{...Html}}    escaped, safe in text content and in attributes
    TextPart -> {{...Plain}}   raw, because plain text has nothing to inject into

Keep that split. An `HtmlPart` reading a `...Plain` variable is an HTML
injection bug, and a `TextPart` reading a `...Html` one shows entities to the
reader.

The unsuffixed `{{preferredName}}` / `{{OtherUser}}` / `{{message}}` are the
previous generation. They are still emitted by the app, so a template that has
not been republished keeps working, but no template here should use them any
more.
"""

import argparse
import difflib
import os
import sys

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

# The production site. Every link in every template points here unless
# --base-url or EMAIL_TEMPLATE_BASE_URL says otherwise. It used to be
# hard-coded in ten places, so a template published from a staging account
# sent staging recipients to production with nothing in the run to suggest it.
DEFAULT_BASE_URL = "https://www.carpoolnu.com"


def build_templates(base_url):
    """The templates, with every link pointing at `base_url`."""
    return [
        {
            "TemplateName": "DriverRequestTemplate",
            "SubjectPart": "New Carpool Request",
            "HtmlPart": """
        <p>Hello {{preferredNameHtml}},</p>
        <p>{{OtherUserHtml}} has sent a request to join your Carpool group. Here's a preview of their message:</p>
        <p><strong>{{messageHtml}}</strong></p>
        <p><a href="%(base)s">Click here to accept or reject the request</a></p>
        """
            % {"base": base_url},
            "TextPart": """
        Hello {{preferredNamePlain}},

        {{OtherUserPlain}} has sent a request to join your Carpool group. Here's a preview of their message:

        {{messagePlain}}

        To accept or reject the request, visit: %(base)s
        """
            % {"base": base_url},
        },
        {
            "TemplateName": "RiderRequestTemplate",
            "SubjectPart": "New Carpool Invitation",
            "HtmlPart": """
        <p>Hello {{preferredNameHtml}},</p>
        <p>{{OtherUserHtml}} sent a request for you to join their Carpool group. Here's a preview of their message:</p>
        <p><strong>{{messageHtml}}</strong></p>
        <p><a href="%(base)s">Click here to see accept or reject the request</a></p>
        """
            % {"base": base_url},
            "TextPart": """
        Hello {{preferredNamePlain}},

        {{OtherUserPlain}} sent a request for you to join their Carpool group. Here's a preview of their message:

        {{messagePlain}}

        To accept or reject the request, visit: %(base)s
        """
            % {"base": base_url},
        },
        {
            "TemplateName": "MessageNotificationTemplate",
            "SubjectPart": "New Message in Carpool NU",
            "HtmlPart": """
        <p>Hello {{preferredNameHtml}},</p>
        <p>{{OtherUserHtml}} sent you a message in Carpool NU:</p>
        <p><strong>{{messageHtml}}</strong></p>
        <p><a href="%(base)s">Click here to open Carpool NU</a></p>
        """
            % {"base": base_url},
            "TextPart": """
        Hello {{preferredNamePlain}},

        {{OtherUserPlain}} sent you a message in Carpool NU:

        {{messagePlain}}

        To view the message, visit: %(base)s
        """
            % {"base": base_url},
        },
        {
            "TemplateName": "DriverAcceptanceTemplate",
            "SubjectPart": "Request Accepted",
            "HtmlPart": """
        <p>Hello {{preferredNameHtml}},</p>
        <p>{{OtherUserHtml}} has accepted your request for them to join your group.</p>
        <p><a href="%(base)s">Click here to open Carpool NU</a></p>
        """
            % {"base": base_url},
            "TextPart": """
        Hello {{preferredNamePlain}},

        {{OtherUserPlain}} has accepted your request for them to join your group.

        To view your group, visit: %(base)s
        """
            % {"base": base_url},
        },
        {
            "TemplateName": "RiderAcceptanceTemplate",
            "SubjectPart": "Request Accepted",
            "HtmlPart": """
        <p>Hello {{preferredNameHtml}},</p>
        <p>{{OtherUserHtml}} has accepted your request to join their Carpool group.</p>
        <p><a href="%(base)s">Click here to open Carpool NU</a></p>
        """
            % {"base": base_url},
            "TextPart": """
        Hello {{preferredNamePlain}},

        {{OtherUserPlain}} has accepted your request to join their Carpool group.

        To view your group, visit: %(base)s
        """
            % {"base": base_url},
        },
        # The admin alert that a report was filed. The only template here
        # addressed to staff rather than to a student, and the only one with
        # no user-authored substitution in it at all: no reporter message, no
        # conversation snapshot, not even the two users' names. The report
        # itself is read in the queue, behind `adminRouter`, and the link
        # below is the whole point of the email.
        #
        # `reason` is a label from `REPORT_REASON_LABELS`, so SAFETY_CONCERN
        # is distinguishable from SPAM in the subject line without disclosing
        # anything a reporter typed. See `src/server/adminReportAlert.ts`.
        {
            "TemplateName": "AdminReportTemplate",
            "SubjectPart": "New NUCarpool report: {{reasonPlain}}",
            "HtmlPart": """
        <p>A NUCarpool user has filed a report.</p>
        <p>Reason given: <strong>{{reasonHtml}}</strong></p>
        <p><a href="%(base)s/admin">Open the report queue</a></p>
        <p>This notice deliberately carries no details of the report. Read it in the queue.</p>
        """
            % {"base": base_url},
            "TextPart": """
        A NUCarpool user has filed a report.

        Reason given: {{reasonPlain}}

        Open the report queue: %(base)s/admin

        This notice deliberately carries no details of the report. Read it in the queue.
        """
            % {"base": base_url},
        },
        # The weekly digest of a completed Monday-to-Sunday week, and the
        # second template addressed to staff. Most reports no longer mail
        # anybody on filing — only the critical reasons do, via the template
        # above — so this is how admins learn about the rest.
        #
        # Like that one it carries no user-authored substitution and, going
        # further, nothing that identifies a user at all: the repeat-subject
        # figures are counts rather than names, because a name in staff mail
        # would attach a reported person to an accusation they have not been
        # told about and cannot answer, while adding nothing an admin can act
        # on outside the dashboard. Every value below is a number this
        # repository counted or a label it wrote.
        #
        # An empty week still sends. A silent week cannot be told apart from a
        # broken digest, and this is the thing that tells staff a safety queue
        # needs attention, so it says "no reports" rather than saying nothing.
        # See `src/server/reportDigestSend.ts`.
        {
            "TemplateName": "AdminReportDigestTemplate",
            "SubjectPart": "NUCarpool weekly report digest: {{windowLabelPlain}}",
            "HtmlPart": """
        <p>Weekly summary of NUCarpool reports for <strong>{{windowLabelHtml}}</strong>.</p>
        <ul>
          <li><strong>{{reportCount}}</strong> new report(s)</li>
          <li><strong>{{uniqueReportedUsers}}</strong> user(s) reported</li>
          <li><strong>{{repeatedReportedUsers}}</strong> user(s) with more than one report this week</li>
          <li>Most reports about a single user: <strong>{{highestReportsAboutOneUser}}</strong></li>
          <li><strong>{{criticalReports}}</strong> of these were urgent enough to have been emailed when filed</li>
        </ul>
        <p>By reason: {{reasonBreakdownHtml}}</p>
        <p><a href="%(base)s/admin">Open the report queue</a></p>
        <p>These are counts only. Who was reported, and what was said, is in the queue.</p>
        """
            % {"base": base_url},
            "TextPart": """
        Weekly summary of NUCarpool reports for {{windowLabelPlain}}.

        New reports:                      {{reportCount}}
        Users reported:                   {{uniqueReportedUsers}}
        Users with more than one report:  {{repeatedReportedUsers}}
        Most reports about one user:      {{highestReportsAboutOneUser}}
        Already emailed when filed:       {{criticalReports}}

        By reason: {{reasonBreakdownPlain}}

        Open the report queue: %(base)s/admin

        These are counts only. Who was reported, and what was said, is in the queue.
        """
            % {"base": base_url},
        },
    ]


def parse_args(argv):
    """Arguments. No `--force`, like every other script in this directory."""
    parser = argparse.ArgumentParser(
        description=(
            "Publish the SES email templates. Dry run unless --apply is given."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually create or update the templates in SES",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("EMAIL_TEMPLATE_BASE_URL", DEFAULT_BASE_URL),
        help=(
            "base URL every template link points at (default: "
            "$EMAIL_TEMPLATE_BASE_URL, else %s). Set it when publishing into "
            "a non-production account." % DEFAULT_BASE_URL
        ),
    )
    return parser.parse_args(argv)


def describe_identity(session, region):
    """Print which account and region this run is pointed at.

    Non-fatal: `sts:GetCallerIdentity` is granted to almost everything, but a
    policy that omits it should not stop a template publish that would
    otherwise work. A run that cannot name its account says so loudly instead
    of printing nothing, which is what the script used to do.
    """
    print("Target")
    print("  region:   %s" % (region or "(unset — boto3 will fail)"))

    try:
        identity = session.client("sts").get_caller_identity()
    except (BotoCoreError, ClientError) as error:
        print("  account:  UNKNOWN (sts:GetCallerIdentity failed: %s)" % error)
        print("  identity: UNKNOWN")
        return

    print("  account:  %s" % identity.get("Account", "?"))
    print("  identity: %s" % identity.get("Arn", "?"))


def fetch_existing(ses_client, name):
    """The live template, or None when it does not exist yet."""
    try:
        return ses_client.get_template(TemplateName=name)["Template"]
    except ClientError as error:
        if error.response["Error"]["Code"] in (
            "TemplateDoesNotExist",
            "NotFoundException",
        ):
            return None
        raise


def diff_template(existing, desired):
    """Which parts of a template would change, with a unified diff of each."""
    changes = []

    for part in ("SubjectPart", "HtmlPart", "TextPart"):
        before = existing.get(part, "") or ""
        after = desired[part]
        if before == after:
            continue

        diff = difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile="live/%s" % part,
            tofile="local/%s" % part,
            lineterm="",
        )
        changes.append((part, list(diff)))

    return changes


def plan(ses_client, templates):
    """What `--apply` would do, without doing any of it."""
    actions = []

    for template in templates:
        name = template["TemplateName"]
        existing = fetch_existing(ses_client, name)

        if existing is None:
            actions.append((template, "create", []))
            continue

        changes = diff_template(existing, template)
        actions.append((template, "update" if changes else "unchanged", changes))

    return actions


def report(actions):
    """Print the plan. Returns the number of templates that would be written."""
    writes = 0

    for template, action, changes in actions:
        name = template["TemplateName"]

        if action == "unchanged":
            print("  = %s (already matches)" % name)
            continue

        writes += 1
        if action == "create":
            print("  + %s (does not exist yet)" % name)
            continue

        print("  ~ %s (%d part(s) differ)" % (name, len(changes)))
        for part, diff in changes:
            print("      %s:" % part)
            for line in diff:
                print("        %s" % line)

    return writes


def publish(ses_client, actions):
    """Create or update every template the plan says differs."""
    written = 0

    for template, action, _changes in actions:
        name = template["TemplateName"]
        body = {
            "TemplateName": name,
            "SubjectPart": template["SubjectPart"],
            "TextPart": template["TextPart"],
            "HtmlPart": template["HtmlPart"],
        }

        if action == "unchanged":
            continue

        if action == "create":
            ses_client.create_template(Template=body)
            print("  created %s" % name)
        else:
            ses_client.update_template(Template=body)
            print("  updated %s" % name)

        written += 1

    return written


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)

    load_dotenv()

    region = os.environ.get("REGION_AWS")
    session = boto3.session.Session(
        aws_access_key_id=os.environ.get("ACCESS_KEY_ID_AWS"),
        aws_secret_access_key=os.environ.get("SECRET_ACCESS_KEY_AWS"),
        region_name=region,
    )

    describe_identity(session, region)
    print("  links:    %s" % args.base_url)
    print()

    templates = build_templates(args.base_url)
    ses_client = session.client("ses")

    try:
        actions = plan(ses_client, templates)
    except (BotoCoreError, ClientError) as error:
        print("Could not read the live templates: %s" % error, file=sys.stderr)
        return 1

    print("Plan (%d template(s))" % len(templates))
    writes = report(actions)
    print()

    if writes == 0:
        print("Nothing to do — every template already matches.")
        return 0

    if not args.apply:
        print(
            "Dry run — nothing was written. %d template(s) would be "
            "created or updated." % writes
        )
        print(
            "Re-run with --apply to publish, after checking the account and "
            "region above."
        )
        return 0

    print("Publishing %d template(s)" % writes)
    try:
        written = publish(ses_client, actions)
    except (BotoCoreError, ClientError) as error:
        print("Publish failed: %s" % error, file=sys.stderr)
        return 1

    print()
    print("Published %d template(s)." % written)
    print("Record this run — see scripts/README.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
