// src/pages/ForgotPassword/ForgotPassword.jsx
import { useState }            from "react";
import { Link }                from "react-router-dom";
import { useAuth }             from "../../context/AuthContext";
import Navbar                  from "../../components/Navbar/Navbar";
import "./ForgotPassword.css";

export default function ForgotPassword() {
  const [email,   setEmail]   = useState("");
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const { sendPasswordReset } = useAuth();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!email.trim()) return setError("Please enter your email address.");

    try {
      setLoading(true);
      await sendPasswordReset(email.trim());

      // ✅ Show success — do NOT navigate
      // User must click the link in their email to reach /reset-password
      setSuccess(true);

    } catch (err) {
      if (
        err.code === "auth/user-not-found" ||
        err.code === "auth/invalid-email"
      ) {
        setError("No account found with that email address.");
      } else {
        setError("Failed to send reset link. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Success state — email sent ───────────────────────────────
  if (success) {
    return (
      <div className="forgot-page">
        <Navbar />
        <div className="forgot-card">
          <div className="forgot-success-icon">✉️</div>
          <h1 className="forgot-headline">Check Your Email</h1>
          <p className="forgot-subtext">
            We sent a password reset link to <strong>{email}</strong>.
            Click the link in that email to set your new password.
          </p>
          <p className="forgot-subtext" style={{ marginTop: "10px", fontSize: "13px", opacity: 0.6 }}>
            Didn't receive it? Check your spam folder, or{" "}
            <button
              className="forgot-link"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
              onClick={() => setSuccess(false)}
            >
              try again
            </button>
            .
          </p>
          <div className="forgot-footer" style={{ marginTop: "24px" }}>
            <Link to="/signin" className="forgot-link">← Back to Sign In</Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Default state — email form ───────────────────────────────
  return (
    <div className="forgot-page">
      <Navbar />

      <div className="forgot-card">
        <h1 className="forgot-headline">Reset Your Password</h1>
        <p className="forgot-subtext">
          Enter the email linked to your account and we'll send you a reset link.
        </p>

        {error && <div className="forgot-error">{error}</div>}

        <form className="forgot-form" onSubmit={handleSubmit} noValidate>
          <div className="forgot-field">
            <label>Your Account Email:</label>
            <div className="forgot-input-wrapper">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>
          </div>

          <div className="forgot-actions">
            <button
              type="submit"
              className="forgot-btn-primary"
              disabled={loading}
            >
              {loading ? "Sending..." : "Send Reset Link"}
            </button>
          </div>
        </form>

        <div className="forgot-footer">
          <p>
            Remembered your password?{" "}
            <Link to="/signin" className="forgot-link">Back to Sign In</Link>
          </p>
          <p>
            Don't have an account?{" "}
            <Link to="/signup" className="forgot-link">Need to Register?</Link>
          </p>
        </div>
      </div>
    </div>
  );
}