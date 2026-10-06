/**
 * The contract between the `TemplateData` this app sends and the SES templates
 * `emailtemplate.py` publishes.
 *
 * `scripts/README.md` records that `emailtemplate.py` is "the one script here
 * whose planning half nothing in `yarn test` covers", because there is no
 * Python test setup in this repository. That is still true of its AWS calls,
 * its diffing and its argument parsing — but the *template bodies* are text,
 * and the thing most likely to go wrong about them is checkable from here.
 *
 * **The failure this prevents.** A template renders `{{someKey}}` and the
 * sender supplies `someOtherKey`; SES does not error, it substitutes empty
 * string. So the mail arrives looking plausible with a number missing from
 * the middle of it, and nothing in the repository disagrees with itself. Two
 * files have to be edited together and nothing made them.
 *
 * This reads the Python as text rather than importing it, so it needs no
 * Python interpreter and runs in the ordinary `yarn test` node project.
 */

import { readFileSync } from "fs";
import path from "path";
import {
  generateAdminReportDigestEmailParams,
  generateAdminReportEmailParams,
} from "../src/server/emailParams";
import { REPORT_REASON_LABELS } from "../src/utils/reports";

const TEMPLATE_SOURCE = readFileSync(
  path.join(__dirname, "emailtemplate.py"),
  "utf8",
);

/**
 * Every `{{name}}` in one template's definition.
 *
 * The file is a Python list of dicts, each opening with `"TemplateName":`, so
 * a template's definition runs from its own name to the next one or to the end
 * of the list. Crude, and guarded by the self-checks below rather than trusted.
 */
const placeholdersFor = (templateName: string): string[] => {
  const marker = `"TemplateName": "${templateName}"`;
  const start = TEMPLATE_SOURCE.indexOf(marker);

  if (start === -1) {
    throw new Error(
      `${templateName} is not defined in scripts/emailtemplate.py`,
    );
  }

  const rest = TEMPLATE_SOURCE.slice(start + marker.length);
  const nextTemplate = rest.indexOf('"TemplateName":');
  const section = nextTemplate === -1 ? rest : rest.slice(0, nextTemplate);

  return [...section.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
};

/** The keys a builder puts in `TemplateData`. */
const keysOf = (params: { TemplateData?: string }): string[] =>
  Object.keys(JSON.parse(params.TemplateData as string)).sort();

const digestParams = generateAdminReportDigestEmailParams({
  recipientEmails: ["admin@northeastern.edu"],
  windowLabel: "28 Sep – 4 Oct 2026",
  reasonBreakdown: "Safety concern: 1",
  reportCount: 3,
  uniqueReportedUserCount: 2,
  repeatedReportedUserCount: 1,
  highestReportsAboutOneUser: 2,
  criticalReportCount: 1,
});

/**
 * The extraction is a regex over someone else's file format, so it is checked
 * before it is relied on. A test built on a scan that silently matched nothing
 * would pass while proving nothing — so one placeholder known to be present is
 * named, one known to belong to a *different* template is excluded, and the
 * pattern is exercised against text where it must find nothing.
 */
describe("the placeholder extraction itself", () => {
  it("finds a known placeholder in the template it belongs to", () => {
    expect(placeholdersFor("AdminReportDigestTemplate")).toContain(
      "windowLabelPlain",
    );
  });

  it("does not leak placeholders from a neighbouring template", () => {
    // `AdminReportTemplate` is defined immediately before the digest and uses
    // `reasonPlain`; the student-facing ones use `preferredName`. Either
    // appearing in the digest's set would mean the section boundary is wrong.
    const digest = placeholdersFor("AdminReportDigestTemplate");

    expect(digest).not.toContain("preferredName");
    expect(digest).not.toContain("reasonPlain");
    expect(placeholdersFor("AdminReportTemplate")).not.toContain(
      "windowLabelPlain",
    );
  });

  it("refuses a template that is not defined", () => {
    expect(() => placeholdersFor("NoSuchTemplate")).toThrow(
      "not defined in scripts/emailtemplate.py",
    );
  });

  it("finds the student templates too, so the scan is not digest-shaped", () => {
    expect(placeholdersFor("DriverRequestTemplate")).toContain(
      "preferredNameHtml",
    );
  });
});

describe("AdminReportDigestTemplate", () => {
  /**
   * The bidirectional check, and the whole point of this file. Set equality
   * rather than containment in either direction: a key sent but not rendered
   * is a number missing from the email, and a placeholder rendered but not
   * sent is an empty gap in it.
   */
  it("renders exactly the keys the digest sender supplies", () => {
    expect(placeholdersFor("AdminReportDigestTemplate")).toEqual(
      keysOf(digestParams),
    );
  });

  it("is the template the digest sender addresses", () => {
    expect(digestParams.Template).toBe("AdminReportDigestTemplate");
  });

  /**
   * The privacy guarantee, asserted against the template rather than the
   * sender. Even if a future edit started supplying a reporter's message, the
   * published template has nowhere to render it — and a placeholder added here
   * for one would fail the set equality above.
   */
  it("has no placeholder for user-authored text or any identifier", () => {
    const placeholders = placeholdersFor("AdminReportDigestTemplate");

    for (const forbidden of [
      "message",
      "messageHtml",
      "messagePlain",
      "conversationSnapshot",
      "snapshot",
      "preferredName",
      "OtherUser",
      "reportedUserId",
      "reporterId",
      "email",
    ]) {
      expect(placeholders).not.toContain(forbidden);
    }
  });

  /** The link is the actionable half of the email. */
  it("links to the admin dashboard in both parts", () => {
    const marker = '"TemplateName": "AdminReportDigestTemplate"';
    const section = TEMPLATE_SOURCE.slice(TEMPLATE_SOURCE.indexOf(marker));

    expect(section).toContain("/admin");
    // Once in the HtmlPart as an anchor and once in the TextPart as a bare
    // URL, so a plain-text reader gets it too.
    expect(section.match(/\/admin/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AdminReportTemplate", () => {
  /**
   * The immediate alert, covered by the same check. It is not changed by
   * SCRUM-625, and this is here so that the pair of staff templates is held to
   * one rule rather than the newer one being the only one checked.
   */
  it("renders exactly the keys the immediate alert supplies", () => {
    const params = generateAdminReportEmailParams({
      recipientEmails: ["admin@northeastern.edu"],
      reasonLabel: REPORT_REASON_LABELS.SAFETY_CONCERN,
    });

    expect(placeholdersFor("AdminReportTemplate")).toEqual(keysOf(params));
  });
});
