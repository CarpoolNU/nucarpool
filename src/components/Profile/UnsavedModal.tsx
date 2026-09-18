import { Dialog } from "@headlessui/react";

type UnsavedModalProps = {
  onClose: () => void;
  onSave: () => void;
  onContinue: () => void;
};

function UnsavedModal({ onClose, onSave, onContinue }: UnsavedModalProps) {
  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <div className="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        {/*
         * `min-w-[min(22rem,100%)]` is a width *floor*, and both halves of it
         * are load-bearing. SCRUM-492.
         *
         * `w-1/3` alone was the defect. A third of a viewport is 480px on a
         * desktop and 222.33px on a phone held in landscape, and this panel's
         * content does not shrink with it: the button row needs 293.34px to stay
         * on one line - `Continue` 101.32, the `space-x-4` gap 16, `Save and
         * Continue` 176.02 - so below that both labels wrap, the row grows from
         * 40px to 88px, the heading wraps as well, and the panel reached 376px
         * against a 375px viewport. Being centred, it then overflowed at *both*
         * edges, and a centred box's top overflow cannot be scrolled to.
         *
         * 22rem is 352px: that 293.34 plus this box's own `px-6`, with 10.65px
         * spare. Every figure here was measured in Chromium against the compiled
         * stylesheet rather than derived from the class names - the
         * `centred-dialog-panels` fixture reproduces this markup, and
         * `measure-layout.test.ts` fails if the class string below drifts from
         * it.
         *
         * One figure in SCRUM-492's own description is wrong and is the obvious
         * thing to re-derive this from: it cites the row's `scrollWidth` of 196
         * plus the padding, giving 244. That `scrollWidth` is the overflow of
         * the *already-wrapped* row, not the width needed to avoid wrapping, and
         * a 244px panel still wraps both labels.
         *
         * The `min()` is what stops the floor becoming the same defect one
         * device down. An unconditional 22rem floor overflows a 320px-wide
         * viewport by 16px at each edge, and a minimum width overrides a maximum
         * one in CSS, so pairing it with a cap would not help. Capping inside
         * the floor means the panel asks for 352px only where there is 352px to
         * give, and otherwise fills its container exactly. `w-1/3` still wins
         * wherever a third is the larger of the two, which leaves every viewport
         * at or above 1024px wide - the entire desktop range - untouched.
         *
         * Naming a utility in a comment emits it, so the rejected alternative is
         * described above rather than spelled - see `tailwind.config.js`.
         */}
        <Dialog.Panel className="relative flex w-1/3 min-w-[min(22rem,100%)] flex-col justify-center rounded-lg bg-white px-6 py-16 text-center shadow-lg">
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2 right-4 text-3xl font-bold text-gray-600 hover:text-gray-900"
          >
            ×
          </button>
          <Dialog.Title
            as="h3"
            className="mb-6 text-xl font-semibold lg:text-2xl"
          >
            You have unsaved changes!
          </Dialog.Title>
          <p className="my-4 text-gray-700">Continue with or without saving?</p>
          <div className="flex justify-center space-x-4">
            <button
              onClick={onContinue}
              className="rounded bg-gray-400 px-4 py-2 font-bold text-white hover:bg-gray-600"
            >
              Continue
            </button>
            <button
              autoFocus
              onClick={onSave}
              className="bg-northeastern-red rounded px-4 py-2 font-bold text-white hover:bg-red-700 focus:ring-2 focus:ring-black focus:outline-hidden"
            >
              Save and Continue
            </button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
export default UnsavedModal;
