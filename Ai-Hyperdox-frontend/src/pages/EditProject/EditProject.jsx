// src/pages/EditProject/EditProject.jsx
import { useState, useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import "./EditProject.css";

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

function resolveIcon(iconName) {
  return PROJECT_ICONS.find(i => i.name === iconName)?.url ?? PROJECT_ICONS[0]?.url ?? "";
}

export default function EditProject() {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();
  const { projectId } = useParams();

  const [projectName,  setProjectName]  = useState("");
  const [projectType,  setProjectType]  = useState("");
  const [description,  setDescription]  = useState("");
  const [iconName,     setIconName]     = useState("");
  const [iconPreview,  setIconPreview]  = useState("");
  const [showPicker,   setShowPicker]   = useState(false);
  const [error,        setError]        = useState("");
  const [success,      setSuccess]      = useState("");
  const [loading,      setLoading]      = useState(false);
  const [fetching,     setFetching]     = useState(true);

  const initials = getInitials(currentUser);

  // ── Load existing project ──
  useEffect(() => {
    if (!projectId) return;

    async function fetchProject() {
      try {
        const docRef  = doc(db, "projects", projectId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
          setError("Project not found.");
          setFetching(false);
          return;
        }

        const data = docSnap.data();

        // Security: only owner can edit
        if (data.ownerId !== currentUser?.uid) {
          navigate("/dashboard");
          return;
        }

        setProjectName(data.name        ?? "");
        setProjectType(data.type        ?? "");
        setDescription(data.description ?? "");
        setIconName(   data.icon        ?? "");
        setIconPreview(resolveIcon(data.icon));
      } catch (err) {
        console.error("Error fetching project:", err);
        setError("Failed to load project.");
      } finally {
        setFetching(false);
      }
    }

    fetchProject();
  }, [projectId, currentUser, navigate]);

  function handleSelectIcon(name, url) {
    setIconName(name);
    setIconPreview(url);
    setShowPicker(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!projectName.trim()) return setError("Project Name is required.");

    try {
      setLoading(true);

      await updateDoc(doc(db, "projects", projectId), {
        name:        projectName.trim(),
        type:        projectType.trim(),
        description: description.trim(),
        icon:        iconName,
        updatedAt:   serverTimestamp(),
      });

      setSuccess("Project saved successfully!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      console.error("Error updating project:", err);
      setError("Failed to save changes. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  if (fetching) {
    return (
      <div className="ep-root">
        <p style={{ padding: "40px", color: "#888" }}>Loading project...</p>
      </div>
    );
  }

  return (
    <div className="ep-root">

      {/* ── Sidebar ── */}
      <aside className="ep-sidebar">
        <Link to="/dashboard" className="ep-logo-wrap">
          <div className="ep-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>
        <Link to="/dashboard" className="ep-back-sidebar">Back To Projects</Link>

        {/* Project-specific links */}
        <div className="ep-project-section">
          <span className="ep-project-label">{projectName}:</span>
          <Link to={`/project/${projectId}/library`} className="ep-project-link">Project Library</Link>
          <Link to={`/project/${projectId}/run`}     className="ep-project-link">New Document Run</Link>
        </div>

        <nav className="ep-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="ep-nav-link">{label}</Link>
          ))}
        </nav>
        <div className="ep-sidebar-footer">
          <button className="ep-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="ep-main">
        <header className="ep-topbar">
          <h1 className="ep-page-title">Edit Project Details</h1>
        </header>

        <div className="ep-form-wrap">
          {error   && <div className="ep-error">{error}</div>}
          {success && <div className="ep-success">{success}</div>}

          <form onSubmit={handleSubmit} noValidate>

            {/* Project Name */}
            <div className="ep-field">
              <label className="ep-label">Project Name:</label>
              <div className="ep-input-group">
                <input type="text" className="ep-input" value={projectName}
                  onChange={(e) => setProjectName(e.target.value)} />
                <span className="ep-required">(Required)</span>
              </div>
            </div>

            {/* Project Type */}
            <div className="ep-field">
              <label className="ep-label">Project Type:</label>
              <div className="ep-input-group">
                <input type="text" className="ep-input" value={projectType}
                  onChange={(e) => setProjectType(e.target.value)} />
              </div>
            </div>

            {/* Description */}
            <div className="ep-field ep-field--top">
              <label className="ep-label">Project Description:</label>
              <textarea className="ep-textarea" value={description}
                onChange={(e) => setDescription(e.target.value)} rows={8} />
            </div>

            {/* Icon + Save row */}
            <div className="ep-field ep-field--top ep-icon-row">
              <label className="ep-label">Project Icon:</label>
              <div className="ep-icon-content">
                <img src={iconPreview} alt="Project Icon" className="ep-icon-preview" />
                <button type="button" className="ep-change-btn"
                  onClick={() => setShowPicker(true)}>
                  Change
                </button>
              </div>

              <button type="submit" className="ep-save-btn" disabled={loading}>
                {loading ? "Saving..." : "Save"}
              </button>
            </div>

          </form>
        </div>
      </main>

      {/* ── Icon Picker Modal ── */}
      {showPicker && (
        <div className="ep-modal-overlay" onClick={() => setShowPicker(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-header">
              <span>Choose Project Icon</span>
              <button className="ep-modal-close" onClick={() => setShowPicker(false)}>✕</button>
            </div>
            <div className="ep-icon-grid">
              {PROJECT_ICONS.map(({ name, url }) => (
                <button
                  key={name}
                  type="button"
                  className={`ep-icon-option ${iconName === name ? "ep-icon-option--selected" : ""}`}
                  onClick={() => handleSelectIcon(name, url)}
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