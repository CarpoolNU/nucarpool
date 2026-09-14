interface ProgressBarProps {
  step: number;
}

/**
 * The three-segment indicator above the setup wizard.
 *
 * A cap rather than a fixed width, because the bar has to survive a viewport
 * narrower than the 600px it wants. Its wrapper centres it with
 * `left-1/2 -translate-x-1/2` inside a page root that is `overflow-hidden`, so
 * an overhang is never scrolled to - it is cut off, and a centred 600px box in
 * a 375px viewport loses about 112px from each end, which is exactly the first
 * and third segments. Losing those inverts the component's whole purpose: it
 * exists to tell a first-time user how much of a three-step flow is left.
 *
 * The segments are already `flex-1`, so they redistribute at any width and only
 * the outer box had to stop being a hard number. The width itself comes from the
 * wrapper, which is the thing that knows the page's layout; the cap stays here
 * so the desktop figure is stated once.
 */
const ProgressBar = ({ step }: ProgressBarProps) => {
  return (
    <div className="z-10 mx-auto flex w-full max-w-[600px] items-center gap-6 px-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className={`h-3.5 flex-1 rounded drop-shadow-[1px_6px_2px_rgba(0,0,0,0.35)] ${
            i < step
              ? "bg-northeastern-red"
              : i === step
                ? "bg-busy-red"
                : "bg-white"
          }`}
        />
      ))}
    </div>
  );
};
export default ProgressBar;
