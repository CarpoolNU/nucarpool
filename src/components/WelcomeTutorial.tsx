import React, { useState } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";
import { toast } from "react-toastify";
import {
  FaTimes,
  FaArrowRight,
  FaUsers,
  FaMapMarkerAlt,
  FaSearch,
} from "react-icons/fa";
import { useRouter } from "next/router";

interface WelcomeTutorialProps {
  onComplete?: () => void;
}

const WelcomeTutorial: React.FC<WelcomeTutorialProps> = ({ onComplete }) => {
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 0: Welcome, 1: Sidebar explanation 2: Map 3: Navigation
  const router = useRouter();

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

  const handleStartTutorial = () => {
    setCurrentStep(1);
  };

  const handleNextStep = () => {
    // If we're on the last step on the home page, proceed to profile steps
    currentStep < 3
      ? setCurrentStep((prev) => prev + 1)
      : router.push("/profile");
  };

  const handleSkip = () => {
    onComplete?.();
  };

  if (!session?.user?.name) {
    return null;
  }

  const renderWelcomeStep = () => {
    if (!session?.user?.name) {
      return null;
    }

    return (
      <div className="relative mx-4 w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        {/* Close button */}
        <button
          onClick={handleSkip}
          className="absolute right-4 top-4 rounded-full p-2 text-gray-300 hover:bg-gray-100 hover:text-gray-700"
          disabled={isLoading}
        >
          <FaTimes size={16} />
        </button>

        {/* Content */}
        <div className="font-montserrat text-center">
          {/* Welcome message */}
          <h1 className="mb-4 text-2xl font-bold text-gray-800">
            Welcome to Carpool, <br></br>
            {session.user.name.split(" ")[0]}!
          </h1>

          <p className="mb-8 font-montserrat text-gray-600 leading-relaxed">
            Let&apos;s take a quick tour to help you get started.
          </p>

          {/* Action buttons */}
          <div className="flex flex-row space-x-3">
            <button
              onClick={handleSkip}
              disabled={isLoading}
              className="w-full rounded-lg border border-gray-300 px-6 py-3 font-montserrat font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Skip for now
            </button>

            <button
              onClick={handleStartTutorial}
              disabled={isLoading}
              className="flex w-full items-center justify-center rounded-lg bg-northeastern-red px-6 py-3 font-montserrat font-medium text-white transition-colors hover:bg-northeastern-red-dark disabled:opacity-50"
            >
              <div className="flex items-center">
                Show Me Around
                <FaArrowRight className="ml-2" size={14} />
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderHomeTutorialSteps = () => (
    <div
      className={`fixed ${currentStep === 1 ? "left-[425px]" : currentStep === 2 ? "left-1/2 transform -translate-x-1/2" : "right-[50px]"} ${currentStep === 2 || currentStep === 3 ? "top-1/4" : "top-1/2"} transform -translate-y-1/2 z-50 w-full max-w-md rounded-2xl bg-[#D5706A] p-8 shadow-2xl`}
    >
      {/* Triangle pointer */}
      {(currentStep === 1 || currentStep === 2 || currentStep === 3) && (
        <div
          className={`absolute ${currentStep === 1 ? "left-0 top-1/2 transform -translate-y-1/2 -translate-x-full" : currentStep === 2 ? "left-1/2 bottom-0 transform -translate-x-1/2 translate-y-full" : currentStep === 3 ? "left-1/2 top-0 transform -translate-x-1/2 -translate-y-full" : "right-0 top-1/2 transform -translate-y-1/2 translate-x-full"}`}
        >
          <div
            className="w-0 h-0"
            style={
              currentStep === 1
                ? {
                    borderTop: "12px solid transparent",
                    borderBottom: "12px solid transparent",
                    borderRight: "12px solid #D5706A",
                  }
                : currentStep === 2
                  ? {
                      borderLeft: "12px solid transparent",
                      borderRight: "12px solid transparent",
                      borderTop: "12px solid #D5706A",
                    }
                  : currentStep === 3
                    ? {
                        borderLeft: "12px solid transparent",
                        borderRight: "12px solid transparent",
                        borderBottom: "12px solid #D5706A",
                      }
                    : {
                        borderTop: "12px solid transparent",
                        borderBottom: "12px solid transparent",
                        borderLeft: "12px solid #D5706A",
                      }
            }
          />
        </div>
      )}

      {/* Close button */}
      <button
        onClick={handleSkip}
        className="absolute right-4 top-4 rounded-full p-2 text-gray-300 hover:bg-gray-100 hover:text-gray-700"
        disabled={isLoading}
      >
        <FaTimes size={16} />
      </button>

      {/* Content */}
      <div className="text-left">
        {/* Title */}
        <h2 className="mb-4 font-montserrat text-2xl font-bold text-white">
          {currentStep === 1 && "These are drivers"}
          {currentStep === 2 && "This is the map"}
          {currentStep === 3 && "This is the navigation bar"}
        </h2>

        {/* Thin horizontal line to divide text*/}
        <div className="w-full h-0.5 bg-gray-300 mb-6"></div>

        <p className="mb-8 font-montserrat text-white leading-relaxed">
          {currentStep === 1 &&
            "Browse through available drivers in your area. You can view their profiles, ratings, and routes."}
          {currentStep === 2 &&
            "Explore the map to find the best routes and nearby drivers."}
          {currentStep === 3 &&
            "Use the navigation bar to access different features and settings."}
        </p>

        {/* Action buttons */}
        <div className="flex flex-row space-x-3 justify-between">
          <button
            onClick={handleSkip}
            disabled={isLoading}
            className="flex-shrink-0 rounded-lg px-3 py-2 font-montserrat font-medium text-white text-left transition-colors whitespace-nowrap"
          >
            Done? <u>Click here to skip.</u>
          </button>

          <button
            onClick={handleNextStep}
            disabled={isLoading}
            className="flex items-center justify-center rounded-lg bg-[#B35C56] px-4 py-2 font-montserrat font-medium text-white transition-colors hover:bg-[#A14B4B] disabled:opacity-50 whitespace-nowrap"
          >
            {isLoading ? (
              <div className="flex items-center">
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Getting started...
              </div>
            ) : (
              <div className="flex items-center">
                Continue
                <FaArrowRight className="ml-2" size={14} />
              </div>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  const renderProfileSteps = () => <div> test </div>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Blurred background overlay */}
      <div
        className={`absolute inset-0 ${currentStep === 0 ? "backdrop-blur-sm bg-black bg-opacity-40" : ""}`}
        onClick={handleSkip}
      />

      {/* Tutorial content based on current step */}
      {currentStep === 0
        ? renderWelcomeStep()
        : currentStep <= 3
          ? renderHomeTutorialSteps()
          : renderProfileSteps()}
    </div>
  );
};

export default WelcomeTutorial;
