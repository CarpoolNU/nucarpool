import "../styles/globals.css";
import type { AppProps } from "next/app";
import { Session } from "next-auth";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { SessionProvider } from "next-auth/react";
import Head from "next/head";
import { trpc } from "../utils/trpc";
import { ComplianceGate } from "../components/ComplianceGate";

export function MyApp({
  Component,
  pageProps: { session, ...pageProps },
}: AppProps<{ session: Session }>) {
  return (
    <>
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" />
      </Head>
      <SessionProvider session={session} refetchOnWindowFocus={false}>
        <Component {...pageProps} />
        {/* One gate for the whole app, so a signed-in user who has not accepted
            the terms is shown them on whichever page they land on (SCRUM-240). */}
        <ComplianceGate />
        <ToastContainer />
      </SessionProvider>
    </>
  );
}

export default trpc.withTRPC(MyApp);
