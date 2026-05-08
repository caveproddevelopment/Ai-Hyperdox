// src/pages/SignIn/SignIn.jsx
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import Navbar from "../../components/Navbar/Navbar";
import "./SignIn.css";

export default function SignIn() {
  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]               = useState("");
  const [loading, setLoading]           = useState(false);

  const { login, loginWithGoogle } = useAuth();   // ← add loginWithGoogle
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email.trim()) return setError("Please enter your email.");
    if (!password)     return setError("Please enter your password.");

    try {
      setLoading(true);
      const result = await login(email, password);
      if (!result.user.emailVerified) {
        setError("Please verify your email before signing in. Check your inbox.");
        return;
      }
      navigate("/dashboard");
    } catch (err) {
      if (
        err.code === "auth/user-not-found"    ||
        err.code === "auth/wrong-password"    ||
        err.code === "auth/invalid-credential"
      ) {
        setError("Invalid email or password. Please try again.");
      } else if (err.code === "auth/too-many-requests") {
        setError("Too many attempts. Please try again later.");
      } else {
        setError("Sign in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Google Sign-In ──────────────────────────────────────────
  async function handleGoogleSignIn() {
    setError("");
    try {
      setLoading(true);
      await loginWithGoogle();
      navigate("/dashboard");
    } catch (err) {
      if (err.code === "auth/account-exists-with-different-credential") {
        // Same email already registered with email/password
        setError(
          "This email is already registered with a password. " +
          "Please sign in with your email and password instead."
        );
      } else if (err.code === "auth/popup-closed-by-user") {
        // User dismissed the popup — silent, no error needed
      } else {
        setError("Google sign-in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="signin-page">
      <Navbar />

      <div className="signin-card">
        <h1 className="signin-headline">Lets get you signed in</h1>

        {error && <div className="signin-error">{error}</div>}

        <form className="signin-form" onSubmit={handleSubmit} noValidate>

          {/* Email */}
          <div className="signin-field">
            <label>Sign In Email:</label>
            <div className="signin-input-wrapper">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
          </div>

          {/* Password */}
          <div className="signin-field">
            <label>Your Password:</label>
            <div className="signin-input-wrapper">
              <div className="signin-password-row">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="toggle-pw"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="signin-actions">
            <button type="submit" className="signin-btn-primary" disabled={loading}>
              {loading ? "Engaging..." : "Sign In"}
            </button>
          </div>

        </form>

        {/* ── Google divider + button ── */}
        <div className="signin-divider"><span>or sign in with</span></div>
        <div className="google-btn-wrapper">
          <button
            type="button"
            className="google-btn"
            onClick={handleGoogleSignIn}
            disabled={loading}
          >
            <img
              src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
              alt="Google"
            />
            Continue with Google
          </button>
        </div>

        {/* Footer links */}
        <div className="signin-footer">
          <p>
            <Link to="/forgot-password" className="signin-link">
              Forgot Password?
            </Link>
          </p>
          <p>
            Don&apos;t have an account?{" "}
            <Link to="/signup" className="signin-link">
              Need to Register?
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}