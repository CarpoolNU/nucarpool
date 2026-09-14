type AdminSidebarProps = {
  option: string;
  setOption: React.Dispatch<React.SetStateAction<string>>;
};

const AdminSidebar = ({ option, setOption }: AdminSidebarProps) => {
  /*
    Both buttons compose these with a template literal and a ternary, matching
    what `ProfileSidebar` settled on under SCRUM-438 rather than inventing a
    second convention for the same job.

    They used to build each button as
    `baseButton + (option === "management" && selectedButton)` - concatenation
    with a boolean on the right - so the unselected button stringified its
    false guard and shipped it as a class:

      class="px-4 py-2 text-northeastern-red font-montserrat text-xl false"

    Nothing looked wrong, and that is the only real difference from SCRUM-438.
    There the same construct had no separating whitespace, so `lg:text-2xl` was
    glued to its neighbour and stopped applying. Here `baseButton` ended in a
    space and `selectedButton` began with one, so every real utility stayed
    separated - `false` is not a utility, Tailwind emits no rule for it, and an
    unknown class changes nothing.

    Those two separators were the fix's other half. They were invisible and
    load-bearing, which is how the sibling defect happened in the first place:
    a conditional group appended without a leading space would have reproduced
    it exactly. The separator now lives in the template literal, where it can
    be seen. `AdminSidebar.test.tsx` asserts on the `class` attribute's tokens,
    which is the only place either defect was ever observable.
  */
  const baseButton = "px-4 py-2 text-northeastern-red font-montserrat text-xl";
  const selectedButton = "font-bold underline underline-offset-8";
  return (
    <div className="h-full w-full">
      <div className="mt-6 flex flex-col items-start gap-4">
        <button
          className={`${baseButton} ${
            option === "management" ? selectedButton : ""
          }`}
          onClick={() => setOption("management")}
        >
          Management
        </button>
        <button
          className={`${baseButton} ${option === "data" ? selectedButton : ""}`}
          onClick={() => setOption("data")}
        >
          Data
        </button>
      </div>
    </div>
  );
};
export default AdminSidebar;
