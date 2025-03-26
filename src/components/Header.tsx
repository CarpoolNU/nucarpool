import React, { Dispatch, SetStateAction, useContext, useState, useEffect } from "react";
import styled from "styled-components";
import DropDownMenu from "./DropDownMenu";
import { createPortal } from "react-dom";
import { GroupPage } from "./GroupPage";
import { trpc } from "../utils/trpc";
import { UserContext } from "../utils/userContext";
import { useRouter } from "next/router";
import Spinner from "./Spinner";
import Pusher from "pusher-js";
import { browserEnv } from "../utils/env/browser";
import { Message } from "../utils/types";

const HeaderDiv = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #c8102e;
  padding: 0 40px;
  box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.25);
  height: 8.5%;
  width: 100%;
  z-index: 10;

  @media (max-width: 768px) {
    padding: 0 20px;
  }
`;

const MobileNav = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  width: 100%;
  display: flex;
  justify-content: space-around;
  align-items: center;
  background-color: #e6e6e6;
  padding: 0px 0;
  box-shadow: 0px -2px 6px rgba(0, 0, 0, 0.15);
  z-index: 100;
  border-top: 1px solid #d1d1d1;
`;

const MobileNavItem = styled.div<{ active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  width: 25%;
  border-bottom: ${props => props.active ? '4px solid #000' : '4px solid transparent'};
  cursor: pointer;
`;

export const Logo = styled.h1`
  font-family: "Lato", sans-serif;
  height: 111px;
  font-style: normal;
  font-weight: 700;
  font-size: 48px;
  line-height: 77px;
  display: flex;
  align-items: center;
  text-align: center;
  color: #f4f4f4;

  @media (max-width: 768px) {
    font-size: 32px;
    height: 70px;
    line-height: normal;
  }
`;

interface HeaderProps {
  data?: {
    sidebarValue: string;
    setSidebar: Dispatch<SetStateAction<HeaderOptions>>;
    disabled: boolean;
  };
  admin?: boolean;
  signIn?: boolean;
  profile?: boolean;
  checkChanges?: () => void;
  isMobile?: boolean;
}

export type HeaderOptions = "explore" | "requests";

const Header = (props: HeaderProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [activeNav, setActiveNav] = useState<string>("explore");
  const { data: unreadMessagesCount } =
    trpc.user.messages.getUnreadMessageCount.useQuery();
  const user = useContext(UserContext);
  const router = useRouter();

  const [currentunreadMessagesCount, setCurrentunreadMessagesCount] = useState(0);
  const [displayGroup, setDisplayGroup] = useState<boolean>(false);
  
  // Check if we're explicitly passed isMobile or detect it ourselves
  const [internalIsMobile, setInternalIsMobile] = useState(false);
  const isMobile = props.isMobile !== undefined ? props.isMobile : internalIsMobile;

  // Only run our own detection if isMobile isn't passed as a prop
  useEffect(() => {
    if (props.isMobile !== undefined) return;
    
    const checkIfMobile = () => {
      setInternalIsMobile(window.innerWidth <= 768);
    };
    
    // Initial check
    checkIfMobile();
    
    // Add event listener for window resize
    window.addEventListener('resize', checkIfMobile);
    
    // Cleanup
    return () => window.removeEventListener('resize', checkIfMobile);
  }, [props.isMobile]);

  useEffect(() => {
    if (!user?.id) return;

    const pusher = new Pusher(browserEnv.NEXT_PUBLIC_PUSHER_KEY, {
      cluster: browserEnv.NEXT_PUBLIC_PUSHER_CLUSTER
    });

    const messageChannel = pusher.subscribe(`notification-${user?.id}`);

    messageChannel.bind("sendNotification", (data : {newMessage : Message}) => {
      props.data?.setSidebar(prev => {
        if (prev !== "requests") {
          setCurrentunreadMessagesCount(prev => prev + 1);
        }
        return prev
      });
    })

    return () => {
      messageChannel.unbind("sendNotification");
      pusher.unsubscribe(`notification-${user?.id}`); 
    };
  }, [props.data?.setSidebar]);

  const renderClassName = (sidebarValue: string, sidebarText: string) => {
    if (sidebarValue == "explore" && sidebarText == "explore") {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else if (sidebarValue == "requests" && sidebarText == "explore") {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }

    if (sidebarValue == "requests" && sidebarText == "requests") {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else if (sidebarValue == "explore" && sidebarText == "requests") {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }

    if (displayGroup) {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }
  };

  const handleAdminClick = async () => {
    setIsLoading(true);
    if (!props.admin) {
      await router.push("/admin");
      setIsLoading(false);
    } else {
      await router.push("/");
      setIsLoading(false);
    }
  };

  const handleMapClick = async () => {
    if (props.checkChanges) {
      props.checkChanges();
    }
  };

  const handleMobileNavClick = (option: string) => {
    setActiveNav(option);
    
    if (option === "explore" || option === "requests") {
      props.data?.setSidebar(option as HeaderOptions);
      if (option === "requests") {
        setCurrentunreadMessagesCount(0);
      }
    } else if (option === "group") {
      setDisplayGroup(true);
    } else if (option === "profile") {
      // Handle profile click - this would open the dropdown menu functionality
    }
  };

  const renderSidebarOptions = ({
    sidebarValue,
    setSidebar,
    disabled,
  }: {
    sidebarValue: string;
    setSidebar: Dispatch<SetStateAction<HeaderOptions>>;
    disabled: boolean;
  }) => {
    if (isLoading) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white ">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="pr-8 ">
        <button
          onClick={() => {
            setSidebar("explore");
          }}
          disabled={disabled}
          className={renderClassName(sidebarValue, "explore")}
        >
          Explore
        </button>
        <button
          onClick={() => {
            setSidebar("requests");
            setCurrentunreadMessagesCount(0);
          }}
          disabled={disabled}
          className={`${renderClassName(sidebarValue, "requests")} relative`}
        >
          Requests
          {(unreadMessagesCount !== 0 || currentunreadMessagesCount !== 0) && (
            <span className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-white">
              <span className="text-xs font-bold text-northeastern-red">
                {currentunreadMessagesCount !== 0  ? currentunreadMessagesCount : unreadMessagesCount}
              </span>
            </span>
          )}
        </button>
        <button
          onClick={() => setDisplayGroup(true)}
          disabled={disabled}
          className={renderClassName(sidebarValue, "filler")}
        >
          My Group
        </button>
        {user?.permission !== "USER" && (
          <button
            onClick={handleAdminClick}
            disabled={disabled}
            className={renderClassName(sidebarValue, "filler")}
          >
            Admin
          </button>
        )}
      </div>
    );
  };

  const renderMobileNav = () => {
    // Make sure we're getting the current active tab from props if available
    const currentActiveTab = props.data?.sidebarValue || activeNav;
    
    const navItems = [
      { 
        id: "explore", 
        icon: "⚭", // Compass icon - in a real app, use an SVG or icon library
        label: "Explore" 
      },
      { 
        id: "requests", 
        icon: "👥", // People icon
        label: "Requests",
        badge: unreadMessagesCount !== 0 || currentunreadMessagesCount !== 0
      },
      { 
        id: "profile", 
        icon: "👤", // User profile icon
        label: "Profile" 
      }
    ];

    return (
      <MobileNav>
        {navItems.map((item) => (
          <MobileNavItem 
            key={item.id} 
            active={currentActiveTab === item.id || (item.id === "explore" && currentActiveTab === "explore")}
            onClick={() => {
                handleMobileNavClick(item.id);
            }}
          >
            <div style={{ fontSize: '24px' }}>{item.icon}</div>
            <div style={{ position: 'relative' }}>
              {item.badge && (
                <span style={{ 
                  position: 'absolute', 
                  top: '-18px', 
                  right: '-10px',
                  background: '#c8102e',
                  color: 'white',
                  borderRadius: '50%',
                  width: '20px',
                  height: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px'
                }}>
                  {currentunreadMessagesCount !== 0 ? currentunreadMessagesCount : unreadMessagesCount}
                </span>
              )}
              <span style={{ fontSize: '12px' }}>{item.label}</span>
            </div>
          </MobileNavItem>
        ))}
      </MobileNav>
    );
  };

  // On mobile, we only render the mobile navigation
  if (isMobile) {
    return (
      <>
        {renderMobileNav()}
        {displayGroup &&
          createPortal(
            <GroupPage onClose={() => setDisplayGroup(false)} />,
            document.body
          )}
      </>
    );
  }

  // On desktop, render the regular header
  return (
    <>
      <HeaderDiv>
        <Logo>CarpoolNU</Logo>
        {props.admin ? (
          <div className="flex items-center">
            <button
              onClick={handleAdminClick}
              className="rounded-xl pr-10 text-xl font-medium text-white"
            >
              Home
            </button>
            {!props.signIn && <DropDownMenu />}
          </div>
        ) : (
          <div className="flex items-center">
            {props.data && renderSidebarOptions(props.data)}
            {props.profile && (
              <div className="flex">
                <button
                  onClick={handleMapClick}
                  className="rounded-xl pr-10 text-xl font-medium text-white"
                >
                  Map
                </button>
                {user?.permission !== "USER" && (
                  <button
                    onClick={handleAdminClick}
                    className="rounded-xl pr-10 text-xl font-medium text-white"
                  >
                    Admin
                  </button>
                )}
              </div>
            )}
            {!props.signIn && <DropDownMenu />}
          </div>
        )}
      </HeaderDiv>

      {displayGroup &&
        createPortal(
          <GroupPage onClose={() => setDisplayGroup(false)} />,
          document.body
        )}
    </>
  );
};

export default Header;