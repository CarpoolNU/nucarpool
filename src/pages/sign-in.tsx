import { GetServerSidePropsContext, NextPage } from "next";
import { signIn } from "next-auth/react";
import { getServerSession } from "next-auth";
import { authOptions } from "./api/auth/[...nextauth]";
import React from "react";
import Head from "next/head";
import Header from "../components/Header";
import { trackEvent } from "../utils/mixpanel";
import { browserEnv } from "../utils/env/browser";

// One direct session lookup, not a self-directed HTTP round trip to
// `/api/auth/session`. `getSession` from `next-auth/react` is the
// *client* helper and was being called here; `getServerSession` reads the cookie
// and queries directly, as `server/router/context.ts` already did.
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (session?.user) {
    if (session.user.isOnboarded) {
      return {
        redirect: {
          destination: "/",
          permanent: false,
        },
      };
    }
    return {
      redirect: {
        destination: "/profile/setup",
        permanent: false,
      },
    };
  }

  return {
    props: {},
  };
}

const SignIn: NextPage = () => {
  const handleOnNortheasternSignInClick = (
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    trackEvent("Sign In Attempt", { provider: "Northeastern" });
    signIn("azure-ad", {
      callbackUrl: "/",
    });
  };

  const handleOnGoogleSignInClick = (
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    trackEvent("Sign In Attempt", { provider: "Google" });
    signIn("google", {
      callbackUrl: "/",
    });
  };

  return (
    <>
      <Head>
        <title>Sign In - NU Carpool</title>
      </Head>

      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <div className="m-4 flex w-fit flex-col items-center justify-center space-y-4 rounded-2xl bg-white p-6 drop-shadow-lg">
          <Header signIn={true} />
          <button onClick={handleOnNortheasternSignInClick}>
            <div className="flex w-64 cursor-pointer items-center justify-center rounded bg-blue-500 px-4 py-3 text-center text-sm font-bold text-white shadow hover:bg-blue-700">
              Sign in with Northeastern!
            </div>
          </button>
          {/* Staging only, matching the provider list in [...nextauth].ts.
              Both now read the same validated value, so the button
              and the provider behind it cannot disagree. */}
          {browserEnv.NEXT_PUBLIC_ENV === "staging" && (
            <button onClick={handleOnGoogleSignInClick}>
              <div className="flex w-64 cursor-pointer items-center justify-center rounded bg-blue-500 px-4 py-3 text-center text-sm font-bold text-white shadow hover:bg-blue-700">
                Sign in via Google!
              </div>
            </button>
          )}
        </div>
      </div>
    </>
  );
};

export default SignIn;
