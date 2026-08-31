import { MdErrorOutline } from "react-icons/md";

/**
 * The one error treatment for a failed query (SCRUM-241).
 *
 * Both places that can fail use this so that "failed to load" reads the same
 * wherever it appears, and so it never looks like an empty result: an icon, a
 * plain statement that loading failed, and a retry. Silent empty lists made a
 * real outage look like nobody was using the app, which is the worst failure
 * mode a matching product has.
 */

interface QueryErrorProps {
  /** What failed to load, in a form that completes "We could not load …". */
  subject: string;
  onRetry: () => void;
  /** `page` fills the viewport; `inline` sits inside a sidebar list. */
  variant?: "page" | "inline";
}

export const QueryError = ({
  subject,
  onRetry,
  variant = "inline",
}: QueryErrorProps) => (
  <div
    role="alert"
    className={
      variant === "page"
        ? "flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center"
        : "m-4 flex flex-col items-center gap-3 text-center"
    }
  >
    <MdErrorOutline
      className={
        variant === "page"
          ? "h-12 w-12 text-northeastern-red"
          : "h-8 w-8 text-northeastern-red"
      }
      aria-hidden="true"
    />
    <p
      className={
        variant === "page"
          ? "text-xl font-light"
          : "text-lg font-light text-gray-700"
      }
    >
      We could not load {subject}.
    </p>
    <p className="text-sm text-gray-500">
      This is a problem on our side, not a sign that there is nothing here.
    </p>
    <button
      type="button"
      onClick={onRetry}
      className="rounded-md bg-northeastern-red px-4 py-2 font-medium text-white transition-colors hover:bg-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-northeastern-red"
    >
      Try again
    </button>
  </div>
);
