// src/pages/ProjectLibrary/ProjectLibrary.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import {
  collection, query, where, getDocs,
  doc, updateDoc, deleteDoc, getDoc,
} from "firebase/firestore";
import logo            from "../../assets/AI Hyperdox Logo Square V2.png";
import GoalsScopeIcon  from "../../assets/Documenticon/GoalsscopeIcon.png";
import ExecutionIcon   from "../../assets/Documenticon/ExecutionIcon.png";
import ProjectPlanIcon from "../../assets/Documenticon/ProjectPlanIcon.png";
import "./ProjectLibrary.css";

const BASE_URL = import.meta.env.VITE_API_URL;

const NAV_LINKS = [
  { label: "Products",     to: "/products"     },
  { label: "How It Works", to: "/how-it-works" },
  { label: "Pricing",      to: "/pricing"      },
  { label: "Contact Us",   to: "/contact"      },
  { label: "About Us",     to: "/about"        },
];

const DOC_TYPE_META = {
  "goals-scope":  { label: "Goals & Scope",  icon: GoalsScopeIcon  },
  "execution":    { label: "Execution",       icon: ExecutionIcon   },
  "project-plan": { label: "Project Plan",   icon: ProjectPlanIcon },
};

const iconModules = import.meta.glob(
  "../../assets/projecticon/*",
  { eager: true, query: "?url", import: "default" }
);
const PROJECT_ICONS = Object.entries(iconModules).map(([path, url]) => ({
  name: path.split("/").pop(),
  url,
}));

function resolveProjectIcon(iconValue) {
  if (!iconValue) return null;
  if (/^https?:\/\//.test(iconValue) || iconValue.startsWith("/")) return iconValue;
  return PROJECT_ICONS.find(i => i.name === iconValue)?.url ?? null;
}

function getDownloadUrl(fileObj) {
  if (!fileObj) return null;
  if (typeof fileObj === "string" && fileObj.startsWith("http")) return fileObj;
  if (typeof fileObj === "string")
    return `${BASE_URL}/download?path=${encodeURIComponent(fileObj)}`;
  const filePath = fileObj?.path ?? fileObj?.url ?? fileObj?.name;
  if (!filePath) return null;
  return `${BASE_URL}/download?path=${encodeURIComponent(filePath)}`;
}

export default function ProjectLibrary() {
  const { projectId }           = useParams();
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(null);
  const [runs,        setRuns]        = useState([]);
  const [loading,     setLoading]     = useState(true);

  // ── Fetch project + runs ────────────────────────────────────────
  useEffect(() => {
    if (!projectId || !currentUser) return;

    async function load() {
      try {
        // Project
        const projSnap = await getDoc(doc(db, "projects", projectId));
        if (!projSnap.exists()) { navigate("/dashboard"); return; }
        const projData = projSnap.data();
        if (projData.ownerId !== currentUser.uid) { navigate("/dashboard"); return; }
        setProjectName(projData.name ?? "Project");
        const icon = resolveProjectIcon(projData.icon || projData.iconUrl);
        if (icon) setProjectIcon(icon);

        // Runs that have documents saved
        const q = query(
          collection(db, "runs"),
          where("projectId", "==", projectId),
          where("userId",    "==", currentUser.uid)
        );
        const snap = await getDocs(q);
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(r => r.documents)                       // only runs with saved docs
          .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
        setRuns(list);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId, currentUser, navigate]);

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  // ── Mark as primary ────────────────────────────────────────────
  async function handlePrimary(runId, current) {
    try {
      // uncheck all others, check this one
      await Promise.all(
        runs.map(r =>
          updateDoc(doc(db, "runs", r.id), { isPrimary: r.id === runId ? !current : false })
        )
      );
      setRuns(prev =>
        prev.map(r => ({ ...r, isPrimary: r.id === runId ? !current : false }))
      );
    } catch (err) { console.error(err); }
  }

  // ── Delete run ─────────────────────────────────────────────────
  async function handleDelete(runId) {
    if (!window.confirm("Permanently delete this run? This cannot be undone.")) return;
    try {
      await deleteDoc(doc(db, "runs", runId));
      setRuns(prev => prev.filter(r => r.id !== runId));
    } catch (err) { console.error(err); }
  }

  // ── Format date ────────────────────────────────────────────────
  function formatDate(run) {
    if (run.createdAt?.toDate) {
      return run.createdAt.toDate().toLocaleDateString("en-US", {
        month: "numeric", day: "numeric", year: "numeric",
      });
    }
    if (typeof run.createdAt === "number") {
      return new Date(run.createdAt).toLocaleDateString("en-US", {
        month: "numeric", day: "numeric", year: "numeric",
      });
    }
    return "—";
  }

  // ── Get first available download URL from a run ────────────────
  function getPrimaryDownload(run) {
    if (!run.documents) return null;
    const keys = ["goals", "scope", "risk", "milestones", "resources",
                  "executionPlan", "projectPlan"];
    for (const k of keys) {
      const url = getDownloadUrl(run.documents[k]);
      if (url) return url;
    }
    return null;
  }

  return (
    <div className="lib-root">

      {/* ── Sidebar ── */}
      <aside className="lib-sidebar">
        <Link to="/" className="lib-logo-wrap">
          <img src={logo} alt="AI Hyperdox" className="lib-logo" />
        </Link>

        <Link to="/dashboard" className="lib-back-link">Back To Projects</Link>

        {projectName && (
          <div className="lib-project-section">
            <span className="lib-project-label">{projectName}:</span>
            <Link to={`/project/${projectId}/edit`}    className="lib-project-link">Project Details</Link>
            <Link to={`/project/${projectId}/library`} className="lib-project-link lib-project-link--active">Project Library</Link>
            <Link to={`/project/${projectId}/run`}     className="lib-project-link">New Document Run</Link>
          </div>
        )}

        <nav className="lib-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="lib-nav-link">{label}</Link>
          ))}
        </nav>

        <div className="lib-sidebar-footer">
          <button className="lib-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="lib-main">
        <header className="lib-topbar">
          <div className="lib-topbar-inner">
            <h1 className="lib-title">{projectName} Project Library</h1>
            {projectIcon && (
              <img src={projectIcon} alt="Project" className="lib-project-icon"
                onError={e => { e.currentTarget.style.display = "none"; }} />
            )}
          </div>
        </header>

        <section className="lib-content">
          {loading ? (
            <p className="lib-empty">Loading library...</p>
          ) : runs.length === 0 ? (
            <div className="lib-empty-state">
              <p className="lib-empty">No document runs saved yet for <strong>{projectName}</strong>.</p>
              <Link to={`/project/${projectId}/run`} className="lib-new-run-btn">
                + New Document Run
              </Link>
            </div>
          ) : (
            <div className="lib-grid">
              {runs.map(run => {
                const meta        = DOC_TYPE_META[run.docType] ?? { label: run.docType, icon: GoalsScopeIcon };
                const downloadUrl = getPrimaryDownload(run);

                return (
                  <div key={run.id} className="lib-card">
                    <img src={meta.icon} alt={meta.label} className="lib-card-icon" />

                    <p className="lib-card-date">Created: {formatDate(run)}</p>

                    <div className="lib-card-primary">
                      <span>Mark As The Primary:</span>
                      <button
                        className={`lib-primary-box ${run.isPrimary ? "lib-primary-box--on" : ""}`}
                        onClick={() => handlePrimary(run.id, run.isPrimary)}
                        title={run.isPrimary ? "Unmark as primary" : "Mark as primary"}
                      />
                    </div>

                    <div className="lib-card-actions">
                      <Link
                        to={`/project/${projectId}/run-view/${run.id}`}
                        className="lib-action-link"
                      >
                        View Run
                      </Link>

                      {downloadUrl ? (
                        <a
                          href={downloadUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="lib-action-link"
                        >
                          DOWNLOAD
                        </a>
                      ) : (
                        <span className="lib-action-link lib-action-link--disabled">DOWNLOAD</span>
                      )}
                    </div>

                    <button
                      className="lib-delete-btn"
                      onClick={() => handleDelete(run.id)}
                    >
                      Delete Permanently
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}