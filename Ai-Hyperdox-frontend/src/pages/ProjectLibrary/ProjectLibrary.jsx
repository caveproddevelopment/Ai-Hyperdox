// src/pages/ProjectLibrary/ProjectLibrary.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import {
  collection, query, where, getDocs,
  doc, updateDoc, deleteDoc, getDoc,
} from "firebase/firestore";
import { getStorage, ref, deleteObject, getBytes } from "firebase/storage";
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

const DOC_KEYS = [
  { key: "goals",         filename: "Goals_Document"               },
  { key: "scope",         filename: "Scope_Document"               },
  { key: "risk",          filename: "Risk_Document"                },
  { key: "milestones",    filename: "Proposed_Milestones_Document" },
  { key: "resources",     filename: "Resource_Teams_Document"      },
  { key: "executionPlan", filename: "Execution_Plan_Document"      },
  { key: "projectPlan",   filename: "Project_Plan_Document"        },
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

function getStoragePath(fileObj) {
  if (!fileObj) return null;
  if (typeof fileObj === "object" && fileObj.path) return fileObj.path;
  return null;
}

// ── Download a single file as a Blob ─────────────────────────────────────────
// Strategy 1 (preferred): Firebase Storage SDK getBytes() — authenticated,
//   no CORS issues, works even if the stored signed URL has expired.
// Strategy 2: Route through backend /download proxy — avoids expired signed
//   URLs by letting the server re-sign or re-fetch the file.
async function fetchFileBlob(fileObj) {
  // ── Strategy 1: SDK path (avoids CORS entirely) ──────────────────
  const storagePath = getStoragePath(fileObj);
  if (storagePath) {
    try {
      const storage = getStorage();
      const fileRef = ref(storage, storagePath);
      const bytes   = await getBytes(fileRef);          // ArrayBuffer
      return new Blob([bytes], { type: "application/pdf" });
    } catch (sdkErr) {
      // If SDK fails (e.g. path wrong), fall through to Strategy 2
      console.warn("SDK getBytes failed, falling back to proxy fetch:", sdkErr?.code ?? sdkErr?.message);
    }
  }

  // ── Strategy 2: Resolve URL, then route through backend proxy ────
  // Direct signed URLs expire quickly; routing through BASE_URL/download
  // lets the backend re-sign or serve the file reliably.
  let resolvedUrl = null;

  if (typeof fileObj === "string") {
    if (fileObj.startsWith("http")) {
      resolvedUrl = fileObj;                                                      // already a full URL
    } else {
      resolvedUrl = `${BASE_URL}/download?path=${encodeURIComponent(fileObj)}`;  // plain backend path
    }
  } else if (typeof fileObj === "object") {
    if (fileObj?.url) {
      // url may be a full http URL or a plain backend path like /tmp/...
      resolvedUrl = fileObj.url.startsWith("http")
        ? fileObj.url
        : `${BASE_URL}/download?path=${encodeURIComponent(fileObj.url)}`;
    } else if (fileObj?.path) {
      resolvedUrl = `${BASE_URL}/download?path=${encodeURIComponent(fileObj.path)}`;
    } else if (fileObj?.name) {
      resolvedUrl = `${BASE_URL}/download?path=${encodeURIComponent(fileObj.name)}`;
    }
  }

  if (!resolvedUrl) {
    // ── Last-resort fallback ──────────────────────────────────────
    // If fileObj is some other shape (Firestore Timestamp, nested object, etc.)
    // try converting it to a string and sending to the backend proxy.
    const coerced = typeof fileObj === "object" && fileObj !== null
      ? (fileObj?.downloadURL ?? fileObj?.fileUrl ?? fileObj?.uri ?? fileObj?.link ?? null)
      : null;

    if (coerced && typeof coerced === "string") {
      resolvedUrl = coerced.startsWith("http")
        ? `${BASE_URL}/download?path=${encodeURIComponent(coerced)}`
        : `${BASE_URL}/download?path=${encodeURIComponent(coerced)}`;
    }
  }

  if (!resolvedUrl) throw new Error("No download URL or storage path available.");

  // KEY FIX: if it's an external signed URL (not already our backend),
  // proxy it through the backend to avoid expiry & CORS issues.
  const fetchUrl = resolvedUrl.startsWith("http") && !resolvedUrl.startsWith(BASE_URL)
    ? `${BASE_URL}/download?path=${encodeURIComponent(resolvedUrl)}`
    : resolvedUrl;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  // Guard: reject HTML (expired signed URL served the SPA's index.html)
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/html")) {
    throw new Error(
      "Received an HTML page instead of a PDF. The stored URL has expired — " +
      "please regenerate the documents."
    );
  }

  const blob = await res.blob();
  if (blob.size === 0) throw new Error("Received empty file.");

  return blob;
}

export default function ProjectLibrary() {
  const { projectId }           = useParams();
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(null);
  const [runs,        setRuns]        = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [zipping,     setZipping]     = useState({});

  // ── Fetch project + runs ──────────────────────────────────────────────────
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

  // ── Mark as primary ───────────────────────────────────────────────────────
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

  // ── Delete run + Firebase Storage files ──────────────────────────────────
  // FIX: Storage cleanup is best-effort. A storage error logs a warning but
  // does NOT block the Firestore delete — the run record is always removed.
  async function handleDelete(runId) {
    if (!window.confirm("Permanently delete this run? This cannot be undone.")) return;

    const run = runs.find(r => r.id === runId);
    if (!run) return;

    // ── Step 1: Best-effort storage cleanup ─────────────────────────
    const storage = getStorage();
    if (run.documents) {
      const storageDeletes = DOC_KEYS
        .map(({ key }) => getStoragePath(run.documents[key]))
        .filter(Boolean)
        .map(p => deleteObject(ref(storage, p)));

      if (storageDeletes.length > 0) {
        const results = await Promise.allSettled(storageDeletes);
        const failed  = results.filter(r =>
          r.status === "rejected" &&
          r.reason?.code !== "storage/object-not-found"  // already gone = fine
        );
        if (failed.length > 0) {
          // Warn but do NOT return — Firestore delete still proceeds below
          console.warn(
            `${failed.length} storage file(s) could not be deleted (manual cleanup may be needed).`,
            failed.map(f => f.reason?.code ?? f.reason?.message)
          );
        }
      }
    }

    // ── Step 2: Always delete the Firestore run document ────────────
    try {
      await deleteDoc(doc(db, "runs", runId));
      setRuns(prev => prev.filter(r => r.id !== runId));
    } catch (err) {
      console.error("Firestore delete failed:", err);
      alert("Could not delete the run record:\n" + err.message);
    }
  }

  // ── Download all docs as ZIP ──────────────────────────────────────────────
  async function handleDownloadZip(run) {
    if (!run.documents) return;
    setZipping(prev => ({ ...prev, [run.id]: true }));

    try {
      const zip    = new JSZip();
      const folder = zip.folder(
        `${projectName}_${DOC_TYPE_META[run.docType]?.label ?? run.docType}_${formatDate(run)}`
          .replace(/[^a-zA-Z0-9_\-]/g, "_")
      );

      const available = DOC_KEYS.filter(({ key }) => run.documents[key]);
      if (available.length === 0) { alert("No documents found for this run."); return; }

      const results = await Promise.allSettled(
        available.map(async ({ key, filename }) => {
          const blob = await fetchFileBlob(run.documents[key]);
          folder.file(`${filename}.pdf`, blob);
          console.log(`✓ ${filename}.pdf  (${(blob.size / 1024).toFixed(1)} KB)`);
          return key;
        })
      );

      const failed    = results
        .map((r, i) => r.status === "rejected"
          ? { key: available[i].key, reason: r.reason?.message ?? "Unknown error" }
          : null)
        .filter(Boolean);
      const succeeded = results.filter(r => r.status === "fulfilled").length;

      if (failed.length > 0) console.error("Failed documents:", failed);

      if (succeeded === 0) {
        alert(
          `Could not download any files.\n\n` +
          `Reason: ${failed[0]?.reason ?? "Unknown"}\n\n` +
          `Check the browser console for full details.`
        );
        return;
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipName = `${projectName}_Documents_${formatDate(run)}.zip`
        .replace(/[^a-zA-Z0-9_.\-]/g, "_");

      const link    = document.createElement("a");
      link.href     = URL.createObjectURL(zipBlob);
      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      if (failed.length > 0) {
        alert(
          `ZIP created with ${succeeded} of ${available.length} files.\n\n` +
          `Missing:\n` +
          failed.map(f => `• ${f.key}: ${f.reason}`).join("\n")
        );
      }

    } catch (err) {
      console.error("ZIP generation failed:", err);
      alert(`Failed to create ZIP:\n\n${err.message}`);
    } finally {
      setZipping(prev => ({ ...prev, [run.id]: false }));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
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
                    <div className="lib-card-primary">
                      <span>Mark As The Primary:</span>
                      <button
                        className={`lib-primary-box ${run.isPrimary ? "lib-primary-box--on" : ""}`}
                        onClick={() => handlePrimary(run.id, run.isPrimary)}
                        title={run.isPrimary ? "Unmark as primary" : "Mark as primary"}
                      />
                    </div>
                    <div className="lib-card-actions">
                      <Link to={`/project/${projectId}/run-view/${run.id}`} className="lib-action-link">
                        View Run
                      </Link>
                      {docCount > 0 ? (
                        <button
                          className="lib-action-link lib-action-link--download"
                          onClick={() => handleDownloadZip(run)}
                          disabled={isZipping}
                          title={`Download all ${docCount} documents as ZIP`}
                        >
                          {isZipping ? "Zipping..." : "DOWNLOAD"}
                        </button>
                      ) : (
                        <span className="lib-action-link lib-action-link--disabled">DOWNLOAD</span>
                      )}
                    </div>
                    <button className="lib-delete-btn" onClick={() => handleDelete(run.id)}>
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