import { useState, useEffect } from "react";
import { isMobileWidth } from "./breakpoints";

/**
 * The single source of "is this a mobile viewport". `Header` used to
 * run its own `<= 768` check, which disagreed with this one and produced a
 * desktop layout wearing the mobile navigation between the two values.
 */
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(isMobileWidth(window.innerWidth));
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => {
      window.removeEventListener("resize", checkMobile);
    };
  }, []);

  return isMobile;
};

export default useIsMobile;
