/**
 * The explicit confirmation SCRUM-508 requires before onboarding can finish
 * on Viewer: `handleNextStep`'s step-1 VIEWER branch used to call
 * `handleSubmit(onSubmit)` directly on the first tap, which reached
 * `isOnboarded: true` with no chance to back out. This sits between that tap
 * and the actual submit, mirroring `UnsavedModal`'s two-button layout.
 */
type ViewerConfirmModalProps = {
  onCancel: () => void;
  onConfirm: () => void;
};

function ViewerConfirmModal({ onCancel, onConfirm }: ViewerConfirmModalProps) {
  return (
    <div className="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative flex w-1/3 min-w-[min(22rem,100%)] flex-col justify-center rounded-lg bg-white px-6 py-10 text-center shadow-lg">
        <h3 className="mb-4 text-xl font-semibold lg:text-2xl">
          View the map without setting up carpooling?
        </h3>
        <p className="mb-6 text-gray-700">
          As a Viewer you can browse the map, but you won&apos;t be matched with
          a carpool. You can add your schedule and become a Rider or Driver
          anytime from your profile.
        </p>
        <div className="flex justify-center space-x-4">
          <button
            onClick={onCancel}
            className="rounded bg-gray-400 px-4 py-2 font-bold text-white hover:bg-gray-600"
          >
            Go back
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="bg-northeastern-red rounded px-4 py-2 font-bold text-white hover:bg-red-700 focus:ring-2 focus:ring-black focus:outline-hidden"
          >
            View Map
          </button>
        </div>
      </div>
    </div>
  );
}
export default ViewerConfirmModal;
