import Head from "next/head";
import { pageTitle } from "../utils/pageTitle";

/*
 * Sets the document title through `next/head`.
 *
 * Render it in every branch a page can return, not only the loaded one:
 * `/profile` and `/profile/setup` answer with a spinner until `user.me`
 * resolves, and that spinner is what the served HTML and a screen reader's
 * on-load announcement see. A title that appears only with the data would
 * leave the first thing a user hears as the app-wide default.
 *
 * `_app.tsx` renders a bare `<PageTitle />` as the fallback, and a page's own
 * title overrides it because Next keeps the last `<title>` it is given.
 */
export default function PageTitle({ page }: { page?: string }) {
  return (
    <Head>
      <title>{pageTitle(page)}</title>
    </Head>
  );
}
