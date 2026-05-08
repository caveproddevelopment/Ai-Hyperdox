// src/pages/ForgotPassword/ForgotPassword.jsx
import { useState }            from "react";
import { useNavigate, Link }   from "react-router-dom";
import { useAuth }             from "../../context/AuthContext";  // ← use context
import Navbar                  from "../../components/Navbar/Navbar";
import "./ForgotPassword.css";

export default function ForgotPassword() {
  const [email,   setEmail]   = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const navigate             = useNavigate();
  const { sendPasswordReset } = useAuth();              // ← branded reset

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!email.trim()) return setError("Please enter your email address.");

    try {
      setLoading(true);

      // 🔑 Calls Cloud Function → GAS → your branded Gmail template
      await sendPasswordReset(email.trim());

      navigate("/reset-password");
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

  return (
    <div className="forgot-page">
      <Navbar />

      <div className="forgot-card">
        <h1 className="forgot-headline">Reset Your Password</h1>
        <p className="forgot-subtext">
          Enter the email linked to your account and we&apos;ll send you a reset link.
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
            Don&apos;t have an account?{" "}
            <Link to="/signup" className="forgot-link">Need to Register?</Link>
          </p>
        </div>
      </div>
    </div>
  );
}