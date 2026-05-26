// src/pages/ProjectLibrary/ProjectLibrary.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import {
  collection, query, where, getDocs,
  doc, updateDoc, deleteDoc, getDoc,
} from "firebase/firestore";
import JSZip             from "jszip";
import logo              from "../../assets/AI Hyperdox Logo Square V2.png";
import GoalsScopeIcon    from "../../assets/Documenticon/GoalsscopeIcon.png";
import ExecutionIcon     from "../../assets/Documenticon/ExecutionIcon.png";
import ProjectPlanIcon   from "../../assets/Documenticon/ProjectPlanIcon.png";
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

// Keys → human-readable filenames inside the ZIP
const DOC_KEYS = [
  { key: "goals",         filename: "Goals_Document"              },
  { key: "scope",         filename: "Scope_Document"              },
  { key: "risk",          filename: "Risk_Document"               },
  { key: "milestones",    filename: "Proposed_Milestones_Document" },
  { key: "resources",     filename: "Resource_Teams_Document"     },
  { key: "executionPlan", filename: "Execution_Plan_Document"     },
  { key: "projectPlan",   filename: "Project_Plan_Document"       },
];

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

// Guess file extension from URL or default to .docx
function getExtension(url) {
  if (!url) return ".docx";
  const clean = url.split("?")[0];
  const match = clean.match(/\.(pdf|docx|doc|txt)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".docx";
}

export default function ProjectLibrary() {
  const { projectId }           = useParams();
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();

  const [projectName,   setProjectName]   = useState("");
  const [projectIcon,   setProjectIcon]   = useState(null);
  const [runs,          setRuns]          = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [zipping,       setZipping]       = useState({}); // { [runId]: true/false }

  // ── Fetch project + runs ────────────────────────────────────────
  useEffect(() => {
    if (!projectId || !currentUser) return;

    async function load() {
      try {
        const projSnap = await getDoc(doc(db, "projects", projectId));
        if (!projSnap.exists()) { navigate("/dashboard"); return; }
        const projData = projSnap.data();
        if (projData.ownerId !== currentUser.uid) { navigate("/dashboard"); return; }
        setProjectName(projData.name ?? "Project");
        const icon = resolveProjectIcon(projData.icon || projData.iconUrl);
        if (icon) setProjectIcon(icon);

        const q = query(
          collection(db, "runs"),
          where("projectId", "==", projectId),
          where("userId",    "==", currentUser.uid)
        );
        const snap = await getDocs(q);
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(r => r.documents)
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

  // ── Download all docs as ZIP ───────────────────────────────────
  async function handleDownloadZip(run) {
    if (!run.documents) return;
    setZipping(prev => ({ ...prev, [run.id]: true }));

    try {
      const zip = new JSZip();
      const folder = zip.folder(
        `${projectName}_${DOC_TYPE_META[run.docType]?.label ?? run.docType}_${formatDate(run)}`
          .replace(/[^a-zA-Z0-9_\-]/g, "_")
      );

      // Collect all available docs for this run
      const available = DOC_KEYS.filter(({ key }) => run.documents[key]);

      // Fetch each file and add to ZIP
      await Promise.all(
        available.map(async ({ key, filename }) => {
          const url = getDownloadUrl(run.documents[key]);
          if (!url) return;
          try {
            const res = await fetch(url);
            if (!res.ok) return;
            const blob = await res.blob();
            const ext  = getExtension(url);
            folder.file(`${filename}${ext}`, blob);
          } catch (err) {
            console.warn(`Skipped ${key}:`, err);
          }
        })
      );

      // Generate and trigger download
      const zipBlob  = await zip.generateAsync({ type: "blob" });
      const zipName  = `${projectName}_Documents_${formatDate(run)}.zip`
        .replace(/[^a-zA-Z0-9_.\-]/g, "_");
      const link     = document.createElement("a");
      link.href      = URL.createObjectURL(zipBlob);
      link.download  = zipName;
      link.click();
      URL.revokeObjectURL(link.href);

    } catch (err) {
      console.error("ZIP generation failed:", err);
      alert("Failed to create ZIP. Please try downloading files individually.");
    } finally {
      setZipping(prev => ({ ...prev, [run.id]: false }));
    }
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

  // ── Count available docs in a run ─────────────────────────────
  function countDocs(run) {
    if (!run.documents) return 0;
    return DOC_KEYS.filter(({ key }) => run.documents[key]).length;
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
                const meta      = DOC_TYPE_META[run.docType] ?? { label: run.docType, icon: GoalsScopeIcon };
                const docCount  = countDocs(run);
                const isZipping = zipping[run.id] ?? false;

                return (
                  <div key={run.id} className="lib-card">
                    <img src={meta.icon} alt={meta.label} className="lib-card-icon" />

                    <p className="lib-card-date">Created: {formatDate(run)}</p>

                    {/* Doc count badge */}
                    <p className="lib-card-doc-count">
                      {docCount} document{docCount !== 1 ? "s" : ""} available
                    </p>

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

                      {/* ── ZIP download button ── */}
                      {docCount > 0 ? (
                        <button
                          className="lib-action-link lib-action-link--download"
                          onClick={() => handleDownloadZip(run)}
                          disabled={isZipping}
                          title={`Download all ${docCount} documents as ZIP`}
                        >
                          {isZipping ? "Zipping..." : `⬇ DOWNLOAD ALL (${docCount})`}
                        </button>
                      ) : (
                        <span className="lib-action-link lib-action-link--disabled">
                          DOWNLOAD
                        </span>
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