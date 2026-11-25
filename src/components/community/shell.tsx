/**
 * The chrome every community page sits inside.
 *
 * **Product UI — merges into NUCarpool**.
 */
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useRef, type ReactNode } from "react";
import { SEARCH_TERM_MAX_LENGTH } from "../../server/community/content/domain/searchTerm";
import { readFeedView, searchSubmitHref } from "./feedView";
import type { ListFooterState } from "./listFooterState";

/** The query parameter the box reads and writes. `feedView.ts` owns the rest. */
const SEARCH_FIELD = "q";

/**
 * The search box, in the chrome rather than on a page of its own.
 *
 * **It is in the shell so that it is on the composer** (SCRUM-683). The ticket
 * is about answered questions being asked again, and the moment to intercept
 * that is while someone is on `/community/new` typing the question — not on a
 * search page they would have to think to visit first. Putting it in the frame
 * costs one row of chrome and puts it in front of every reader on every page.
 *
 * **Uncontrolled, keyed on the term in the URL.** The URL is the state here as
 * it is everywhere else in this module, so the box seeds itself from the URL
 * and remounts when it changes — which is what keeps the text in the box
 * honest after a Back, without an effect that syncs two copies of the same
 * fact and occasionally loses.
 */
export const SearchBox = () => {
  const router = useRouter();
  const { term } = readFeedView(router.query);

  return (
    <form
      // `role="search"` makes this a landmark, so a screen reader can jump
      // straight to it from anywhere on the page.
      role="search"
      aria-label="Search the community"
      onSubmit={(event) => {
        event.preventDefault();
        const typed = new FormData(event.currentTarget).get(SEARCH_FIELD);
        void router.push(
          searchSubmitHref(typeof typed === "string" ? typed : ""),
        );
      }}
    >
      <label htmlFor="community-search" className="sr-only">
        Search posts
      </label>
      <input
        key={term ?? ""}
        id="community-search"
        name={SEARCH_FIELD}
        // `type="search"` rather than `text`, for the clear control browsers
        // put inside it and the "search" key mobile keyboards show instead of
        // a newline.
        type="search"
        defaultValue={term ?? ""}
        placeholder="Search posts"
        // The server refuses a longer term; stopping it here means the reader
        // finds that out while typing rather than after pressing Enter.
        maxLength={SEARCH_TERM_MAX_LENGTH}
        className="focus-visible:border-northeastern-red focus-visible:outline-northeastern-red w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-0"
      />
    </form>
  );
};

/**
 * The page frame: a single reading column.
 *
 * One column rather than a sidebar layout, because the only navigation this
 * product has is a category filter that belongs above the thing it filters. A
 * sidebar would be chrome built for a hierarchy that does not exist.
 */
export const CommunityShell = ({
  children,
}: {
  /** Optional, so a page can render the frame while its first query resolves. */
  children?: ReactNode;
}) => (
  <div className="font-lato h-full overflow-y-auto bg-white text-gray-900">
    <header className="border-b border-gray-200">
      <div className="mx-auto flex max-w-2xl items-baseline justify-between px-4 py-4">
        <Link
          href="/community"
          className="font-montserrat text-lg font-bold tracking-tight text-gray-900"
        >
          Community
        </Link>
        <nav className="flex items-baseline gap-4">
          {/* Plain text next to the filled button: there is one primary action
              on this page and it is writing, so the way back to your own saved
              posts sits beside it rather than competing with it. */}
          <Link
            href="/community/saved"
            className="hover:text-northeastern-red focus-visible:outline-northeastern-red text-sm text-gray-600 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Saved
          </Link>
          <Link
            href="/community/new"
            className="bg-northeastern-red font-montserrat focus-visible:outline-northeastern-red rounded-md px-3 py-1.5 text-sm font-bold text-white transition-colors hover:bg-[#a60d26] focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Write a post
          </Link>
        </nav>
      </div>

      {/* A second row of the same header rather than a band of its own: the
          box is chrome, and giving it its own border would make the page look
          like it had two headers. */}
      <div className="mx-auto max-w-2xl px-4 pb-3">
        <SearchBox />
      </div>
    </header>

    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">{children}</main>
  </div>
);

/**
 * A category filter chip.
 *
 * Chips rather than a `<select>` because the categories come from a table of
 * five rows and are the page's only navigation — hiding five options behind a
 * click to save a line of vertical space is the wrong trade. They are links,
 * not buttons, so a filtered feed has a URL that can be shared.
 */
export const CategoryChip = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) => (
  <Link
    href={href}
    aria-current={active ? "page" : undefined}
    className={`focus-visible:outline-northeastern-red rounded-full px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${
      active
        ? "bg-light-red text-northeastern-red font-bold"
        : "text-gray-600 hover:bg-gray-100"
    }`}
  >
    {label}
  </Link>
);

/**
 * One order of the feed, as a tab in a segmented control.
 *
 * **Deliberately not a `CategoryChip`.** The two rows sit side by side and do
 * different things — a category narrows what is in the feed, a sort changes
 * the order of all of it — so they are given different shapes rather than
 * reading as one row of filters where picking two would be meaningful.
 *
 * It is a link, not a button, because the sort is in the URL: a Top feed has
 * to be shareable, and middle-clicking it should open a Top feed.
 */
export const SortTab = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) => (
  <Link
    href={href}
    aria-current={active ? "page" : undefined}
    className={`focus-visible:outline-northeastern-red rounded-full px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${
      active
        ? "text-northeastern-red bg-white font-bold shadow-sm"
        : "text-gray-600 hover:text-gray-900"
    }`}
  >
    {label}
  </Link>
);

/**
 * An empty state, written as an invitation rather than a dead end.
 */
export const EmptyState = ({
  heading,
  children,
}: {
  heading: string;
  children?: ReactNode;
}) => (
  <div className="py-12 text-center">
    <p className="font-montserrat text-base font-bold text-gray-900">
      {heading}
    </p>
    {children ? <p className="mt-1 text-sm text-gray-500">{children}</p> : null}
  </div>
);

/**
 * The bottom of a keyset-paged list.
 *
 * **Renders only the two kinds that belong at the end of a list** — the
 * control that fetches the next page, and the terminus once there is no next
 * page. `loading`, `empty` and `error` are deliberately not handled here: all
 * three are whole-page states with page-specific copy, and the one that reads
 * best is a centred block rather than a line under a list that has no rows in
 * it. The page switches on those kinds itself; `listFooterState` is still the
 * single place that decides which kind it is.
 *
 * **The failure of a *later* page does belong here**, which is why it arrives
 * as a field of `more` rather than as a kind of its own: the rows stay on
 * screen (see `listFooterState` for why this list and the moderation queue
 * answer that differently), and the control the message sits under is the
 * retry — pressing it again is the request that failed.
 */
export const ListFooter = ({
  state,
  onLoadMore,
  endNote,
}: {
  state: ListFooterState;
  onLoadMore: () => void;
  /** What the end of this particular list should say. */
  endNote: string;
}) => {
  const endRef = useRef<HTMLParagraphElement>(null);
  const cameFromButton = useRef(false);

  // **The last press of "Load more" destroys the control that was pressed.**
  // Once there is no next page the button unmounts and this note takes its
  // place, so the focused element leaves the document and the browser drops
  // focus to `<body>` — dumping a keyboard reader at the top of the page at
  // the exact moment they reached the bottom of the list. Focus moves to the
  // note instead, which is also what announces that the list has ended.
  useEffect(() => {
    if (state.kind === "end" && cameFromButton.current) {
      endRef.current?.focus();
    }
    cameFromButton.current = state.kind === "more";
  }, [state.kind]);

  if (state.kind === "more") {
    return (
      <div className="mt-6 flex flex-col items-center text-center">
        {/* **`aria-disabled`, never `disabled`.** A browser blurs a focused
            element the instant it is disabled, so a real `disabled` here
            throws a keyboard reader back to `<body>` on every press — the
            fetch starts, the button disables, and focus is gone before the
            rows arrive. Left enabled and marked busy, the button keeps focus
            through the fetch; the handler is what refuses the second press. */}
        <button
          type="button"
          onClick={() => {
            if (!state.busy) onLoadMore();
          }}
          aria-disabled={state.busy}
          aria-busy={state.busy}
          className={`font-montserrat focus-visible:outline-northeastern-red w-full rounded-md border px-4 py-2.5 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-auto sm:px-8 ${
            state.busy
              ? "cursor-wait border-gray-200 text-gray-400"
              : "hover:border-northeastern-red hover:text-northeastern-red border-gray-300 text-gray-700"
          }`}
        >
          {state.busy ? "Loading…" : "Load more"}
        </button>
        {/* Under the button rather than over the list: what failed is the
            next page, and the thing to do about it is the control above. */}
        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      </div>
    );
  }

  if (state.kind === "end") {
    return (
      <p
        ref={endRef}
        // Focusable programmatically but not in the tab order: it is a
        // destination for the focus the vanished button left behind, never a
        // stop on the way down the page.
        tabIndex={-1}
        role="status"
        className="mt-8 text-center text-xs text-gray-400 focus:outline-none"
      >
        {endNote}
      </p>
    );
  }

  return null;
};

/**
 * A failure, named and actionable.
 *
 * tRPC hands back a message the service already wrote for a person — "That
 * handle is already taken", "Comment is too long — 2000 characters at most" —
 * so this renders it rather than replacing it with a generic apology.
 *
 * **`as` exists because one caller sits inside a paragraph.** `SaveButton` is
 * in the metadata line, which is a `<p>`, and a `<p>` cannot be nested in one
 * — the same constraint `ReportControl` answers with a portal. The announcement
 * rides on `role="alert"`, which is independent of the element, so the inline
 * form gives up nothing. Every other caller is in block context and wants the
 * default.
 */
export const ErrorNote = ({
  as: Tag = "p",
  children,
}: {
  as?: "p" | "span";
  children: ReactNode;
}) => (
  <Tag role="alert" className="text-northeastern-red mt-2 text-sm">
    {children}
  </Tag>
);
