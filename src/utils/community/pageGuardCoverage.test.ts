/**
 * Every page under `src/pages/community/` exports `communityPageGuard`.
 *
 * The guard is opt-in: a page that does not export it is served to anyone,
 * whether or not Community is enabled. So any page added there, including the
 * ones part 4 of SCRUM-743 brings, has to pass this test before it can merge.
 *
 * **Identity, not a text match.** Each module is required, and its
 * `getServerSideProps` must be the guard object itself. A wrapper, a copy, or
 * an export of the same name from somewhere else fails. A page that needs
 * props of its own must change the guard, and that change is reviewed there.
 *
 * **Every file, not only `.tsx`.** Every extension in `pageExtensions` makes a
 * file under `src/pages/` a route, so a `.ts` page is checked the same way.
 *
 * It lives outside `src/pages/` because a test file there would also be a
 * route. See `docs/testing.md`.
 */
import { readdirSync } from "fs";
import path from "path";
import { communityPageGuard } from "./pageGuard";

/*
 * The guard's own imports, stubbed as `pageGuard.test.ts` stubs them. The
 * real `authOptions` would load the NextAuth server config, its Prisma
 * adapter and the AWS clients behind it, none of which this check needs.
 */
jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const communityPages = path.join(repoRoot, "src", "pages", "community");

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

/** The pages whose `getServerSideProps` is anything other than the guard. */
const unguarded = (
  pages: ReadonlyArray<{ file: string; module: Record<string, unknown> }>,
): string[] =>
  pages
    .filter(({ module }) => module.getServerSideProps !== communityPageGuard)
    .map(({ file }) => file);

const pages = filesUnder(communityPages).map((file) => ({
  file: path.relative(repoRoot, file),
  module: require(file) as Record<string, unknown>,
}));

describe("every Community page exports communityPageGuard", () => {
  /*
   * Membership, not a count. A scan that read nothing, or read the wrong
   * directory, would pass the last test with no pages checked.
   */
  it("scans the pages that exist", () => {
    expect(pages.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        path.join("src", "pages", "community", "index.tsx"),
        path.join("src", "pages", "community", "search.tsx"),
        path.join("src", "pages", "community", "u", "[handle].tsx"),
      ]),
    );
  });

  /*
   * The two ways a page can miss the guard. If either passed, the scan below
   * would pass vacuously.
   */
  it("reports a page that exports no getServerSideProps", () => {
    expect(
      unguarded([{ file: "bare.tsx", module: { default: () => null } }]),
    ).toEqual(["bare.tsx"]);
  });

  it("reports a page whose getServerSideProps is not the guard", () => {
    const lookalike = async () => ({ props: {} });

    expect(
      unguarded([
        { file: "lookalike.tsx", module: { getServerSideProps: lookalike } },
      ]),
    ).toEqual(["lookalike.tsx"]);
  });

  it("finds every page guarded", () => {
    expect(unguarded(pages)).toEqual([]);
  });
});
