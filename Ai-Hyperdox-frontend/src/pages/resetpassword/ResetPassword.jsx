// src/pages/ResetPassword/ResetPassword.jsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuth, confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import Navbar from "../../components/Navbar/Navbar";
import "./ResetPassword.css";

export default function ResetPassword() {
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [error,           setError]           = useState("");
  const [success,         setSuccess]         = useState("");
  const [loading,         setLoading]         = useState(false);

  const navigate = useNavigate();
  const auth     = getAuth();

  // Firebase sends an "oobCode" in the URL when the user clicks the reset link
  const oobCode = new URLSearchParams(window.location.search).get("oobCode");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!newPassword)                          return setError("Please enter a new password.");
    if (newPassword.length < 6)                return setError("Password must be at least 6 characters.");
    if (newPassword !== confirmPassword)       return setError("Passwords do not match.");

    // If no oobCode, the user landed here directly (e.g. from dev/testing)
    if (!oobCode) {
      return setError("Invalid or expired reset link. Please request a new one.");
    }

    try {
      setLoading(true);

      // Verify the code is still valid, then reset
      await verifyPasswordResetCode(auth, oobCode);
      await confirmPasswordReset(auth, oobCode, newPassword);

      setSuccess("Password reset successfully! Redirecting to sign in...");
      setTimeout(() => navigate("/signin"), 2500);
    } catch (err) {
      if (
        err.code === "auth/expired-action-code" ||
        err.code === "auth/invalid-action-code"
      ) {
        setError("This reset link has expired or already been used. Please request a new one.");
      } else if (err.code === "auth/weak-password") {
        setError("Password is too weak. Please choose a stronger password.");
      } else {
        setError("Failed to reset password. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="reset-page">

      {/* Shared Navbar */}
      <Navbar />

      {/* ── Card ── */}
      <div className="reset-card">
        <h1 className="reset-headline">Please Reset Your Password</h1>

        {error   && <div className="reset-error">{error}</div>}
        {success && <div className="reset-success">{success}</div>}

        <form className="reset-form" onSubmit={handleSubmit} noValidate>

          {/* New Password */}
          <div className="reset-field">
            <label>New Password:</label>
            <div className="reset-input-wrapper">
              <div className="reset-password-row">
                <input
                  type={showNew ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="toggle-pw"
                  onClick={() => setShowNew((v) => !v)}
                  tabIndex={-1}
                  title={showNew ? "Hide password" : "Show password"}
                >
                  {showNew ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
          </div>

          {/* Confirm Password */}
          <div className="reset-field">
            <label>Confirm New Password:</label>
            <div className="reset-input-wrapper">
              <div className="reset-password-row">
                <input
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="toggle-pw"
                  onClick={() => setShowConfirm((v) => !v)}
                  tabIndex={-1}
                  title={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="reset-actions">
            <button
              type="submit"
              className="reset-btn-primary"
              disabled={loading}
            >
              {loading ? "Resetting..." : "Reset"}
            </button>
          </div>

        </form>
      </div>

    </div>
  );
}