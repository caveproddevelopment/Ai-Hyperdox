import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import Navbar from "../../components/Navbar/Navbar";
import "./Profile.css";

export default function Profile() {
  const {
    currentUser,
    logout,
    updateUserProfile,
    updateUserEmail,
    saveUserDoc,
    getUserDoc,
  } = useAuth();

  const navigate = useNavigate();

  const [fullName,  setFullName]  = useState("");
  const [email,     setEmail]     = useState("");
  const [company,   setCompany]   = useState("");
  const [industry,  setIndustry]  = useState("");

  const [success, setSuccess] = useState("");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  // ── Pre-fill from Firebase Auth + Firestore on mount ──
  useEffect(() => {
    if (!currentUser) return;

    setFullName(currentUser.displayName || "");
    setEmail(currentUser.email || "");

    getUserDoc(currentUser.uid).then((data) => {
      // Firestore is source of truth — overrides stale Auth displayName cache
      if (data.fullName) setFullName(data.fullName);
      setCompany(data.company   || "");
      setIndustry(data.industry || "");
    });
  }, [currentUser]);

  // ── Handle profile update ──
  async function handleUpdate(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!fullName.trim()) return setError("Please enter your full name.");
    if (!email.trim())    return setError("Please enter your email address.");

    try {
      setLoading(true);

      await updateUserProfile({ displayName: fullName.trim() });

      if (email.trim() !== currentUser.email) {
        await updateUserEmail(email.trim());
      }

      await saveUserDoc(currentUser.uid, {
        fullName:  fullName.trim(),
        email:     email.trim(),
        company:   company.trim(),
        industry:  industry.trim(),
      });

      setSuccess("Profile updated successfully.");
    } catch (err) {
      if (err.code === "auth/requires-recent-login") {
        setError("Please sign out and sign back in before changing your email.");
      } else if (err.code === "auth/invalid-email") {
        setError("Please enter a valid email address.");
      } else if (err.code === "auth/email-already-in-use") {
        setError("This email is already in use by another account.");
      } else {
        setError("Failed to update profile. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Handle account cancellation ──
  async function handleCancelAccount() {
    const confirmed = window.confirm(
      "Are you sure you want to cancel and close your account? This cannot be undone."
    );
    if (!confirmed) return;

    try {
      await logout();
      navigate("/");
    } catch (err) {
      setError("Failed to close account. Please try again.");
    }
  }

  return (
    <div className="profile-page">
      <Navbar />

      {/* ── LEFT SIDEBAR ── */}
      <div className="profile-sidebar">
        <button className="sidebar-btn" onClick={() => navigate("/dashboard")}>
          ← Dashboard
        </button>
      </div>

      <div className="profile-card">
        <h1 className="profile-headline">Adjust Your Profile Settings</h1>

        {error   && <div className="profile-banner profile-banner--error">{error}</div>}
        {success && <div className="profile-banner profile-banner--success">{success}</div>}

        <form className="profile-form" onSubmit={handleUpdate} noValidate>

          {/* Full Name */}
          <div className="profile-field">
            <label>Your Full Name:</label>
            <div className="profile-input-wrapper">
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
              />
            </div>
          </div>

          {/* Email */}
          <div className="profile-field">
            <label>Your Email Address:</label>
            <div className="profile-input-wrapper">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
          </div>

          {/* Company */}
          <div className="profile-field">
            <label>Company Name:</label>
            <div className="profile-input-wrapper">
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoComplete="organization"
              />
            </div>
          </div>

          {/* Industry */}
          <div className="profile-field">
            <label>Industry:</label>
            <div className="profile-input-wrapper">
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
            </div>
          </div>

          {/* Submit + Cancel */}
          <div className="profile-actions">
            <button type="submit" className="profile-btn-primary" disabled={loading}>
              {loading ? "Updating..." : "Update Profile"}
            </button>
            <button
              type="button"
              className="profile-btn-secondary"
              onClick={() => navigate("/dashboard")}
              disabled={loading}
            >
              Cancel
            </button>
          </div>

        </form>

        {/* Footer links */}
        <div className="profile-footer">
          <Link to="/forgot-password" className="profile-link">
            Reset Password
          </Link>
          <Link to="/billing" className="profile-link">
            Billing Settings
          </Link>
          <button
            type="button"
            className="profile-link profile-link--danger"
            onClick={handleCancelAccount}
          >
            Cancel/Close Account Entirely
          </button>
        </div>
      </div>
    </div>
  );
}