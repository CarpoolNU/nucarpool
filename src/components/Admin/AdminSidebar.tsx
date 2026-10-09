type AdminSidebarProps = {
  option: string;
  setOption: React.Dispatch<React.SetStateAction<string>>;
};

const AdminSidebar = ({ option, setOption }: AdminSidebarProps) => {
  /*
    Both buttons compose these with a template literal and a ternary, matching
    what `ProfileSidebar` already settled on rather than inventing a
    second convention for the same job.

    The ternary returns `""`, not `false`: concatenating a boolean into a
    class string would stringify to the literal text `false` and ship it as
    an extra class - harmless, since Tailwind emits no rule for an unknown
    class, but needless surface area. `baseButton` and the ternary are joined
    by an explicit space in the template literal itself, so neither string
    needs its own padding to stay separated.
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
          aria-pressed={option === "management"}
          onClick={() => setOption("management")}
        >
          Management
        </button>
        <button
          className={`${baseButton} ${option === "data" ? selectedButton : ""}`}
          aria-pressed={option === "data"}
          onClick={() => setOption("data")}
        >
          Data
        </button>
        <button
          className={`${baseButton} ${
            option === "audit" ? selectedButton : ""
          }`}
          aria-pressed={option === "audit"}
          onClick={() => setOption("audit")}
        >
          Audit Log
        </button>
        <button
          className={`${baseButton} ${
            option === "reports" ? selectedButton : ""
          }`}
          aria-pressed={option === "reports"}
          onClick={() => setOption("reports")}
        >
          Reports
        </button>
      </div>
    </div>
  );
};
export default AdminSidebar;
