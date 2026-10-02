import { readFileSync } from "fs";
import { join } from "path";

/**
 * The Node major is stated in four places, and they have to agree.
 *
 *   .nvmrc                      what a developer and CI install
 *   engines.node                what the manifest claims to support
 *   @types/node (declared)      what the manifest asks the compiler to use
 *   @types/node (installed)     what `yarn tsc` actually reads
 *
 * The first two are about the runtime and tend to be edited together. The
 * third drifts on its own — it is a devDependency, so a major bump reads like
 * any other version bump and nothing downstream complains.
 *
 * That is what SCRUM-614 found: `@types/node` sat on 26.6.2 while `.nvmrc`
 * said 22. The failure mode is silent and inverted — the type check does not
 * fail, it *passes more than it should*, describing APIs the deployed runtime
 * does not have. `URLPattern` from `node:url` is one: Node 24 added it, Node
 * 22.23.2 has it as `undefined`, and @types/node 26 type-checks it happily.
 * The symptom is a green `yarn tsc`, which is why nothing caught it.
 *
 * Every assertion below reads raw text and compares it to raw text. An earlier
 * draft parsed each source into a major and compared the numbers, which was
 * neater and weaker: stubbing the parser to a constant made all of those
 * comparisons agree and the suite stayed green. Nothing here goes through a
 * shared parser, so there is no single thing that can be wrong everywhere at
 * once.
 *
 * Only the major is pinned. Patch and minor drift is normal and harmless —
 * `@types/node` releases far more often than Node does, and `.nvmrc` pins a
 * line rather than a build.
 */

const repoRoot = __dirname;

const readFile = (name: string): string =>
  readFileSync(join(repoRoot, name), "utf8");

const manifest = (): {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} => JSON.parse(readFile("package.json"));

/** The Node major, as `.nvmrc` states it. Every other assertion is against this. */
const nvmrc = (): string => readFile(".nvmrc").trim();

const declaredTypesNode = (): string => {
  const pkg = manifest();
  const spec =
    pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"];

  if (spec === undefined) {
    throw new Error("package.json declares no @types/node");
  }
  return spec;
};

describe("the Node major agrees everywhere it is written down", () => {
  it("pins .nvmrc to 22", () => {
    // The one hard-coded value, and deliberately so: this is the line a real
    // Node upgrade has to come through, rather than the upgrade being inferred
    // from whatever the other three happen to say.
    expect(nvmrc()).toBe("22");
  });

  it("declares engines.node on the .nvmrc major", () => {
    expect(manifest().engines?.node).toBe(`${nvmrc()}.x`);
  });

  it("declares @types/node on the .nvmrc major", () => {
    // A caret inside the major: patch and minor typings updates are wanted,
    // crossing into the next major is the defect this file exists for.
    expect(declaredTypesNode()).toMatch(new RegExp(`^\\^${nvmrc()}\\.`));
  });

  /**
   * The manifest is what a reviewer reads; the installed tree is what the
   * compiler reads. A lockfile can satisfy the range and still resolve
   * somewhere unexpected, so this asserts the copy `tsc` loads.
   *
   * `require.resolve` from the repo root finds the hoisted top-level package.
   * Nested copies exist — jest's own dependencies ask for `@types/node@*`,
   * which still resolves to the 26 line — but those sit under
   * `node_modules/jest-*` and `node_modules/@types/jest`, outside `typeRoots`.
   * `tsc --explainFiles` confirms none of them enter the program.
   */
  it("resolves an installed @types/node on the .nvmrc major", () => {
    const installed = JSON.parse(
      readFileSync(
        require.resolve("@types/node/package.json", { paths: [repoRoot] }),
        "utf8",
      ),
    ) as { version: string };

    expect(installed.version).toMatch(new RegExp(`^${nvmrc()}\\.`));
  });
});
