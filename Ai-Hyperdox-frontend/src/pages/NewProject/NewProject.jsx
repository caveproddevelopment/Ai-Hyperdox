// src/pages/NewProject/NewProject.jsx
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import "./NewProject.css";

function getInitials(user) {
  if (!user) return "??";
  if (user.displayName) {
    const parts = user.displayName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (user.email || "??").slice(0, 2).toUpperCase();
}

const NAV_LINKS = [
  { label: "Products",     to: "/products"    },
  { label: "How It Works", to: "/how-it-works" },
  { label: "Pricing",      to: "/pricing"     },
  { label: "Contact Us",   to: "/contact"     },
  { label: "About Us",     to: "/about"       },
];

// ── Load all icons from assets/projecticon ──
const iconModules = import.meta.glob(
  '../../assets/projecticon/*',
  { eager: true, query: '?url', import: 'default' }
);
const PROJECT_ICONS = Object.entries(iconModules).map(([path, url]) => ({
  name: path.split('/').pop(),
  url,
}));

const DEFAULT_ICON = PROJECT_ICONS[0]?.url ?? "";

export default function NewProject() {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const [projectName,  setProjectName]  = useState("");
  const [projectType,  setProjectType]  = useState("");
  const [description,  setDescription]  = useState("");
  const [iconPreview,  setIconPreview]  = useState(DEFAULT_ICON);
  const [showPicker,   setShowPicker]   = useState(false);
  const [error,        setError]        = useState("");
  const [loading,      setLoading]      = useState(false);

  const initials = getInitials(currentUser);

  function handleSelectIcon(url) {
    setIconPreview(url);
    setShowPicker(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!projectName.trim()) return setError("Project Name is required.");

    try {
      setLoading(true);

      await addDoc(collection(db, "projects"), {
        name:        projectName.trim(),
        type:        projectType.trim(),
        description: description.trim(),
        icon:        PROJECT_ICONS.find(i => i.url === iconPreview)?.name ?? "",
        ownerId:     currentUser.uid,
        ownerEmail:  currentUser.email,
        createdAt:   serverTimestamp(),
      });

      navigate("/dashboard");
    } catch (err) {
      console.error("Error saving project:", err);
      setError("Failed to create project. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  return (
    <div className="np-root">

      {/* ── Sidebar ── */}
      <aside className="np-sidebar">
        <Link to="/" className="np-logo-wrap">
          <div className="np-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>
        <Link to="/dashboard" className="np-back-sidebar">Back To Projects</Link>
        <nav className="np-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="np-nav-link">{label}</Link>
          ))}
        </nav>
        <div className="np-sidebar-footer">
          <button className="np-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="np-main">
        <header className="np-topbar">
          <h1 className="np-page-title">New Project</h1>
          <Link to="/dashboard" className="np-back-top">Back To Projects</Link>
        </header>

        <div className="np-form-wrap">
          {error && <div className="np-error">{error}</div>}

          <form onSubmit={handleSubmit} noValidate>

            {/* Project Name */}
            <div className="np-field">
              <label className="np-label">Project Name:</label>
              <div className="np-input-group">
                <input type="text" className="np-input" value={projectName}
                  onChange={(e) => setProjectName(e.target.value)} />
                <span className="np-required">(Required)</span>
              </div>
            </div>

            {/* Project Type */}
            <div className="np-field">
              <label className="np-label">Project Type:</label>
              <div className="np-input-group">
                <input type="text" className="np-input" value={projectType}
                  onChange={(e) => setProjectType(e.target.value)} />
              </div>
            </div>

            {/* Description */}
            <div className="np-field np-field--top">
              <label className="np-label">Project Description:</label>
              <textarea className="np-textarea" value={description}
                onChange={(e) => setDescription(e.target.value)} rows={8} />
            </div>

            {/* Icon + Kickoff row */}
            <div className="np-field np-field--top np-icon-row">
              <label className="np-label">Project Icon:</label>
              <div className="np-icon-content">
                <img src={iconPreview} alt="Project Icon" className="np-icon-preview" />
                <button type="button" className="np-change-btn"
                  onClick={() => setShowPicker(true)}>
                  Change
                </button>
              </div>

              <button type="submit" className="np-kickoff-btn" disabled={loading}>
                {loading ? "Saving..." : "Kickoff"}
              </button>
            </div>

          </form>
        </div>
      </main>

      {/* ── Icon Picker Modal ── */}
      {showPicker && (
        <div className="np-modal-overlay" onClick={() => setShowPicker(false)}>
          <div className="np-modal" onClick={(e) => e.stopPropagation()}>
            <div className="np-modal-header">
              <span>Choose Project Icon</span>
              <button className="np-modal-close" onClick={() => setShowPicker(false)}>✕</button>
            </div>
            <div className="np-icon-grid">
              {PROJECT_ICONS.map(({ name, url }) => (
                <button
                  key={name}
                  type="button"
                  className={`np-icon-option ${iconPreview === url ? "np-icon-option--selected" : ""}`}
                  onClick={() => handleSelectIcon(url)}
                  title={name}
                >
                  <img src={url} alt={name} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}