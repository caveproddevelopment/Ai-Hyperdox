// src/pages/NewDocumentRun/NewDocumentRun.jsx
import { useState, useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import { doc, getDoc } from "firebase/firestore";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import "./NewDocumentRun.css";

const NAV_LINKS = [
  { label: "Products",     to: "/products"    },
  { label: "How It Works", to: "/how-it-works" },
  { label: "Pricing",      to: "/pricing"     },
  { label: "Contact Us",   to: "/contact"     },
  { label: "About Us",     to: "/about"       },
];

const DOCUMENT_TYPES = [
  {
    key:         "goals-scope",
    label:       "Goals and Scope",
    description: "Define project objectives, boundaries and success criteria.",
  },
  {
    key:         "execution",
    label:       "Execution",
    description: "Outline the steps, resources and timeline to deliver the project.",
  },
  {
    key:         "project-plan",
    label:       "Project Plan",
    description: "Full structured plan covering milestones, tasks and owners.",
  },
];

export default function NewDocumentRun() {
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();
  const { projectId }           = useParams();

  const [projectName, setProjectName] = useState("");
  const [fetching,    setFetching]    = useState(true);

  // ── Load project name for sidebar ──
  useEffect(() => {
    if (!projectId) return;
    async function fetchProject() {
      try {
        const snap = await getDoc(doc(db, "projects", projectId));
        if (snap.exists()) {
          const data = snap.data();
          if (data.ownerId !== currentUser?.uid) { navigate("/dashboard"); return; }
          setProjectName(data.name ?? "Project");
        }
      } catch (err) {
        console.error(err);
      } finally {
        setFetching(false);
      }
    }
    fetchProject();
  }, [projectId, currentUser, navigate]);

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  function handleSelectType(key) {
    navigate(`/project/${projectId}/run/${key}`);
  }

  return (
    <div className="ndr-root">

      {/* ── Sidebar ── */}
      <aside className="ndr-sidebar">
        <Link to="/dashboard" className="ndr-logo-wrap">
          <div className="ndr-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>

        <Link to="/dashboard" className="ndr-back-link">Back To Projects</Link>

        {/* Project-specific links */}
        {!fetching && (
          <div className="ndr-project-section">
            <span className="ndr-project-label">{projectName}:</span>
            <Link to={`/project/${projectId}/edit`}    className="ndr-project-link">Project Details</Link>
            <Link to={`/project/${projectId}/library`} className="ndr-project-link">Project Library</Link>
            <Link to={`/project/${projectId}/run`}     className="ndr-project-link ndr-project-link--active">New Document Run</Link>
          </div>
        )}

        <nav className="ndr-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="ndr-nav-link">{label}</Link>
          ))}
        </nav>

        <div className="ndr-sidebar-footer">
          <button className="ndr-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="ndr-main">
        <header className="ndr-topbar">
          <h1 className="ndr-page-title">New Document Run</h1>
        </header>

        <section className="ndr-content">
          <p className="ndr-subtitle">Select a document type to get started:</p>

          <div className="ndr-cards">
            {DOCUMENT_TYPES.map(({ key, label, description }) => (
              <button
                key={key}
                className="ndr-card"
                onClick={() => handleSelectType(key)}
                type="button"
              >
                <span className="ndr-card-label">{label}</span>
                <span className="ndr-card-desc">{description}</span>
              </button>
            ))}
          </div>
        </section>
      </main>

    </div>
  );
}