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
          {/* A box shadow, and no fade wrapper. Both halves are SCRUM-499: on a
              phone, choosing an option left a white rectangle painted under
              this control until a pinch-zoom forced a repaint.

              The shadow is the fix. It used to be the filter-based shadow
              utility, and a `filter` promotes the panel to its own compositing
              layer - a layer that was then destroyed the instant the panel
              unmounted, which is a well-known way to strand pixels on a mobile
              compositor. A box shadow needs no layer, and is the right tool
              regardless: the filter form exists for alpha silhouettes, and
              this panel is an opaque rounded rectangle. The retired utility is
              deliberately not named here - Tailwind v4 scans this file, so
              writing it in a comment would go on emitting it.

              The fade is gone rather than ported. A `<Transition>` wrapper
              stood here with `leave`/`leaveFrom`/`leaveTo`, which is Headless
              UI v1's API; SCRUM-331 moved this project to v2 and left it
              behind. It never animated: v2 applies `leaveFrom` and
              `data-leave` and then unmounts the node in the same frame,
              measured as a computed `transition-duration` of `0s` while open
              and the panel gone within 50ms. Rather than swap in v2's
              `transition` prop, which could not be made to animate in the
              layout harness either - it still unmounted inside 42ms against a
              deliberate 1000ms transition - the dead markup is simply removed.
              Restoring a real fade needs a device check, not another guess. */}
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
