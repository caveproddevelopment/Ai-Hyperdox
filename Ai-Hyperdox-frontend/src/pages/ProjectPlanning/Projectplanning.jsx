// src/pages/ProjectPlanning/ProjectPlanning.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, functions, storage } from "../../firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref, getDownloadURL } from "firebase/storage";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import ProjectPlanIcon from '../../assets/Documenticon/ProjectPlanIcon.png';
import "./Projectplanning.css";

const BASE_URL       = import.meta.env.VITE_PROJECT_PLAN_API_URL;
const MAX_FILE_MB    = 2;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

const iconModules = import.meta.glob(
  '../../assets/projecticon/*',
  { eager: true, query: '?url', import: 'default' }
);
const PROJECT_ICONS = Object.entries(iconModules).map(([path, url]) => ({
  name: path.split('/').pop(),
  url,
}));

function resolveProjectIcon(iconValue) {
  if (!iconValue) return null;
  if (typeof iconValue !== 'string') return null;
  if (/^https?:\/\//.test(iconValue) || iconValue.startsWith('/')) return iconValue;
  return PROJECT_ICONS.find(i => i.name === iconValue)?.url ?? null;
}

const NAV_LINKS = [
  { label: "Products",     to: "/products"    },
  { label: "How It Works", to: "/how-it-works" },
  { label: "Pricing",      to: "/pricing"     },
  { label: "Contact Us",   to: "/contact"     },
  { label: "About Us",     to: "/about"       },
];

const OUTPUT_DOCS = [
  { docKey: "wbs",      label: "Work Breakdown Structure (WBS)" },
  { docKey: "timeline", label: "Project Timeline" },
  { docKey: "resource", label: "Resource Allocation Plan" },
  { docKey: "cost",     label: "Cost Management Plan" },
];

export default function ProjectPlanning() {
  const { projectId }           = useParams();
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(null);
  const [lastRunDate, setLastRunDate] = useState(null);
  const [fetching,    setFetching]    = useState(true);

  const [form, setForm] = useState({
    project_name: "",
    milestones:   "",
    timeline:     "",
    resources:    "",
    methodology:  "Agile",
  });
  const [budgetFile,  setBudgetFile]  = useState(null);
  const [fileError,   setFileError]   = useState("");
  const [isDragging,  setIsDragging]  = useState(false);
  const [status,      setStatus]      = useState("");
  const [docs,        setDocs]        = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    async function fetchProject() {
      try {
        const snap = await getDoc(doc(db, "projects", projectId));
        if (snap.exists()) {
          const data = snap.data();
          if (data.ownerId !== currentUser?.uid) { navigate("/dashboard"); return; }
          setProjectName(data.name ?? "Project");
          const resolvedIcon = resolveProjectIcon(data.icon || data.iconUrl);
          if (resolvedIcon) setProjectIcon(resolvedIcon);
          if (data.lastProjectPlanRun) setLastRunDate(data.lastProjectPlanRun);
          setForm(prev => ({ ...prev, project_name: data.name ?? "" }));
        }
      } catch (err) { console.error(err); }
      finally { setFetching(false); }
    }
    fetchProject();
  }, [projectId, currentUser, navigate]);

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch (err) { console.error(err); }
  }

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleMethodologyChange(value) {
    setForm(prev => ({ ...prev, methodology: value }));
  }

  function validateAndSetFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError(
        `File too large. Maximum size is ${MAX_FILE_MB}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`
      );
      setBudgetFile(null);
      const input = document.getElementById("pp-file-input");
      if (input) input.value = "";
      return;
    }
    setFileError("");
    setBudgetFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    validateAndSetFile(e.dataTransfer.files[0]);
  }

  async function handleGenerate() {
    if (!form.project_name.trim()) { setStatus("Please enter a project name."); return; }
    if (!BASE_URL)                 { setStatus("API configuration error. BASE_URL is not set."); return; }
    if (fileError)                 { setStatus("Please remove the invalid file before generating."); return; }

    setLoading(true);
    setDocs(null);
    setCurrentRunId(null);

    // ── STEP 1: Billing ──────────────────────────────────────────
    let runId = null;
    try {
      setStatus("Checking billing...");
      const initiateRun   = httpsCallable(functions, "initiateRun");
      const billingResult = await initiateRun({ projectId, docType: "project-plan" });

      runId = billingResult.data.runId ?? null;
      setCurrentRunId(runId);

      if (billingResult.data.status === "free") {
        setStatus(`Free run used. ${billingResult.data.freeRunsRemaining} free run(s) remaining. Generating documents...`);
      } else {
        setStatus("$10 charged successfully. Generating documents...");
      }
    } catch (err) {
      setStatus(`Billing error: ${err.message}`);
      setLoading(false);
      return;
    }

    // ── STEP 2: Generate documents ───────────────────────────────
    try {
      const response = await fetch(`${BASE_URL}/api/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            form.project_name,
            form.milestones,
            form.timeline,
            form.resources,
            null,
            form.methodology,
          ],
          api_name: "/generate_project_plan",
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const result = await response.json();
      if (!result.data || !Array.isArray(result.data)) throw new Error("Invalid response format from server.");

      const [statusMsg, wbs, timeline, resource, cost] = result.data;
      setStatus(statusMsg);
      setDocs({ wbs, timeline, resource, cost });

      // ── STEP 3: Save to Firestore ────────────────────────────
      const runDate = new Date().toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      });
      setLastRunDate(runDate);

      await updateDoc(doc(db, "projects", projectId), { lastProjectPlanRun: runDate });

      if (runId) {
        await updateDoc(doc(db, "runs", runId), {
          documents:   { wbs, timeline, resource, cost },
          completedAt: Date.now(),
          projectName: form.project_name,
          isPrimary:   false,
          inputs: {
            projectName: form.project_name,
            milestones:  form.milestones,
            timeline:    form.timeline,
            resources:   form.resources,
            methodology: form.methodology,
          },
        });
      }

    } catch (err) {
      setStatus(`Error: ${err.message || "Connection failed. Please try again."}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function downloadDocument(docKey, fileObj, label) {
    if (!fileObj) return;

    setDownloadingKey(docKey);
    try {
      let downloadUrl = null;

      const storagePath = fileObj?.path;
      const urlField    = fileObj?.url;

      if (storagePath) {
        const fileRef = ref(storage, storagePath);
        downloadUrl = await getDownloadURL(fileRef);
      } else if (typeof urlField === "string" && urlField.startsWith("http")) {
        downloadUrl = urlField;
      } else if (typeof fileObj === "string" && fileObj.startsWith("http")) {
        downloadUrl = fileObj;
      } else {
        const fallbackPath = typeof fileObj === "string" ? fileObj : (urlField ?? fileObj?.name);
        if (!fallbackPath) throw new Error("No valid file reference found.");
        downloadUrl = `${BASE_URL}/download?path=${encodeURIComponent(fallbackPath)}`;
      }

      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(`Failed to download ${label}:`, err);
      setStatus(`Failed to download ${label}: ${err.message || "Unknown error"}`);
    } finally {
      setDownloadingKey(null);
    }
  }

  return (
    <div className="ndr-root">

      {/* Sidebar */}
      <aside className="ndr-sidebar">
        <Link to="/dashboard" className="ndr-logo-wrap">
          <div className="ndr-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>

        <Link to="/dashboard" className="ndr-back-link">Back To Projects</Link>

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

      {/* Main */}
      <main className="ndr-main">
        <header className="ndr-topbar">
          <div className="pp-topbar-inner">
            <h1 className="ndr-page-title">{projectName} Project Planning Document Run</h1>
            {projectIcon && (
              <img
                src={projectIcon}
                alt="Project"
                className="pp-project-icon"
                onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = logo; }}
              />
            )}
          </div>
        </header>

        <section className="ndr-content">

          <div className="pp-run-header">
            <img src={ProjectPlanIcon} alt="Project Planning" className="pp-doc-icon" />
            <p className="pp-last-run">
              {lastRunDate
                ? <>Last Project Planning Run For <strong>{projectName}</strong> Was {lastRunDate}&nbsp;
                    <Link to={`/project/${projectId}/library`} className="pp-view-run">View Run</Link>
                  </>
                : <>No previous Project Planning runs for <strong>{projectName}</strong></>
              }
            </p>
          </div>

          <div className="pp-columns">

            {/* LEFT */}
            <div className="pp-inputs">
              <div className="pp-field-group">
                <label className="pp-label">Project Name</label>
                <input
                  className="pp-input"
                  name="project_name"
                  placeholder="e.g. Uggalot Episode 1 Production"
                  value={form.project_name}
                  onChange={handleChange}
                />
              </div>

              <div className="pp-field-group">
                <label className="pp-label">📐 Methodology</label>
                <p className="pp-field-hint">Agile = sprint/epic decomposition. Waterfall = phase-gate planning.</p>
                <div className="pp-radio-row">
                  <button
                    type="button"
                    className={`pp-radio-btn ${form.methodology === "Agile" ? "pp-radio-btn--active" : ""}`}
                    onClick={() => handleMethodologyChange("Agile")}
                  >
                    <span className="pp-radio-dot" />
                    Agile
                  </button>
                  <button
                    type="button"
                    className={`pp-radio-btn ${form.methodology === "Waterfall" ? "pp-radio-btn--active" : ""}`}
                    onClick={() => handleMethodologyChange("Waterfall")}
                  >
                    <span className="pp-radio-dot" />
                    Waterfall
                  </button>
                </div>
              </div>

              <div className="pp-field-group">
                <label className="pp-label">Milestones</label>
                <textarea
                  className="pp-textarea"
                  name="milestones"
                  placeholder={
`e.g.
M1 – Script Finalized | 2026-06-20
M2 – Animation Draft Complete | 2026-07-15
M3 – Episode 1 Launch | 2026-08-01`}
                  value={form.milestones}
                  onChange={handleChange}
                  rows={6}
                />
              </div>

              <div className="pp-field-group">
                <label className="pp-label">High-Level Timeline</label>
                <textarea
                  className="pp-textarea"
                  name="timeline"
                  placeholder={
`e.g.
Phase 1: Pre-Production  (Jun 1 – Jun 30)
Phase 2: Production      (Jul 1 – Jul 31)
Phase 3: Post-Production (Aug 1 – Aug 15)
Phase 4: Launch          (Aug 16+)`}
                  value={form.timeline}
                  onChange={handleChange}
                  rows={5}
                />
              </div>

              <div className="pp-field-group">
                <label className="pp-label">Resource List</label>
                <textarea
                  className="pp-textarea"
                  name="resources"
                  placeholder={
`e.g.
Anshika – Illustrator (full-time)
Helna   – Illustrator (full-time)
Deepanshu – Animator Intern
Ratim   – Animator Intern
Aatish  – App Developer Intern`}
                  value={form.resources}
                  onChange={handleChange}
                  rows={6}
                />
              </div>

              {/* Upload */}
              <div className="pp-field-group">
                <label className="pp-label">
                  📊 Budget Spreadsheet — optional
                  <span className="pp-file-size-hint"> (XLSX / CSV / PDF / TXT — Max {MAX_FILE_MB}MB)</span>
                </label>
                <div
                  className={`pp-upload-box ${isDragging ? "pp-upload-box--drag" : ""} ${fileError ? "pp-upload-box--error" : ""}`}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById("pp-file-input").click()}
                >
                  <input
                    id="pp-file-input"
                    type="file"
                    accept=".xlsx,.xls,.csv,.pdf,.txt"
                    onChange={e => validateAndSetFile(e.target.files[0])}
                    hidden
                  />
                  {budgetFile ? (
                    <p className="pp-upload-name">
                      📎 {budgetFile.name}
                      <span className="pp-upload-size"> ({(budgetFile.size / 1024 / 1024).toFixed(2)}MB)</span>
                    </p>
                  ) : (
                    <>
                      <div className="pp-upload-icon">↑</div>
                      <p className="pp-upload-text">Drop File Here<br/>- or -<br/>Click to Upload</p>
                    </>
                  )}
                </div>

                {fileError && <p className="pp-file-error">❌ {fileError}</p>}

                {budgetFile && !fileError && (
                  <button
                    type="button"
                    className="pp-clear-file-btn"
                    onClick={e => {
                      e.stopPropagation();
                      setBudgetFile(null);
                      setFileError("");
                      const input = document.getElementById("pp-file-input");
                      if (input) input.value = "";
                    }}
                  >
                    ✕ Remove file
                  </button>
                )}
              </div>

              <button
                className="pp-generate-btn"
                onClick={handleGenerate}
                disabled={loading || !!fileError}
              >
                {loading ? "Generating..." : "🚀 Generate Project Plan Documents"}
              </button>
            </div>

            {/* RIGHT */}
            <div className="pp-outputs">
              <div className="pp-field-group">
                <label className="pp-label">Status</label>
                <div className="pp-status-box">
                  {status && <p className="pp-status-text">{status}</p>}
                </div>
              </div>

              {OUTPUT_DOCS.map(({ docKey, label }) => (
                <div key={docKey} className="pp-field-group">
                  <label className="pp-label">📄 {label}</label>
                  <div className="pp-output-box">
                    {loading ? (
                      <div className="pp-generating">
                        <span className="pp-spinner" />
                        <span className="pp-generating-text">Generating...</span>
                      </div>
                    ) : docs?.[docKey] ? (
                      <button
                        type="button"
                        className="pp-download-link"
                        onClick={() => downloadDocument(docKey, docs[docKey], label)}
                        disabled={downloadingKey === docKey}
                      >
                        {downloadingKey === docKey ? "Preparing..." : "⬇ Download"}
                      </button>
                    ) : (
                      <span className="pp-output-empty-icon">📄</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

          </div>
        </section>
      </main>
    </div>
  );
}