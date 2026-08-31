import "../styles/globals.css";
import type { AppProps } from "next/app";
import { Session } from "next-auth";
/**
 * `react-toastify/unstyled`, not `react-toastify`. Identical API; the only
 * difference is that it does not inject its stylesheet into a `<style>` element
 * at mount, which is what kept react-toastify on the list of libraries forcing
 * `'unsafe-inline'` in the CSP's `style-src`.
 *
 * **Every import of this library must use the same entry point.** The two are
 * separate modules with separate state — `toast` from one does not reach a
 * `ToastContainer` from the other, and the symptom is toasts silently never
 * appearing, with nothing failing. An ESLint rule in `.eslintrc.json` bans the
 * bare specifier so that mistake is a lint error rather than a bug report.
 */
import { ToastContainer } from "react-toastify/unstyled";
/**
 * Load-bearing, and now the *only* source of toast styling: `/unstyled` ships
 * no CSS and injects none. Deleting this import leaves every toast unstyled.
 */
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
            the terms is shown them on whichever page they land on. */}
        <ComplianceGate />
        {/* `closeOnClick` restates react-toastify v9's default, which v10
            dropped to `false`. The whole toast is the click target and every
            toast in the app dismissed that way before the upgrade, so losing it
            as a side effect of a version bump would be a silent regression.
            Turning it off is a UX decision, not a dependency one.

            `draggable` is deliberately *not* restored: v9 defaulted it to
            `true`, v11 to `"touch"`. Swipe-to-dismiss still works where it
            feels native, and dragging a toast with a mouse is a gesture
            upstream removed on purpose. */}
        <ToastContainer closeOnClick />
      </SessionProvider>
    </>
  );
}

export default trpc.withTRPC(MyApp);
