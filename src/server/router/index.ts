import { router } from "./createRouter";
import { communityRouter } from "./community";
import { mapboxRouter } from "./mapbox";
import { userRouter } from "./user";

// This bundles together our distinct routers into one router, with prefixes for respective routers
// The superjson transformer does JSON type conversion for Dates, Maps, and Sets for us :D
export const appRouter = router({
  user: userRouter,
  mapbox: mapboxRouter,
  // Inert while NEXT_PUBLIC_COMMUNITY_ENABLED is off; see `communityHost.ts`.
  community: communityRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
