import superjson from "superjson";
import type { Member } from "../../community/actor";
import { FakeCommunityHost } from "../../community/host/fakeHost";
import { PostService } from "../../community/content/service";
import {
  ProfileService,
  asProfileReader,
} from "../../community/identity/service";
import { FakeProfileRepository } from "../../community/testing/fakeProfileRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../../community/testing/fakeContentRepositories";

/**
 * What the profile endpoints put on the wire.
 *
 * **This asserts on the serialized payload, not on the type**, and that is the
 * whole point of the file. `PublicProfile` and `PublicPost` having no identity
 * fields is the §13.1 mechanism, but a type is exactly what a future change
 * widens quietly — adding one field to one DTO is a small diff that reads as
 * harmless and ships a user id to every reader of a profile page. Serializing
 * through `superjson`, which is the transformer `createRouter.ts` installs,
 * and then walking the result is the assertion that cannot be satisfied by
 * accident.
 *
 * The profile page is where this matters most: it is the one surface whose
 * purpose is to gather a single person's output, so it is the one where a
 * leaked id is a map from a handle to a Northeastern account.
 */

const AVERY: Member = {
  kind: "member",
  userId: "nucarpool-user-id-avery",
  profile: { id: "profile-row-avery", handle: "Avery" },
};
const VIEWER: Member = {
  kind: "member",
  userId: "nucarpool-user-id-viewer",
  profile: { id: "profile-row-viewer", handle: "Reader" },
};

/** Every string that must never reach a client, whatever key it hides under. */
const FORBIDDEN_VALUES = [AVERY.userId, VIEWER.userId];

/** Every key name that must never appear, whatever it happens to hold. */
const FORBIDDEN_KEYS = [
  "authorId",
  "author_id",
  "userId",
  "user_id",
  "email",
  "name",
  "handleNormalized",
  "handle_normalized",
];

/** Collects every key and every string leaf in a serialized payload. */
const walk = (
  value: unknown,
  keys: string[] = [],
  strings: string[] = [],
): { keys: string[]; strings: string[] } => {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, strings);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      walk(item, keys, strings);
    }
  }
  return { keys, strings };
};

const onTheWire = (payload: unknown) =>
  walk(JSON.parse(JSON.stringify(superjson.serialize(payload))));

const build = async () => {
  const posts = new FakePostRepository();
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AVERY, VIEWER]) {
    host.withAccount(member.userId);
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const postService = new PostService(
    posts,
    categories,
    asProfileReader(profileRepo),
    host,
  );
  await postService.create(AVERY, {
    categorySlug: "commuting",
    title: "Which garage is cheapest after 4pm",
    content: "Renaissance is $9 flat after four.",
  });

  return {
    profiles: new ProfileService(profileRepo, host),
    posts: postService,
  };
};

describe("the profile endpoints on the wire", () => {
  it("serializes a profile with no identity fields and no user id", async () => {
    const { profiles } = await build();

    const { keys, strings } = onTheWire(
      await profiles.byHandle(VIEWER, "avery"),
    );

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(strings).not.toContain(forbidden);
    }
  });

  it("serializes a profile's posts with no identity fields and no user id", async () => {
    const { posts } = await build();

    const page = await posts.listByHandle(VIEWER, { handle: "avery" });
    const { keys, strings } = onTheWire(page);

    // The page is not empty, or this would assert nothing at all.
    expect(page.posts).toHaveLength(1);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(strings).not.toContain(forbidden);
    }
  });

  it("puts the handle on the wire, which is the one identity a reader gets", async () => {
    const { profiles, posts } = await build();

    const profile = onTheWire(await profiles.byHandle(VIEWER, "avery"));
    const page = onTheWire(
      await posts.listByHandle(VIEWER, { handle: "avery" }),
    );

    // The inverse of the assertions above: the payload is checked for absence,
    // so it also has to be checked for presence, or a procedure that returned
    // nothing would pass both of them.
    expect(profile.strings).toContain("Avery");
    expect(page.strings).toContain("Avery");
  });
});
