/**
 * The layout harness's entry point: argument parsing, the container-chain
 * arithmetic, the fixture registry's integrity, and **the drift guard**.
 *
 * The drift guard is the test that carries real weight. Every other test here
 * checks that the harness does what it says; the guard checks that what it
 * says is still true of the application. A fixture is a hand-copied fragment
 * of a component's markup, so the day someone edits that component the fixture
 * keeps reporting the old number - confidently, in a browser, with a
 * screenshot. `reproduces` names the class strings each fixture copied and the
 * file they came from, and the guard fails in `yarn test` the moment one is no
 * longer there.
 *
 * It costs no browser and needs no database. Nothing else in this file needs a
 * browser either; the server test binds a real socket on an OS-assigned port
 * and hands it a stub compiler, so it exercises the routing without the
 * 200ms Tailwind run.
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  banner,
  createFixtureServer,
  fixtureList,
  parseArgs,
  probeSnippet,
  PROBE_SOURCE,
  REPO_ROOT,
  STYLESHEET_ENTRY,
} from "./measure-layout";
import {
  buildFixturePage,
  composeContainerWidth,
  describeContainerWidth,
  findFixture,
  LAYOUT_FIXTURES,
} from "../src/testing/layoutFixtures";

describe("parseArgs", () => {
  it("takes no fixture, which is the request to list them", () => {
    expect(parseArgs([])).toEqual({
      fixture: undefined,
      width: undefined,
      host: "127.0.0.1",
    });
  });

  it("takes a fixture name", () => {
    expect(parseArgs(["group-member-card-trigger"]).fixture).toBe(
      "group-member-card-trigger",
    );
  });

  it.each([
    [["a", "--width", "320"], 320],
    [["a", "--width=320"], 320],
    [["--width", "320", "a"], 320],
  ])("reads a width from %j", (argv, expected) => {
    expect(parseArgs(argv).width).toBe(expected);
  });

  it("binds loopback only, never every interface", () => {
    /* A fixture page is served from a developer's machine with no
       authentication on it. 0.0.0.0 would publish it to the network. */
    expect(parseArgs([]).host).toBe("127.0.0.1");
  });

  it.each([
    ["--width", "0"],
    ["--width", "-375"],
    ["--width", "wide"],
    ["--width"],
  ])("refuses a width of %j rather than serving at NaN", (...argv) => {
    expect(() => parseArgs(["a", ...argv])).toThrow(
      /--width needs a positive number/,
    );
  });

  it("refuses an unknown option rather than ignoring it", () => {
    expect(() => parseArgs(["a", "--height", "800"])).toThrow(
      /Unknown option "--height"/,
    );
  });

  it("refuses two fixtures, which would silently measure one of them", () => {
    expect(() => parseArgs(["a", "b"])).toThrow(/Only one fixture at a time/);
  });
});

describe("composeContainerWidth", () => {
  const chain = [
    { name: "page px-4", x: 32 },
    { name: "panel border", x: 2 },
    { name: "card px-2", x: 16 },
  ];

  it("sums the chain, matching the 325px Chromium measured for the group card row", () => {
    expect(composeContainerWidth(375, chain)).toBe(325);
  });

  it.each([
    [375, 325],
    [320, 270],
    [414, 364],
  ])("at %ipx leaves %ipx", (viewport, expected) => {
    expect(composeContainerWidth(viewport, chain)).toBe(expected);
  });

  it("is the viewport itself for an empty chain", () => {
    expect(composeContainerWidth(375, [])).toBe(375);
  });

  it("floors at zero rather than reporting a negative width", () => {
    /* A chain wider than the viewport describes an overflowing layout. -25 is
       not a measurement of it, and would print as a plausible-looking figure. */
    expect(composeContainerWidth(20, chain)).toBe(0);
  });

  it("prints the derivation, so the figure can be checked by eye", () => {
    expect(describeContainerWidth(375, chain)).toBe(
      "325px  (375 − page px-4 32 − panel border 2 − card px-2 16)",
    );
  });

  it("prints a bare viewport width when there is no chain", () => {
    expect(describeContainerWidth(375, [])).toBe("375px  (375)");
  });
});

describe("the fixture registry", () => {
  it("has at least one fixture", () => {
    expect(LAYOUT_FIXTURES.length).toBeGreaterThan(0);
  });

  it("finds a fixture by name, and nothing by a name it does not have", () => {
    expect(findFixture("group-member-card-trigger")).toBeDefined();
    expect(findFixture("no-such-fixture")).toBeUndefined();
  });

  it("names every fixture uniquely", () => {
    const names = LAYOUT_FIXTURES.map((fixture) => fixture.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(LAYOUT_FIXTURES.map((fixture) => [fixture.name, fixture]))(
    "%s measures the box its container chain predicts",
    (_name, fixture) => {
      /* The prediction is only checkable against the one box it describes, so
         that box has to be among the ones actually measured. */
      expect(fixture.probe.boxes).toContain(fixture.widthProbe);
    },
  );

  it.each(LAYOUT_FIXTURES.map((fixture) => [fixture.name, fixture]))(
    "%s only names probes its own markup carries",
    (_name, fixture) => {
      const selectors = [
        ...fixture.probe.boxes,
        ...(fixture.probe.footprint ? [fixture.probe.footprint] : []),
        ...(fixture.probe.against || []),
        fixture.widthProbe,
      ];

      for (const selector of selectors) {
        const match = /\[data-probe='([^']+)'\]/.exec(selector);

        /* Every selector in a fixture is a data-probe attribute selector. A
           class or tag selector would work in the browser and would also
           silently follow a restyle. */
        expect(match).not.toBeNull();
        expect(fixture.markup).toContain(
          `data-probe="${match ? match[1] : ""}"`,
        );
      }
    },
  );

  it.each(LAYOUT_FIXTURES.map((fixture) => [fixture.name, fixture]))(
    "%s records what it measured and where the markup came from",
    (_name, fixture) => {
      expect(fixture.recorded.length).toBeGreaterThan(0);
      expect(fixture.source).toMatch(/^src\/.+\.tsx?:\d+$/);
      expect(fixture.issue).toMatch(/^SCRUM-\d+$/);
      expect(fixture.viewportWidth).toBeGreaterThan(0);
    },
  );
});

/**
 * The guard. See this file's header for why it is the one that matters.
 */
describe("fixture drift", () => {
  const cases = LAYOUT_FIXTURES.flatMap((fixture) =>
    fixture.reproduces.map((reproduced) => [
      fixture.name,
      reproduced.file,
      reproduced.className,
    ]),
  );

  it("every fixture claims to reproduce something", () => {
    for (const fixture of LAYOUT_FIXTURES) {
      expect(fixture.reproduces.length).toBeGreaterThan(0);
    }
  });

  it.each(cases)(
    "%s still matches the markup in %s",
    (_fixtureName, file, className) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");

      /* The whole class string, not a substring of it. A measurement depends
         on every utility in the list: drop `p-3` from the component and this
         fixture would go on reporting 44px for a 36px control. */
      expect(source).toContain(className);
    },
  );

  it("reads real files, so a missing one fails rather than passing vacuously", () => {
    for (const fixture of LAYOUT_FIXTURES) {
      for (const reproduced of fixture.reproduces) {
        expect(fs.existsSync(path.join(REPO_ROOT, reproduced.file))).toBe(true);
      }
    }
  });

  it("would notice a class string that is not there", () => {
    /*
     * The control for the assertion above: it has to be capable of failing.
     * Same file, a class string deliberately not in it.
     *
     * The string is the real utilities in a *different order* rather than an
     * invented one, and that is not fussiness. **Tailwind v4 scans this
     * repository, test files and their comments included, so naming a utility
     * anywhere in here emits it as CSS in the production build.** The first
     * draft of this test invented a padding utility nothing in the app uses,
     * and the compiled stylesheet grew by 52 bytes - a rule shipped to real
     * users so that a test could fail. Naming that utility in this comment to
     * explain the mistake put it straight back, which is how the figure above
     * was measured twice. Reordering costs nothing: every token below is
     * already in use in the file being read.
     */
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/Group/GroupMemberCard.tsx"),
      "utf8",
    );

    expect(source).not.toContain("text-sm rounded-lg bg-red-100 p-3");
  });
});

describe("the harness's own paths", () => {
  it("points at the stylesheet the build uses", () => {
    expect(STYLESHEET_ENTRY).toBe(
      path.join(REPO_ROOT, "src", "styles", "globals.css"),
    );
    expect(fs.existsSync(STYLESHEET_ENTRY)).toBe(true);
  });

  it("serves the same probe file the unit tests require", () => {
    expect(fs.existsSync(PROBE_SOURCE)).toBe(true);
    expect(PROBE_SOURCE).toBe(
      path.join(REPO_ROOT, "src", "testing", "layoutProbe.js"),
    );
  });

  it("resolves the repository root from this file, not from cwd", () => {
    /* `npx ts-node scripts/measure-layout.ts` from a subdirectory has to work,
       and the `@config` in globals.css resolves relative to the real path. */
    expect(fs.existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "tailwind.config.js"))).toBe(
      true,
    );
  });
});

describe("buildFixturePage", () => {
  const fixture = LAYOUT_FIXTURES[0];
  const page = buildFixturePage(fixture);

  it("mounts the fixture inside #__next, as globals.css expects", () => {
    /* `globals.css` styles that id directly - width: 100vw and a dvh height -
       so markup outside it lays out differently from the app's. */
    expect(page).toContain('<div id="__next">');
    expect(page).toContain(fixture.markup);
  });

  it("loads this project's compiled stylesheet and the shared probe", () => {
    expect(page).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(page).toContain('<script src="/probe.js"></script>');
  });

  it("carries the app's viewport meta, so mobile emulation behaves the same", () => {
    expect(page).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    );
  });

  it("says which fixture it is in the title", () => {
    expect(page).toContain(`<title>${fixture.name}`);
  });
});

describe("the fixture server", () => {
  const fixture = LAYOUT_FIXTURES[0];
  const compile = () => Promise.resolve(".stub { color: red }");
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = createFixtureServer(fixture, compile);

    await new Promise<void>((resolve) => {
      /* Port 0: the OS picks a free one. Concurrent sessions on this machine
         hold ad-hoc local servers, and a fixed port either collides - which
         presents as someone else's page rather than as a port problem - or
         invites a pkill that takes out their server. */
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const get = (
    route: string,
  ): Promise<{ status: number; type?: string; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get(`${origin}${route}`, (response) => {
          let body = "";

          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode || 0,
              type: response.headers["content-type"],
              body,
            }),
          );
        })
        .on("error", reject);
    });

  it("serves the fixture page at the root", async () => {
    const response = await get("/");

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html; charset=utf-8");
    expect(response.body).toContain('<div id="__next">');
  });

  it("serves the probe from src/testing, not a copy of it", async () => {
    const response = await get("/probe.js");

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/javascript; charset=utf-8");
    expect(response.body).toBe(fs.readFileSync(PROBE_SOURCE, "utf8"));
  });

  it("serves the compiled stylesheet", async () => {
    const response = await get("/styles.css");

    expect(response.status).toBe(200);
    expect(response.type).toBe("text/css; charset=utf-8");
    expect(response.body).toBe(".stub { color: red }");
  });

  it("answers the favicon, so the console of a measurement page stays empty", async () => {
    /* An unstyled page - a compile that failed - measures as a very small
       control and reads as a finding. A habitual 404 in the console is how
       that gets scrolled past. */
    expect((await get("/favicon.ico")).status).toBe(204);
  });

  it("404s anything else, naming the routes it has", async () => {
    const response = await get("/index.html");

    expect(response.status).toBe(404);
    expect(response.body).toContain("/styles.css");
  });

  it("reports a failed compile as a 500 rather than an empty stylesheet", async () => {
    const failing = createFixtureServer(fixture, () =>
      Promise.reject(new Error("bad @config")),
    );

    await new Promise<void>((resolve) => {
      failing.listen(0, "127.0.0.1", resolve);
    });

    const address = failing.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/styles.css`, (res) => {
            let body = "";

            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode || 0, body }));
          })
          .on("error", reject);
      },
    );

    await new Promise<void>((resolve) => {
      failing.close(() => resolve());
    });

    /* Not a 200 with an empty body: that renders as an unstyled page, which
       measures cleanly and wrongly. */
    expect(response.status).toBe(500);
    expect(response.body).toContain("bad @config");
  });
});

describe("what the harness prints", () => {
  const fixture = LAYOUT_FIXTURES[0];

  it("gives the probe call with the fixture's own spec in it", () => {
    const snippet = probeSnippet(fixture);

    expect(snippet).toContain("window.__nucarpoolLayoutProbe.report(");
    expect(snippet).toContain(fixture.probe.boxes[0]);
    /* Single-quoted attribute selectors, so the JSON does not come out full of
       escaped double quotes for a human to paste. */
    expect(snippet).not.toContain('\\"');
  });

  it("leads with the source file, the criterion and the predicted width", () => {
    const text = banner(fixture, "http://127.0.0.1:1234/", 375, 77694);

    expect(text).toContain(fixture.source);
    expect(text).toContain(fixture.issue);
    expect(text).toContain("http://127.0.0.1:1234/");
    expect(text).toContain(describeContainerWidth(375, fixture.insets));
    for (const line of fixture.recorded) {
      expect(text).toContain(line);
    }
  });

  it("says when a width is not the one the figures were recorded at", () => {
    /* Otherwise a figure taken at 320 gets compared against a 375 criterion,
       which is a mistake the harness can prevent by mentioning it. */
    expect(banner(fixture, "http://x/", 320, 1)).toContain(
      `recorded at ${fixture.viewportWidth}px, not this`,
    );
    expect(
      banner(fixture, "http://x/", fixture.viewportWidth, 1),
    ).not.toContain("not this");
  });

  it("names the gitignored directory a measurement leaves behind", () => {
    /* .playwright-mcp/ landed in the repo root twice, SCRUM-461 and SCRUM-473. */
    expect(banner(fixture, "http://x/", 375, 1)).toContain(".playwright-mcp/");
  });

  it("lists every fixture with its criterion, for a run with no arguments", () => {
    const list = fixtureList();

    for (const each of LAYOUT_FIXTURES) {
      expect(list).toContain(each.name);
      expect(list).toContain(each.issue);
    }
  });
});
