import { toast } from "react-toastify/unstyled";
import { toScheduleTimeInput } from "../scheduleTime";
import { NextRouter } from "next/router";
import { trpc } from "../trpc";
import { UserInfo } from "../types";
export const updateUser = async ({
  userInfo,
  sessionName,
  mutation,
}: {
  userInfo: UserInfo & {
    startStreet: string;
    startCity: string;
    startState: string;
    companyStreet: string;
    companyCity: string;
    companyState: string;
  };
  sessionName: string;
  mutation: ReturnType<typeof useEditUserMutation>;
}) => {
  const daysWorkingParsed: string = userInfo.daysWorking
    .map((val: boolean) => {
      if (val) {
        return "1";
      } else {
        return "0";
      }
    })
    .join(",");
  await mutation.mutateAsync({
    role: userInfo.role,
    status: userInfo.status,
    seatAvail: userInfo.seatAvail,
    companyName: userInfo.companyName,
    companyAddress: userInfo.companyAddress,
    companyCoordLng: userInfo.companyCoordLng,
    companyCoordLat: userInfo.companyCoordLat,
    startAddress: userInfo.startAddress,
    startCoordLng: userInfo.startCoordLng,
    startCoordLat: userInfo.startCoordLat,
    isOnboarded: true,
    preferredName: userInfo.preferredName || sessionName,
    pronouns: userInfo.pronouns,
    daysWorking: daysWorkingParsed,
    // `toScheduleTimeInput` keeps a cleared time (`null`) distinct from an
    // absent one (`undefined`). The server reads `undefined` as "leave it
    // alone", so collapsing `null` into `undefined` here (e.g. via
    // `?.toISOString()`) would make a cleared schedule impossible to save.
    startTime: toScheduleTimeInput(userInfo.startTime),
    endTime: toScheduleTimeInput(userInfo.endTime),
    bio: userInfo.bio,
    coopStartDate: userInfo.coopStartDate!,
    coopEndDate: userInfo.coopEndDate!,
    startStreet: userInfo.startStreet,
    startCity: userInfo.startCity,
    startState: userInfo.startState,
    companyStreet: userInfo.companyStreet,
    companyCity: userInfo.companyCity,
    companyState: userInfo.companyState,
  });
};
export const useEditUserMutation = (
  router: NextRouter,
  onComplete: () => void,
  pushMap: boolean = true,
) => {
  const utils = trpc.useUtils();

  return trpc.user.edit.useMutation({
    onSuccess: async () => {
      await utils.user.me.refetch();
      await utils.user.recommendations.me.invalidate();
      await utils.mapbox.geoJsonUserList.invalidate();
      if (pushMap) {
        router.push("/").then(() => {
          onComplete();
        });
      } else {
        onComplete();
      }
    },
    onError: (error) => {
      toast.error(`Something went wrong: ${error.message}`);
      onComplete();
    },
  });
};
