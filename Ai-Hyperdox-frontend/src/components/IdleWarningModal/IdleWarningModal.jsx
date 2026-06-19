// src/components/IdleWarningModal/IdleWarningModal.jsx
import { useEffect, useState } from "react";
import "./IdleWarningModal.css";

const COUNTDOWN_SECONDS = 60;

export default function IdleWarningModal({ open, onStayActive, onLogoutNow }) {
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (!open) {
      setSecondsLeft(COUNTDOWN_SECONDS);
      return;
    }
    const interval = setInterval(() => setSecondsLeft((s) => Math.max(s - 1, 0)), 1000);
    return () => clearInterval(interval);
  }, [open]);

  if (!open) return null;

  return (
    <div className="idle-modal-overlay">
      <div className="idle-modal-box">
        <h3 className="idle-modal-title">Are you still there?</h3>
        <p className="idle-modal-body">
          You've been inactive for a while. You'll be signed out in{" "}
          <strong>{secondsLeft}s</strong> for security.
        </p>
        <div className="idle-modal-actions">
          <button type="button" onClick={onLogoutNow} className="idle-modal-btn idle-modal-btn-secondary">
            Sign out now
          </button>
          <button type="button" onClick={onStayActive} className="idle-modal-btn idle-modal-btn-primary">
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}