import { Role, Status, CarpoolSearch, Location } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import _ from "lodash";
import { MapUser } from "./types";
import { z } from "zod";

/** Type for storing recommendation scores associated with a particular user */
export type Recommendation = {
  id: string;
  score: number;
};

/** Default cutoffs for scoring recommendation calculations */
const cutoffs = {
  startDistance: 6, // miles
  endDistance: 6, // miles
  startTime: 80, // minutes
  endTime: 80, // minutes
};

/** Weights for each portion of the recommendation score */
const weights = {
  startDistance: 0.2,
  endDistance: 0.4,
  startTime: 0.1,
  endTime: 0.1,
  days: 0.1,
  overlap: 0.1,
};

export type FInputs = {
  startDistance: number; // max 19, greater = any
  endDistance: number;
  startTime: number; // max = 3 hours (180min), greater = any
  endTime: number;
  days: number; /// 0 for any, 1 for exact
  flexDays: number; // minimum # of days to match
  startDate: Date;
  endDate: Date;
  dateOverlap: number; // 0 any, 1 partial, 2 full
  daysWorking: string;
};

/**
 * Miles covered by one degree of latitude: 2 * pi * R / 360, with R = 3958.8 mi.
 *
 * Exported because the SQL bounding box in `candidateSearch.ts` has to derive
 * its window from the same constant this metric uses, or the box could exclude
 * a point the scorer would have kept (SCRUM-245).
 */
export const MILES_PER_DEGREE_LATITUDE = 69.09;

/**
 * Straight-line miles between two coordinates.
 *
 * The previous form was `sqrt(dLat^2 + dLng^2) * 88`, which treated a degree of
 * longitude as covering the same ground as a degree of latitude. At Boston's
 * latitude a degree of longitude is only about 74% as wide, so east-west
 * separation was overstated by roughly a third relative to north-south and the
 * mile-denominated filters did not mean the same thing in every direction
 * (SCRUM-236).
 *
 * Equirectangular with a cosine correction is within a fraction of a percent of
 * haversine at commute range, for one cosine.
 */
export const milesBetween = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number => {
  const meanLatitudeRadians = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const northSouth = (lat1 - lat2) * MILES_PER_DEGREE_LATITUDE;
  const eastWest =
    (lng1 - lng2) * MILES_PER_DEGREE_LATITUDE * Math.cos(meanLatitudeRadians);

  return Math.sqrt(northSouth * northSouth + eastWest * eastWest);
};

/** The circumference of a clock, in minutes - see `minutesApart` below. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes between two times of day (SCRUM-235, SCRUM-297).
 *
 * Both times are collapsed to a minute offset from midnight before subtracting.
 * The original form — |Δhours| * 60 + |Δminutes| — took the absolute value of
 * each component separately, so a pair whose minutes ran backwards relative to
 * its hours was overstated: 9:50 against 10:00 read as 110 minutes rather than
 * 10 (SCRUM-235). That inflated difference both filtered out compatible users
 * and penalised their score.
 *
 * Two things about *how* the reading is taken were still wrong (SCRUM-297).
 *
 * **The accessors are UTC.** `startTime`/`endTime` are `@db.Time(0)` holding a
 * UTC time of day — see "Schedule times" in `src/server/db/README.md` — and
 * Prisma returns them as `1970-01-01T<time>Z`. `getHours()` reinterpreted that
 * instant in the *host's* zone, which made the result depend on where the code
 * ran: Amplify and GitHub Actions are UTC, local development is
 * `America/New_York`. `getUTCHours()` reads the value that was actually stored,
 * the same contract `formatScheduleTime` renders under.
 *
 * **The difference is circular.** A previous version of this comment claimed a
 * shared timezone offset always cancels in the subtraction. It does not: the
 * offset can carry one operand across a day boundary and not the other, and a
 * linear subtraction then reports the long way round the clock. Two students
 * finishing at 23:30 and 00:30 UTC are 60 minutes apart, but subtracting minute
 * offsets gives 1380 — past every cutoff the UI offers, so each was dropped
 * from the other's results. `min(d, 1440 - d)` takes the short way, which also
 * caps the value at 720.
 *
 * `jest.config.js` pins `TZ` so this stays verifiable in CI.
 */
export const minutesApart = (a: Date, b: Date): number => {
  const minutesOfDay = (time: Date) =>
    time.getUTCHours() * 60 + time.getUTCMinutes();

  const difference = Math.abs(minutesOfDay(a) - minutesOfDay(b));

  return Math.min(difference, MINUTES_PER_DAY - difference);
};

interface CommonUser {
  id: string;
  role: string;
  seatAvail: number;
  coopStartDate: Date | null;
  coopEndDate: Date | null;
  startCoordLat: number;
  startCoordLng: number;
  companyCoordLat: number;
  companyCoordLng: number;
  carpoolId?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  daysWorking: string;
}

// Type for CarpoolSearch with relations
type CarpoolSearchWithLocations = CarpoolSearch & {
  user: { id: string };
  homeLocation: Location | null;
  companyLocation: Location | null;
};

/**
 * Converts a CarpoolSearch to the CommonUser interface for scoring
 */
const carpoolSearchToCommonUser = (
  search: CarpoolSearchWithLocations,
): CommonUser => {
  return {
    id: search.user.id,
    role: search.role,
    seatAvail: search.seatsAvail,
    coopStartDate: search.startDate,
    coopEndDate: search.endDate,
    startCoordLat: search.homeLocation?.coordLat ?? 0,
    startCoordLng: search.homeLocation?.coordLng ?? 0,
    companyCoordLat: search.companyLocation?.coordLat ?? 0,
    companyCoordLng: search.companyLocation?.coordLng ?? 0,
    carpoolId: search.carpoolId,
    startTime: search.startTime,
    endTime: search.endTime,
    daysWorking: search.daysWorking,
  };
};

/**
 * Converts a comma separated string representing user's days working to a boolean array
 * @param user The user to calculate days for
 * @returns a boolean array corresponding to `user.daysWorking` - index 0 is Sunday
 */
const dayConversion = (user: CommonUser) => {
  return user.daysWorking.split(",").map((str) => str === "1");
};

/**
 * Generates a function that can be mapped across users to calculate recommendation scores relative to
 * a single user. If the score in any area exceeds predetermined cutoffs, the function will return undefined.
 * Under the `any` sort every factor is weighted once and the weights sum to 1,
 * so a score lies between 0 and 1, where 0 indicates a perfect match. The
 * `distance` sort returns raw combined mileage and `time` returns the two
 * normalised time components, so neither is on that scale.
 *
 * @param currentUser The user to generate a recommendation callback for
 * @param inputs The filter inputs to replace 'cutoffs'
 * @param sort The parameter to score by
 * @returns A function that takes in a user and returns their score relative to `currentUser`
 */
export const calculateScore = (
  currentUserSearch: CarpoolSearchWithLocations,
  inputs: FInputs,
  sort: string,
): ((userSearch: CarpoolSearchWithLocations) => Recommendation | undefined) => {
  const currentUser = carpoolSearchToCommonUser(currentUserSearch);
  const currentUserDays = inputs.daysWorking
    .split(",")
    .map((str) => str === "1");

  return (userSearch: CarpoolSearchWithLocations) => {
    const user = carpoolSearchToCommonUser(userSearch);

    if (
      (currentUser.role === "RIDER" &&
        (user.role === "RIDER" || user.seatAvail === 0)) ||
      (currentUser.role === "DRIVER" && user.role === "DRIVER") ||
      user.role === "VIEWER" ||
      (currentUser.carpoolId && currentUser.carpoolId === user.carpoolId)
    ) {
      return undefined;
    }

    const startDistance = milesBetween(
      currentUser.startCoordLat,
      currentUser.startCoordLng,
      user.startCoordLat,
      user.startCoordLng,
    );

    const endDistance = milesBetween(
      currentUser.companyCoordLat,
      currentUser.companyCoordLng,
      user.companyCoordLat,
      user.companyCoordLng,
    );
    const userDays = dayConversion(user);
    // check number of days users both go in, also count number of days current user goes in
    const daysHelper = currentUserDays.reduce(
      (acc, currentUserDay, index) => {
        if (currentUserDay) {
          acc.currentUserDays++;

          if (userDays[index]) {
            acc.bothUsersDays++;
          }
        }
        return acc;
      },
      { currentUserDays: 0, bothUsersDays: 0 },
    );
    let startTime: number | undefined;
    let endTime: number | undefined;
    if (
      currentUser.startTime &&
      currentUser.endTime &&
      user.startTime &&
      user.endTime
    ) {
      startTime = minutesApart(currentUser.startTime, user.startTime);
      endTime = minutesApart(currentUser.endTime, user.endTime);
      if (
        (startTime > inputs.startTime * 60 && inputs.startTime < 4) ||
        (endTime > inputs.endTime * 60 && inputs.endTime < 4)
      ) {
        return undefined;
      }
    }

    if (
      (startDistance > inputs.startDistance && inputs.startDistance < 20) ||
      (endDistance > inputs.endDistance && inputs.endDistance < 20) ||
      (inputs.days == 1 &&
        daysHelper.bothUsersDays !== daysHelper.currentUserDays) ||
      (inputs.days === 2 && daysHelper.bothUsersDays < inputs.flexDays)
    ) {
      return undefined;
    }
    const currentStart = inputs.startDate;
    const currentEnd = inputs.endDate;
    const userStart = user.coopStartDate;
    const userEnd = user.coopEndDate;
    let dateScore = 1;
    let partialOverlap = false;
    let fullOverlap = false;
    if (currentStart && currentEnd && userStart && userEnd) {
      partialOverlap = !(
        (userStart < currentStart && userEnd < currentStart) ||
        (userEnd > currentEnd && userStart > currentEnd)
      );
      fullOverlap = userStart <= currentStart && userEnd >= currentEnd;
      if (inputs.dateOverlap !== 0) {
        if (inputs.dateOverlap === 1 && !partialOverlap) {
          return undefined;
        } else if (inputs.dateOverlap === 2 && !fullOverlap) {
          return undefined;
        }
      }
    } else if (inputs.dateOverlap !== 0) {
      return undefined;
    }

    if (fullOverlap) {
      dateScore = 0;
    } else if (partialOverlap) {
      dateScore = 0.5;
    }
    let finalScore = 0;
    // Sorting portion. Every component is a penalty in 0..1 and the sort is
    // ascending, so lower is a better match.
    if (sort == "any") {
      const sDistanceScore = Math.min(startDistance / cutoffs.startDistance, 1);
      const eDistanceScore = Math.min(endDistance / cutoffs.endDistance, 1);
      // `bothUsersDays / currentUserDays` divided by zero whenever the filter
      // carried no working days, which the map sends on first render and for
      // every VIEWER, and the resulting NaN made the whole sort arbitrary. With
      // no days requested there is no overlap to measure, so days contribute
      // nothing rather than poisoning the comparison (SCRUM-236).
      const daysScore =
        daysHelper.currentUserDays === 0
          ? 0
          : 1 - daysHelper.bothUsersDays / daysHelper.currentUserDays;

      // Each factor is counted exactly once. Distance used to be added twice -
      // once unclamped, so a distant pair could outweigh every other factor -
      // and days twice whenever both schedules were known. The weights sum to
      // 1, so counting each once is what keeps the score inside 0..1 as the
      // doc comment claims (SCRUM-236).
      finalScore =
        sDistanceScore * weights.startDistance +
        eDistanceScore * weights.endDistance +
        daysScore * weights.days +
        dateScore * weights.overlap;

      if (startTime !== undefined && endTime !== undefined) {
        const sTimeScore = Math.min(startTime / cutoffs.startTime, 1);
        const eTimeScore = Math.min(endTime / cutoffs.endTime, 1);

        finalScore +=
          sTimeScore * weights.startTime + eTimeScore * weights.endTime;
      } else {
        // An unknown schedule takes the full time penalty: it cannot rank
        // better than a schedule that is known to clash.
        finalScore += weights.startTime + weights.endTime;
      }
    } else if (sort === "distance") {
      finalScore = startDistance + endDistance;
    } else if (sort === "time") {
      if (startTime !== undefined && endTime !== undefined) {
        const sTimeScore = Math.min(startTime / cutoffs.startTime, 1);
        const eTimeScore = Math.min(endTime / cutoffs.endTime, 1);
        finalScore = sTimeScore + eTimeScore;
      } else {
        // Leaving this at 0 ranked a candidate with no recorded schedule as the
        // best possible match under a sort that is entirely about schedule.
        // Both components cap at 1, so 2 is the worst score here (SCRUM-236).
        finalScore = 2;
      }
    }

    return {
      id: user.id,
      score: finalScore,
    };
  };
};

/**
 * Creates a full user object from a user id.
 *
 * Only the id is needed: since the migration that moved role, schedule, seats
 * and coordinates off `User` and onto `CarpoolSearch`, everything else on the
 * user row is either derived from the id or hardcoded. The parameter used to be
 * typed with a wide `GenerateUserInput` shape, which forced every caller into a
 * cast to supply fields this function never read; that type is gone (SCRUM-250).
 *
 * @param userInfo an object carrying the id to build the user around
 * @returns an upsert argument for the user row
 */
export const generateUser = ({ id }: { id: string }) => {
  const updated_obj = {
    id: id,
    name: `User ${id}`,
    email: `user${id}@hotmail.com`,
    emailVerified: new Date("2022-10-14 19:26:21"),
    image: null,
    bio: `My name is User ${id}. I like to drive`,
    pronouns: "they/them",
    preferredName: `User ${id}`,
    isOnboarded: true,
    licenseSigned: true,
    dateCreated: new Date(),
    dateModified: new Date(),
  };
  return {
    where: { id: id },
    update: updated_obj,
    create: updated_obj,
  };
};
