// src/pages/ResetPassword/ResetPassword.jsx
import { useState, useEffect } from "react";
import { useNavigate }         from "react-router-dom";
import { getAuth, confirmPasswordReset } from "firebase/auth";
import { httpsCallable }       from "firebase/functions";
import { functions }           from "../../firebase";
import Navbar                  from "../../components/Navbar/Navbar";
import "./ResetPassword.css";

function validatePassword(password) {
  if (!password)                return "Please enter a new password.";
  if (password.length < 8)      return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password))  return "Must include at least one uppercase letter.";
  if (!/[a-z]/.test(password))  return "Must include at least one lowercase letter.";
  if (!/[0-9]/.test(password))  return "Must include at least one number.";
  return null;
}

function getPasswordStrength(password) {
  if (!password) return null;
  let score = 0;
  if (password.length >= 8)          score++;
  if (/[A-Z]/.test(password))        score++;
  if (/[a-z]/.test(password))        score++;
  if (/[0-9]/.test(password))        score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  if (score <= 2) return { label: "Weak",   color: "#ef4444", width: "33%"  };
  if (score <= 3) return { label: "Fair",   color: "#f59e0b", width: "60%"  };
  if (score === 4) return { label: "Good",  color: "#3b82f6", width: "80%"  };
  return           { label: "Strong", color: "#22c55e", width: "100%" };
}

export default function ResetPassword() {
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [error,           setError]           = useState("");
  const [success,         setSuccess]         = useState("");
  const [loading,         setLoading]         = useState(false);
  const [validating,      setValidating]      = useState(true);
  const [firebaseLink,    setFirebaseLink]    = useState(null);

  const navigate         = useNavigate();
  const auth             = getAuth();
  const passwordStrength = getPasswordStrength(newPassword);
  const token            = new URLSearchParams(window.location.search).get("token");

  useEffect(() => {
    if (!token) {
      setError("No reset token found. Please use the link from your email.");
      setValidating(false);
      return;
    }
    async function validate() {
      try {
        const validateResetToken = httpsCallable(functions, "validateResetToken");
        const result = await validateResetToken({ token });
        setFirebaseLink(result.data.link);
      } catch (err) {
        if (err.message?.includes("expired")) {
          setError("⏱ This reset link has expired (5 min limit). Please request a new one.");
        } else if (err.message?.includes("already been used")) {
          setError("This link has already been used. Please request a new one.");
        } else {
          setError("Invalid reset link. Please request a new one.");
        }
      } finally {
        setValidating(false);
      }
    }
    validate();
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const passErr = validatePassword(newPassword);
    if (passErr) return setError(passErr);
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    if (!firebaseLink) return setError("Invalid reset session. Please request a new link.");
    try {
      setLoading(true);
      const oobCode = new URL(firebaseLink).searchParams.get("oobCode");
      await confirmPasswordReset(auth, oobCode, newPassword);
      setSuccess("✅ Password reset successfully! Redirecting to sign in...");
      setTimeout(() => navigate("/signin"), 2500);
    } catch (err) {
      if (err.code === "auth/expired-action-code" || err.code === "auth/invalid-action-code") {
        setError("This reset link has expired. Please request a new one.");
      } else if (err.code === "auth/weak-password") {
        setError("Password is too weak. Please choose a stronger one.");
      } else {
        setError("Failed to reset password. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (validating) {
    return (
      <div className="reset-page">
        <Navbar />
        <div className="reset-card">
          <p style={{ color: "#00d4e8", textAlign: "center", fontFamily: "monospace" }}>
            Validating reset link...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="reset-page">
      <Navbar />
      <div className="reset-card">
        <h1 className="reset-headline">Please Reset Your Password</h1>
        {error   && <div className="reset-error">{error}</div>}
        {success && <div className="reset-success">{success}</div>}

        {firebaseLink && !success && (
          <form className="reset-form" onSubmit={handleSubmit} noValidate>
            <div className="reset-field">
              <label>New Password:</label>
              <div className="reset-input-wrapper">
                <div className="reset-password-row">
                  <input type={showNew ? "text" : "password"} value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                  <button type="button" className="toggle-pw"
                    onClick={() => setShowNew(v => !v)} tabIndex={-1}>
                    {showNew ? "🙈" : "👁️"}
                  </button>
                </div>
                {newPassword && passwordStrength && (
                  <div className="pw-strength">
                    <div className="pw-strength-bar">
                      <div className="pw-strength-fill"
                        style={{ width: passwordStrength.width, background: passwordStrength.color }} />
                    </div>
                    <span className="pw-strength-label" style={{ color: passwordStrength.color }}>
                      {passwordStrength.label}
                    </span>
                  </div>
                )}
                {newPassword && (
                  <ul className="pw-rules">
                    <li className={newPassword.length >= 8 ? "rule-ok" : "rule-fail"}>
                      {newPassword.length >= 8 ? "✓" : "✗"} At least 8 characters
                    </li>
                    <li className={/[A-Z]/.test(newPassword) ? "rule-ok" : "rule-fail"}>
                      {/[A-Z]/.test(newPassword) ? "✓" : "✗"} One uppercase letter
                    </li>
                    <li className={/[a-z]/.test(newPassword) ? "rule-ok" : "rule-fail"}>
                      {/[a-z]/.test(newPassword) ? "✓" : "✗"} One lowercase letter
                    </li>
                    <li className={/[0-9]/.test(newPassword) ? "rule-ok" : "rule-fail"}>
                      {/[0-9]/.test(newPassword) ? "✓" : "✗"} One number
                    </li>
                  </ul>
                )}
              </div>
            </div>
            <div className="reset-field">
              <label>Confirm New Password:</label>
              <div className="reset-input-wrapper">
                <div className="reset-password-row">
                  <input type={showConfirm ? "text" : "password"} value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                  <button type="button" className="toggle-pw"
                    onClick={() => setShowConfirm(v => !v)} tabIndex={-1}>
                    {showConfirm ? "🙈" : "👁️"}
                  </button>
                </div>
                {confirmPassword && (
                  <p style={{ fontSize: "12px", marginTop: "5px",
                    color: newPassword === confirmPassword ? "#22c55e" : "#ef4444" }}>
                    {newPassword === confirmPassword ? "✓ Passwords match" : "✗ Passwords do not match"}
                  </p>
                )}
              </div>
            </div>
            <div className="reset-actions">
              <button type="submit" className="reset-btn-primary" disabled={loading}>
                {loading ? "Resetting..." : "Reset Password"}
              </button>
            </div>
          </form>
        )}

        {!firebaseLink && !success && (
          <div style={{ textAlign: "center", marginTop: "20px" }}>
            <a href="/forgot-password" className="reset-btn-primary"
              style={{ display: "inline-block", textDecoration: "none" }}>
              Request New Reset Link
            </a>
          </div>
        )}
      </div>
    </div>
  );
}