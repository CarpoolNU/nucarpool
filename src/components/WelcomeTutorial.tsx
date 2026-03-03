import React, { useState } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";
import { toast } from "react-toastify";
import { FaTimes, FaArrowRight } from "react-icons/fa";

interface WelcomeTutorialProps {
  onComplete?: () => void;
}

const WelcomeTutorial: React.FC<WelcomeTutorialProps> = ({ onComplete }) => {
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(false);

  const utils = trpc.useContext();

  const completeTutorialMutation = trpc.user.completeTutorial.useMutation({
    onSuccess: () => {
      utils.user.me.invalidate();
      onComplete?.();
      toast.success("Welcome to NU Carpool!");
    },
    onError: (error) => {
      console.error("Error completing tutorial:", error);
      toast.error("Something went wrong. Please try again.");
      setIsLoading(false);
    },
  });

  const handleComplete = async () => {
    setIsLoading(true);
    await completeTutorialMutation.mutateAsync();
  };

  const handleSkip = () => {
    onComplete?.();
  };

  if (!session?.user?.name) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Blurred background overlay */}
      <div
        className="absolute inset-0 bg-black bg-opacity-40 backdrop-blur-sm"
        onClick={handleSkip}
      />

      {/* Tutorial card */}
      <div className="relative mx-4 w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        {/* Close button */}
        <button
          onClick={handleSkip}
          className="absolute right-4 top-4 rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          disabled={isLoading}
        >
          <FaTimes size={16} />
        </button>

        {/* Content */}
        <div className="text-center">
          {/* Welcome message */}
          <h1 className="mb-4 text-2xl font-bold text-gray-800">
            Welcome to Carpool, <br></br>
            {session.user.name.split(" ")[0]}!
          </h1>

          <p className="mb-8 text-gray-600 leading-relaxed">
            Let’s take a quick tour to help you get started.
          </p>

          {/* Action buttons */}
          <div className="flex flex-row space-x-3">
            <button
              onClick={handleSkip}
              disabled={isLoading}
              className="w-full rounded-lg border border-gray-300 px-6 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Skip for now
            </button>

            <button
              onClick={handleComplete}
              disabled={isLoading}
              className="flex w-full items-center justify-center rounded-lg bg-northeastern-red px-6 py-3 font-medium text-white transition-colors hover:bg-northeastern-red-dark disabled:opacity-50"
            >
              {isLoading ? (
                <div className="flex items-center">
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Getting started...
                </div>
              ) : (
                <div className="flex items-center">
                  Show Me Around
                  <FaArrowRight className="ml-2" size={14} />
                </div>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeTutorial;
