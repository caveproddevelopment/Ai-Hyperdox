// src/pages/SignUp/SignUp.jsx
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import './SignUp.css';

// ── Validation helpers ──────────────────────────────────────────
const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function validateEmail(email) {
  if (!email.trim()) return "Please enter your email.";
  if (!EMAIL_REGEX.test(email)) return "Please enter a valid email address.";
  return null;
}

function validatePassword(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  return null;
}

function getPasswordStrength(password) {
  if (!password) return null;
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++; // special char bonus
  if (score <= 2) return { label: "Weak",   color: "#ef4444", width: "33%"  };
  if (score <= 3) return { label: "Fair",   color: "#f59e0b", width: "60%"  };
  if (score === 4) return { label: "Good",  color: "#3b82f6", width: "80%"  };
  return            { label: "Strong", color: "#22c55e", width: "100%" };
}

// ── Component ───────────────────────────────────────────────────
export default function SignUp() {
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
    companyName: "",
    industry: "",
  });

  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [showPassword, setShowPassword]   = useState(false);
  const [showConfirm, setShowConfirm]     = useState(false);

  const { register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const passwordStrength = getPasswordStrength(formData.password);

  function handleChange(e) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => ({ ...prev, [name]: null }));
  }

  function validateAll() {
    const errors = {};
    if (!formData.fullName.trim()) errors.fullName = "Please enter your full name.";
    const emailErr = validateEmail(formData.email);
    if (emailErr) errors.email = emailErr;
    const passErr = validatePassword(formData.password);
    if (passErr) errors.password = passErr;
    if (!formData.confirmPassword) {
      errors.confirmPassword = "Please confirm your password.";
    } else if (formData.password !== formData.confirmPassword) {
      errors.confirmPassword = "Passwords do not match.";
    }
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const errors = validateAll();
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return; }

    try {
      setLoading(true);
      await register(formData.email, formData.password, formData.fullName);
      localStorage.setItem("hyperdox_profile", JSON.stringify({
        fullName: formData.fullName,
        companyName: formData.companyName,
        industry: formData.industry,
      }));
      navigate("/confirm-registration");
    } catch (err) {
      if (err.code === "auth/email-already-in-use")
        setError("This email is already registered. Please sign in.");
      else if (err.code === "auth/invalid-email")
        setError("Invalid email address.");
      else setError("Registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setError("");
    try {
      setLoading(true);
      await loginWithGoogle();
      navigate("/dashboard"); // ← Google users skip email verification, go straight to dashboard
    } catch (err) {
      setError("Google sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">

      <div className="auth-logo">
        <img src={logo} alt="AI Hyperdox" />
      </div>

      <div className="auth-card">
        <h1 className="auth-headline">It Is Time! Engage the Warp Drive</h1>

        {error && <div className="auth-error">{error}</div>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>

          <div className="auth-section-label">Account Details</div>

          {/* ── Full Name ── */}
          <div className="auth-field">
            <label>Your Full Name:</label>
            <div className="input-wrapper">
              <input
                type="text"
                name="fullName"
                value={formData.fullName}
                onChange={handleChange}
                autoComplete="name"
                className={fieldErrors.fullName ? "input-error" : ""}
              />
              {fieldErrors.fullName && <span className="field-error">{fieldErrors.fullName}</span>}
            </div>
          </div>

          {/* ── Email ── */}
          <div className="auth-field">
            <label>Your Email Address:</label>
            <div className="input-wrapper">
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                autoComplete="email"
                className={fieldErrors.email ? "input-error" : ""}
              />
              {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
            </div>
          </div>

          {/* ── Password ── */}
          <div className="auth-field">
            <label>Create a Password:</label>
            <div className="input-wrapper">
              <div className="password-input-row">
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  autoComplete="new-password"
                  className={fieldErrors.password ? "input-error" : ""}
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

              {/* Strength bar */}
              {formData.password && passwordStrength && (
                <div className="pw-strength">
                  <div className="pw-strength-bar">
                    <div
                      className="pw-strength-fill"
                      style={{ width: passwordStrength.width, background: passwordStrength.color }}
                    />
                  </div>
                  <span className="pw-strength-label" style={{ color: passwordStrength.color }}>
                    {passwordStrength.label}
                  </span>
                </div>
              )}

              {/* Live rules checklist */}
              {formData.password && (
                <ul className="pw-rules">
                  <li className={formData.password.length >= 8 ? "rule-ok" : "rule-fail"}>
                    {formData.password.length >= 8 ? "✓" : "✗"} At least 8 characters
                  </li>
                  <li className={/[A-Z]/.test(formData.password) ? "rule-ok" : "rule-fail"}>
                    {/[A-Z]/.test(formData.password) ? "✓" : "✗"} One uppercase letter
                  </li>
                  <li className={/[a-z]/.test(formData.password) ? "rule-ok" : "rule-fail"}>
                    {/[a-z]/.test(formData.password) ? "✓" : "✗"} One lowercase letter
                  </li>
                  <li className={/[0-9]/.test(formData.password) ? "rule-ok" : "rule-fail"}>
                    {/[0-9]/.test(formData.password) ? "✓" : "✗"} One number
                  </li>
                </ul>
              )}

              {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
            </div>
          </div>

          {/* ── Confirm Password ── */}
          <div className="auth-field">
            <label>Confirm Password:</label>
            <div className="input-wrapper">
              <div className="password-input-row">
                <input
                  type={showConfirm ? "text" : "password"}
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  autoComplete="new-password"
                  className={fieldErrors.confirmPassword ? "input-error" : ""}
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
              {fieldErrors.confirmPassword && (
                <span className="field-error">{fieldErrors.confirmPassword}</span>
              )}
            </div>
          </div>

          {/* ── Google ── */}
          <div className="auth-divider"><span>or sign up with:</span></div>
          <div className="google-btn-wrapper">
            <button type="button" className="google-btn" onClick={handleGoogleSignIn} disabled={loading}>
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" />
              Continue with Google
            </button>
          </div>

          {/* ── Company Info ── */}
          <div className="auth-section-label">Company Info (Optional)</div>

          <div className="auth-field">
            <label>Company Name:</label>
            <div className="input-wrapper">
              <input type="text" name="companyName" value={formData.companyName} onChange={handleChange} autoComplete="organization" />
            </div>
          </div>

          <div className="auth-field">
            <label>Industry:</label>
            <div className="input-wrapper">
              <input type="text" name="industry" value={formData.industry} onChange={handleChange} />
            </div>
          </div>

          {/* ── Submit ── */}
          <div className="auth-actions">
            <button type="submit" className="auth-btn-primary" disabled={loading}>
              {loading ? "Launching..." : "Submit Registration"}
            </button>
          </div>

        </form>

        <p className="auth-footer-link">
          Already have an account?{" "}
          <Link to="/signin" className="auth-link">Sign In</Link>
        </p>
      </div>
    </div>
  );
}