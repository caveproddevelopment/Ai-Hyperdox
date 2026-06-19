// src/hooks/useIdleLogout.js
import { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const IDLE_TIMEOUT = 15 * 60 * 1000;       // 15 min — full logout
const WARNING_BEFORE = 60 * 1000;          // show warning 1 min before
const WARNING_AT = IDLE_TIMEOUT - WARNING_BEFORE;

const STORAGE_KEY = "aihyperdox_last_activity";

export function useIdleLogout() {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const [showWarning, setShowWarning] = useState(false);
  const warningTimerRef = useRef(null);
  const logoutTimerRef = useRef(null);

  const handleLogout = useCallback(async () => {
    setShowWarning(false);
    try {
      await logout();
    } catch (err) {
      console.error("Auto logout failed:", err);
    } finally {
      navigate("/signin", { replace: true, state: { reason: "idle" } });
    }
  }, [logout, navigate]);

  const clearTimers = () => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
  };

  const scheduleTimers = useCallback(() => {
    clearTimers();
    warningTimerRef.current = setTimeout(() => setShowWarning(true), WARNING_AT);
    logoutTimerRef.current = setTimeout(handleLogout, IDLE_TIMEOUT);
  }, [handleLogout]);

  const registerActivity = useCallback(() => {
    setShowWarning(false);
    scheduleTimers();
    localStorage.setItem(STORAGE_KEY, Date.now().toString());
  }, [scheduleTimers]);

  const stayActive = useCallback(() => registerActivity(), [registerActivity]);

  useEffect(() => {
    if (!currentUser) {
      clearTimers();
      setShowWarning(false);
      return;
    }

    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

    events.forEach((event) =>
      window.addEventListener(event, registerActivity, { passive: true })
    );

    const handleStorageSync = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        setShowWarning(false);
        scheduleTimers();
      }
    };
    window.addEventListener("storage", handleStorageSync);

    scheduleTimers();
    localStorage.setItem(STORAGE_KEY, Date.now().toString());

    return () => {
      clearTimers();
      events.forEach((event) => window.removeEventListener(event, registerActivity));
      window.removeEventListener("storage", handleStorageSync);
    };
  }, [currentUser, registerActivity, scheduleTimers]);

  return { showWarning, stayActive, logoutNow: handleLogout };
}