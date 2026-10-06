import { Permission, ReportReason } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { SESClient } from "@aws-sdk/client-ses";
import {
  ADMIN_ALERT_RECIPIENT_LIMIT,
  notifyAdminsOfReport,
} from "./adminReportAlert";
import { generateAdminReportEmailParams } from "./emailParams";
import { REPORT_REASON_LABELS } from "../utils/reports";

/**
 * The admin report alert.
 *
 * Three properties, in the order `adminReportAlert.ts` lists them: the alert
 * carries no user-authored text, it cannot fail the report, and it is not
 * charged to the reporter. The third is a matter of what this module does
 * *not* call, so it is asserted here as the absence of any `$executeRaw` on
 * the Prisma surface it is given — `claimEmailBudget` is raw SQL and nothing
 * else in this path writes.
 *
 * That the whole mutation survives a failing send is in `reports.test.ts`,
 * and against a real database in `reports.db.test.ts`. Whether mail actually
 * arrives cannot be checked from here at all: SES credentials live only in
 * `.env`, and `AdminReportTemplate` is not published until someone runs
 * `scripts/emailtemplate.py --apply`.
 */

/** An admin roster. `null` emails are users we hold no address for. */
const buildPrisma = (
  admins: { email: string | null; permission?: Permission }[],
) => {
  const findMany = jest.fn(async () => admins.map(({ email }) => ({ email })));
  return { prisma: { user: { findMany } }, findMany };
};

const buildSes = () => {
  const send = jest.fn(async () => ({}));
  return { ses: { send }, send };
};

/** The `TemplateData` of the one command SES was handed, parsed back. */
const sentTemplateData = (send: jest.Mock) => {
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0][0];
  return JSON.parse(command.input.TemplateData as string);
};

const sentCommand = (send: jest.Mock) => send.mock.calls[0][0].input;

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the alert's template parameters", () => {
  it("carry the reason label and nothing else at all", () => {
    const params = generateAdminReportEmailParams({
      recipientEmails: ["admin@northeastern.edu"],
      reasonLabel: REPORT_REASON_LABELS.SAFETY_CONCERN,
    });

    // An exact key set, not a set of `not.toContain` checks. A field added to
    // this template later has to be declared here deliberately, which is the
    // point: the risk is a future edit quietly passing the reporter's message
    // through, and a test that only forbids today's field names would not
    // catch it.
    expect(
      Object.keys(JSON.parse(params.TemplateData as string)).sort(),
    ).toEqual(["reasonHtml", "reasonPlain"]);
    expect(params.Template).toBe("AdminReportTemplate");
  });

  it("names a reason an admin can triage by", () => {
    const params = generateAdminReportEmailParams({
      recipientEmails: ["admin@northeastern.edu"],
      reasonLabel: REPORT_REASON_LABELS.SAFETY_CONCERN,
    });

    const data = JSON.parse(params.TemplateData as string);
    expect(data.reasonPlain).toBe("Safety concern");
    expect(data.reasonHtml).toBe("Safety concern");
  });
});

describe("notifyAdminsOfReport", () => {
  it("mails every non-USER user we hold an address for", async () => {
    const { prisma, findMany } = buildPrisma([
      { email: "manager@northeastern.edu" },
      { email: "admin@northeastern.edu" },
    ]);
    const { ses, send } = buildSes();

    const outcome = await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.HARASSMENT,
    );

    expect(outcome).toEqual({ sent: true, recipientCount: 2 });
    expect(findMany).toHaveBeenCalledWith({
      where: { permission: { not: Permission.USER } },
      select: { email: true },
    });
    expect(sentCommand(send).Destination).toEqual({
      ToAddresses: ["manager@northeastern.edu", "admin@northeastern.edu"],
    });
  });

  it("puts the report's reason in the alert", async () => {
    const { prisma } = buildPrisma([{ email: "admin@northeastern.edu" }]);
    const { ses, send } = buildSes();

    await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.SAFETY_CONCERN,
    );

    expect(sentTemplateData(send).reasonPlain).toBe("Safety concern");
  });

  it("skips an admin we hold no email address for", async () => {
    const { prisma } = buildPrisma([
      { email: null },
      { email: "admin@northeastern.edu" },
    ]);
    const { ses, send } = buildSes();

    await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.OTHER,
    );

    expect(sentCommand(send).Destination.ToAddresses).toEqual([
      "admin@northeastern.edu",
    ]);
  });

  it("caps the recipient list rather than letting SES refuse the whole send", async () => {
    const { prisma } = buildPrisma(
      Array.from({ length: ADMIN_ALERT_RECIPIENT_LIMIT + 5 }, (_, i) => ({
        email: `admin-${i}@northeastern.edu`,
      })),
    );
    const { ses, send } = buildSes();

    const outcome = await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.OTHER,
    );

    expect(outcome).toEqual({
      sent: true,
      recipientCount: ADMIN_ALERT_RECIPIENT_LIMIT,
    });
    expect(sentCommand(send).Destination.ToAddresses).toHaveLength(
      ADMIN_ALERT_RECIPIENT_LIMIT,
    );
  });

  it("sends nothing, and does not throw, when there is no admin to tell", async () => {
    const { prisma } = buildPrisma([]);
    const { ses, send } = buildSes();

    const outcome = await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.OTHER,
    );

    expect(outcome).toEqual({ sent: false, reason: "no_recipients" });
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves rather than rejecting when SES refuses the send", async () => {
    const { prisma } = buildPrisma([{ email: "admin@northeastern.edu" }]);
    const ses = {
      send: jest.fn(async () => {
        // What SES answers until `scripts/emailtemplate.py --apply` has been
        // run, which is the state this ships in.
        throw new Error("TemplateDoesNotExist");
      }),
    };

    await expect(
      notifyAdminsOfReport(
        prisma as unknown as PrismaClient,
        ses as unknown as SESClient,
        ReportReason.SAFETY_CONCERN,
      ),
    ).resolves.toEqual({ sent: false, reason: "send_failed" });
  });

  it("resolves rather than rejecting when the recipient read itself fails", async () => {
    const prisma = {
      user: {
        findMany: jest.fn(async () => {
          throw new Error("connection lost");
        }),
      },
    };
    const { ses, send } = buildSes();

    await expect(
      notifyAdminsOfReport(
        prisma as unknown as PrismaClient,
        ses as unknown as SESClient,
        ReportReason.SAFETY_CONCERN,
      ),
    ).resolves.toEqual({ sent: false, reason: "send_failed" });
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * The budget exemption, as a property of this module rather than of its
   * documentation. `claimEmailBudget` reaches the database through
   * `$executeRaw` and nothing else on this path writes at all, so a Prisma
   * surface carrying only `user.findMany` is sufficient for a successful
   * send — and would not be if the alert were charged to anyone.
   */
  it("claims no email budget: it needs no write surface to send", async () => {
    const executeRaw = jest.fn();
    const prisma = {
      user: { findMany: jest.fn(async () => [{ email: "a@b.com" }]) },
      $executeRaw: executeRaw,
    };
    const { ses, send } = buildSes();

    const outcome = await notifyAdminsOfReport(
      prisma as unknown as PrismaClient,
      ses as unknown as SESClient,
      ReportReason.SAFETY_CONCERN,
    );

    expect(outcome).toEqual({ sent: true, recipientCount: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
