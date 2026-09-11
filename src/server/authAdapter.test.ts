import { ACCOUNT_DELETION_UNSUPPORTED, createAuthAdapter } from "./authAdapter";

/**
 * The NextAuth adapter.
 *
 * This was an object literal inside `src/pages/api/auth/[...nextauth].ts`,
 * where no test could reach it — a filename under `src/pages/` is also a
 * route, so a co-located test would be compiled and served as one. Moving it
 * beside `authSignIn.ts` is the pattern that file's own comment describes.
 *
 * Two behaviours are pinned. `deleteUser` refusing is what SCRUM-311 decided;
 * `createUser` discarding the provider's `image` was already load-bearing and
 * had no test at all, which is the more valuable half of doing this.
 */

/** Just enough client for the two overrides; `PrismaAdapter` needs the rest. */
const clientStub = () => {
  const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "user-1",
    email: "student@northeastern.edu",
    ...args.data,
  }));

  return {
    create,
    client: { user: { create } } as unknown as Parameters<
      typeof createAuthAdapter
    >[0],
  };
};

describe("createAuthAdapter — deleteUser", () => {
  it("refuses, rather than inheriting a primitive that cannot work", async () => {
    // `PrismaAdapter` supplies a working-looking `deleteUser`. It would fail
    // for any user who has ever sent a request or a message — every real user
    // — because `Request.fromUser`, `Request.toUser` and `Message.User`
    // declare no `onDelete` and default to emulated `Restrict`.
    const { client } = clientStub();
    const adapter = createAuthAdapter(client);

    await expect(adapter.deleteUser!("user-1")).rejects.toThrow(
      ACCOUNT_DELETION_UNSUPPORTED,
    );
  });

  it("says why, and names where the decision is recorded", async () => {
    // The point of refusing here rather than letting Prisma raise a
    // referential-action error later: the message has to send the next person
    // to the decision, not to the cascade.
    const { client } = clientStub();

    await expect(
      createAuthAdapter(client).deleteUser!("user-1"),
    ).rejects.toThrow(/SCRUM-311/);
    expect(ACCOUNT_DELETION_UNSUPPORTED).toContain("db/README.md");
  });

  it("deletes nothing on the way to refusing", async () => {
    // `Account` and `Session` *do* cascade. A refusal that ran any part of the
    // delete first would take those with it and leave the user unable to sign
    // in — a worse outcome than the opaque error this replaces.
    const { client, create } = clientStub();

    await expect(
      createAuthAdapter(client).deleteUser!("user-1"),
    ).rejects.toThrow();

    expect(create).not.toHaveBeenCalled();
  });

  it("is present, so a caller gets the refusal rather than undefined", () => {
    // If the override were dropped, `deleteUser` would still be defined —
    // inherited from `PrismaAdapter` — so this cannot assert mere presence.
    // The refusal above is the real assertion; this guards the shape.
    expect(typeof createAuthAdapter(clientStub().client).deleteUser).toBe(
      "function",
    );
  });
});

describe("createAuthAdapter — createUser", () => {
  it("discards the identity provider's image", async () => {
    // Profile pictures come from S3 via `profileImageLookup.ts`, never from the
    // provider. Storing the provider's URL would give a user a picture they
    // never chose and cannot change in this app. Previously untested.
    const { client, create } = clientStub();

    await createAuthAdapter(client).createUser!({
      id: "ignored",
      name: "Sam",
      email: "student@northeastern.edu",
      emailVerified: null,
      image: "https://lh3.googleusercontent.com/a/somebody",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.image).toBeNull();
  });

  it("keeps every other field the provider sent", async () => {
    const { client, create } = clientStub();

    await createAuthAdapter(client).createUser!({
      id: "ignored",
      name: "Sam",
      email: "student@northeastern.edu",
      emailVerified: null,
      image: null,
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      name: "Sam",
      email: "student@northeastern.edu",
    });
  });

  it("returns an empty string rather than null for a missing email", async () => {
    // NextAuth's `AdapterUser` types `email` as a string, but the column is
    // nullable. Returning null here would violate the type the session layer
    // reads.
    const create = jest.fn(async () => ({
      id: "user-1",
      email: null,
    }));
    const client = { user: { create } } as unknown as Parameters<
      typeof createAuthAdapter
    >[0];

    const user = await createAuthAdapter(client).createUser!({
      id: "ignored",
      name: "Sam",
      email: "",
      emailVerified: null,
      image: null,
    });

    expect(user.email).toBe("");
  });
});
