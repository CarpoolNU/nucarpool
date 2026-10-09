import { Listbox } from "@headlessui/react";
import { FaChevronDown } from "react-icons/fa";
import React from "react";

interface Option<T> {
  value: T;
  label: string;
}

interface CustomSelectProps<T> {
  value: T;
  onChange: React.Dispatch<React.SetStateAction<T>>;
  options: Option<T>[];
  title?: string;
  className?: string;
}

const CustomSelect = <T extends string>({
  value,
  onChange,
  options,
  title,
  className,
}: CustomSelectProps<T>) => {
  return (
    <div className={"relative z-20 w-full " + className}>
      <Listbox value={value} onChange={onChange}>
        <div className="relative">
          <Listbox.Button className="relative w-full cursor-default rounded-lg border border-black bg-white py-2 pr-8 pl-3 text-left focus:outline-hidden">
            {title ? (
              <span className="block truncate">{title}</span>
            ) : (
              <span className="block truncate font-semibold">
                {options.find((opt) => value === opt.value)?.label}
              </span>
            )}
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
              <FaChevronDown className="h-4 w-4" aria-hidden="true" />
            </span>
          </Listbox.Button>
          {/* A box shadow, and no fade wrapper. Both halves keep a phone from
              painting a white rectangle under this control after an option is
              chosen, until a pinch-zoom forces a repaint.

              The shadow must be a box shadow, not the filter-based shadow
              utility: a `filter` promotes the panel to its own compositing
              layer, and that layer is destroyed the instant the panel
              unmounts, which is a well-known way to strand pixels on a mobile
              compositor. A box shadow needs no layer, and is the right tool
              regardless: the filter form exists for alpha silhouettes, and
              this panel is an opaque rounded rectangle. That utility is
              deliberately not named here - Tailwind v4 scans this file, so
              writing it in a comment would emit it as a real rule.

              There is no fade because none is achievable here. A
              `<Transition>` wrapper with `leave`/`leaveFrom`/`leaveTo` is
              Headless UI v1's API, and this project is on v2, where it does
              not animate at all: v2 applies `leaveFrom` and
              `data-leave` and then unmounts the node in the same frame,
              measured as a computed `transition-duration` of `0s` while open
              and the panel gone within 50ms. v2's `transition` prop does no
              better in the layout harness - it unmounts inside 42ms against a
              deliberate 1000ms transition - so there is no markup here for it.
              Adding a real fade needs a device check, not another guess. */}
          <Listbox.Options className="absolute mt-1 max-h-60 w-full overflow-auto rounded-md border border-black bg-white shadow-xl focus:outline-hidden">
            {options.map((option) => (
              <Listbox.Option
                key={option.value}
                className={({ focus }) =>
                  `relative cursor-default py-2 pr-8 pl-3 select-none ${
                    focus ? "bg-northeastern-red text-white" : "text-black"
                  }`
                }
                value={option.value}
              >
                {({ selected }) => (
                  <span
                    className={`block truncate ${
                      selected ? "font-medium" : "font-normal"
                    }`}
                  >
                    {option.label}
                  </span>
                )}
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  );
};

export default CustomSelect;
