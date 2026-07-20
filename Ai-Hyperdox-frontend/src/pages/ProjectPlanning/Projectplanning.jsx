// src/pages/ProjectPlanning/ProjectPlanning.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, functions, storage } from "../../firebase";
import { doc, getDoc, updateDoc, increment } from "firebase/firestore";
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

// Reads a File into the {"name": str, "data": "data:<mime>;base64,..."} shape the
// backend's extract_text_from_file()/extract_handoff_json() expect - same pattern
// used by the Goals & Scope agent's frontend, since a raw browser File object can't
// survive JSON.stringify() across the /api/predict POST.
function fileToBase64Payload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: reader.result });
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const NAV_LINKS = [
  { label: "Products",     to: "/products"    },
  { label: "How It Works", to: "/how-it-works" },
  { label: "Pricing",      to: "/pricing"     },
  { label: "Contact Us",   to: "/contact"     },
  { label: "About Us",     to: "/about"       },
];

// ext controls the expected download content-type and the saved file extension -
// the Backbone Plan is JSON, everything else is a PDF.
const OUTPUT_DOCS = [
  { docKey: "wbs",       label: "Work Breakdown Structure (WBS)",                        ext: "pdf"  },
  { docKey: "timeline",  label: "Project Timeline",                                       ext: "pdf"  },
  { docKey: "resource",  label: "Resource Allocation Plan",                               ext: "pdf"  },
  { docKey: "cost",      label: "Cost Management Plan",                                   ext: "pdf"  },
  { docKey: "combined",  label: "Project Plan Guardrail Document (Combined)",             ext: "pdf"  },
  { docKey: "backbone",  label: "Backbone Plan - Handoff for Execution Agent (JSON)",      ext: "json" },
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
    budget_text:  "",
    methodology:  "Agile",
  });

  // Goals & Scope Handoff Package - single .json upload, optional
  const [handoffFile,       setHandoffFile]       = useState(null);
  const [handoffError,      setHandoffError]      = useState("");
  const [isDraggingHandoff, setIsDraggingHandoff] = useState(false);

  // Upload Supporting Documents - multi-file, any format, optional
  const [supportingFiles,   setSupportingFiles]   = useState([]);
  const [supportingError,   setSupportingError]   = useState("");
  const [isDraggingSupport, setIsDraggingSupport] = useState(false);

  const [status,         setStatus]         = useState("");
  const [docs,           setDocs]           = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [currentRunId,   setCurrentRunId]   = useState(null);
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

  // ── Goals & Scope Handoff Package (single .json) ──────────────
  function validateAndSetHandoffFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setHandoffError("Handoff package must be a .json file exported from the Goals & Scope agent.");
      setHandoffFile(null);
      const input = document.getElementById("pp-handoff-input");
      if (input) input.value = "";
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setHandoffError(
        `File too large. Maximum size is ${MAX_FILE_MB}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`
      );
      setHandoffFile(null);
      const input = document.getElementById("pp-handoff-input");
      if (input) input.value = "";
      return;
    }
    setHandoffError("");
    setHandoffFile(file);
  }

  function handleDropHandoff(e) {
    e.preventDefault();
    setIsDraggingHandoff(false);
    validateAndSetHandoffFile(e.dataTransfer.files[0]);
  }

  function clearHandoffFile(e) {
    e.stopPropagation();
    setHandoffFile(null);
    setHandoffError("");
    const input = document.getElementById("pp-handoff-input");
    if (input) input.value = "";
  }

  // ── Upload Supporting Documents (multi-file, any format) ───────
  function addSupportingFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const tooLarge = incoming.filter(f => f.size > MAX_FILE_BYTES);
    const accepted  = incoming.filter(f => f.size <= MAX_FILE_BYTES);

    if (tooLarge.length) {
      setSupportingError(
        `${tooLarge.length} file(s) exceeded the ${MAX_FILE_MB}MB limit and were skipped: ` +
        tooLarge.map(f => f.name).join(", ")
      );
    } else {
      setSupportingError("");
    }

    if (accepted.length) {
      setSupportingFiles(prev => [...prev, ...accepted]);
    }
    const input = document.getElementById("pp-supporting-input");
    if (input) input.value = "";
  }

  function handleDropSupporting(e) {
    e.preventDefault();
    setIsDraggingSupport(false);
    addSupportingFiles(e.dataTransfer.files);
  }

  function removeSupportingFile(index) {
    setSupportingFiles(prev => prev.filter((_, i) => i !== index));
  }

  async function handleGenerate() {
    if (!form.project_name.trim()) { setStatus("Please enter a project name."); return; }
    if (!BASE_URL)                 { setStatus("API configuration error. BASE_URL is not set."); return; }
    if (handoffError)              { setStatus("Please remove the invalid handoff file before generating."); return; }
    if (supportingError)           { setStatus("Please review the supporting documents before generating."); return; }

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
      const [handoffPayload, supportingPayloads] = await Promise.all([
        handoffFile ? fileToBase64Payload(handoffFile) : Promise.resolve(null),
        Promise.all(supportingFiles.map(fileToBase64Payload)),
      ]);

      const response = await fetch(`${BASE_URL}/api/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Positional order must match generate_project_plan()'s v2.2 signature:
          // (project_name, milestones, timeline_input, resources, budget_text_input,
          //  supporting_uploads, methodology, handoff_upload)
          data: [
            form.project_name,
            form.milestones,
            form.timeline,
            form.resources,
            form.budget_text,
            supportingPayloads,
            form.methodology,
            handoffPayload,
          ],
          api_name: "/generate_project_plan",
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const result = await response.json();
      if (!result.data || !Array.isArray(result.data)) throw new Error("Invalid response format from server.");

      const [statusMsg, wbs, timeline, resource, cost, combined, backbone] = result.data;
      setStatus(statusMsg);
      setDocs({ wbs, timeline, resource, cost, combined, backbone });

      // ── STEP 3: Save to Firestore ────────────────────────────
      const runDate = new Date().toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      });
      setLastRunDate(runDate);

      await updateDoc(doc(db, "projects", projectId), {
        lastProjectPlanRun: runDate,
        runCount: increment(1),
      });

      if (runId) {
        await updateDoc(doc(db, "runs", runId), {
          documents:   { wbs, timeline, resource, cost, combined, backbone },
          completedAt: Date.now(),
          projectName: form.project_name,
          isPrimary:   false,
          inputs: {
            projectName:         form.project_name,
            milestones:          form.milestones,
            timeline:            form.timeline,
            resources:           form.resources,
            budgetText:          form.budget_text,
            methodology:         form.methodology,
            usedHandoffPackage:  !!handoffFile,
            supportingFileCount: supportingFiles.length,
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

  // FIX: the backend now returns a PERMANENT Firebase download-token URL in
  // fileObj.url (https://firebasestorage.googleapis.com/...?alt=media&token=...).
  // That URL never expires and is fetchable directly — check it FIRST,
  // before falling back to the SDK getDownloadURL(path) call, which is only
  // needed for older runs that only have a storage path saved. Errors now
  // surface the real server response instead of a generic failure.
  // `ext` distinguishes the Backbone Plan (JSON) from the PDF outputs, both for
  // the content-type check below and for the saved file's extension.
  async function downloadDocument(docKey, fileObj, label, ext = "pdf") {
    if (!fileObj) return;

    setDownloadingKey(docKey);
    try {
      let downloadUrl = null;

      const storagePath = fileObj?.path;
      const urlField    = fileObj?.url;

      if (typeof urlField === "string" && urlField.startsWith("https://")) {
        // Permanent Firebase download-token URL — fetch directly.
        downloadUrl = urlField;
      } else if (typeof fileObj === "string" && fileObj.startsWith("https://")) {
        downloadUrl = fileObj;
      } else if (storagePath) {
        // Legacy: resolve via Firebase SDK using the storage path.
        const fileRef = ref(storage, storagePath);
        downloadUrl = await getDownloadURL(fileRef);
      } else {
        const fallbackPath = typeof fileObj === "string" ? fileObj : (urlField ?? fileObj?.name);
        if (!fallbackPath) throw new Error("No valid file reference found.");
        downloadUrl = `${BASE_URL}/download?path=${encodeURIComponent(fallbackPath)}`;
      }

      const res = await fetch(downloadUrl);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server returned ${res.status}: ${errText.slice(0, 300)}`);
      }

      const contentType   = res.headers.get("content-type") || "";
      const expectedHints = ext === "json" ? ["json"] : ["pdf", "octet-stream"];
      if (!expectedHints.some(hint => contentType.includes(hint))) {
        const errText = await res.text();
        throw new Error(`Expected a ${ext.toUpperCase()} but got "${contentType}". ${errText.slice(0, 200)}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = label.replace(' (Download)', '') + `.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
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

              {/* Goals & Scope Handoff Package */}
              <div className="pp-field-group">
                <label className="pp-label">
                  🔗 Goals & Scope Handoff Package
                  <span className="pp-file-size-hint"> (optional, .json from Agent 1 — Max {MAX_FILE_MB}MB)</span>
                </label>
                <div
                  className={`pp-upload-box ${isDraggingHandoff ? "pp-upload-box--drag" : ""} ${handoffError ? "pp-upload-box--error" : ""}`}
                  onDragOver={e => { e.preventDefault(); setIsDraggingHandoff(true); }}
                  onDragLeave={() => setIsDraggingHandoff(false)}
                  onDrop={handleDropHandoff}
                  onClick={() => document.getElementById("pp-handoff-input").click()}
                >
                  <input
                    id="pp-handoff-input"
                    type="file"
                    accept=".json"
                    onChange={e => validateAndSetHandoffFile(e.target.files[0])}
                    hidden
                  />
                  {handoffFile ? (
                    <p className="pp-upload-name">
                      📎 {handoffFile.name}
                      <span className="pp-upload-size"> ({(handoffFile.size / 1024 / 1024).toFixed(2)}MB)</span>
                    </p>
                  ) : (
                    <>
                      <div className="pp-upload-icon">↑</div>
                      <p className="pp-upload-text">Drop File Here<br/>- or -<br/>Click to Upload</p>
                    </>
                  )}
                </div>

                {handoffError && <p className="pp-file-error">❌ {handoffError}</p>}

                {handoffFile && !handoffError && (
                  <button type="button" className="pp-clear-file-btn" onClick={clearHandoffFile}>
                    ✕ Remove file
                  </button>
                )}
              </div>

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
                <label className="pp-label">Milestones (optional if handoff package provided - will be merged)</label>
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
                <label className="pp-label">Resource List (optional if handoff package provided - will be merged)</label>
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

              <div className="pp-field-group">
                <label className="pp-label">Budget / Financial Data (optional - paste directly)</label>
                <textarea
                  className="pp-textarea"
                  name="budget_text"
                  placeholder={
`e.g.
Anthropic API usage (Haiku): ~$15-30/mo est.
Dev time: $0 internal, sweat equity`}
                  value={form.budget_text}
                  onChange={handleChange}
                  rows={4}
                />
              </div>

              {/* Upload Supporting Documents - multi-file, any format */}
              <div className="pp-field-group">
                <label className="pp-label">
                  Upload Supporting Documents
                  <span className="pp-file-size-hint"> (optional, any format - budget, resources, timeline, etc. — Max {MAX_FILE_MB}MB each)</span>
                </label>
                <div
                  className={`pp-upload-box ${isDraggingSupport ? "pp-upload-box--drag" : ""} ${supportingError ? "pp-upload-box--error" : ""}`}
                  onDragOver={e => { e.preventDefault(); setIsDraggingSupport(true); }}
                  onDragLeave={() => setIsDraggingSupport(false)}
                  onDrop={handleDropSupporting}
                  onClick={() => document.getElementById("pp-supporting-input").click()}
                >
                  <input
                    id="pp-supporting-input"
                    type="file"
                    multiple
                    onChange={e => addSupportingFiles(e.target.files)}
                    hidden
                  />
                  <div className="pp-upload-icon">↑</div>
                  <p className="pp-upload-text">Drop File(s) Here<br/>- or -<br/>Click to Upload</p>
                </div>

                {supportingError && <p className="pp-file-error">❌ {supportingError}</p>}

                {supportingFiles.length > 0 && (
                  <ul className="pp-upload-file-list">
                    {supportingFiles.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="pp-upload-file-item">
                        <span className="pp-upload-name">
                          📎 {f.name}
                          <span className="pp-upload-size"> ({(f.size / 1024 / 1024).toFixed(2)}MB)</span>
                        </span>
                        <button
                          type="button"
                          className="pp-clear-file-btn"
                          onClick={() => removeSupportingFile(i)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                className="pp-generate-btn"
                onClick={handleGenerate}
                disabled={loading || !!handoffError || !!supportingError}
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

              {OUTPUT_DOCS.map(({ docKey, label, ext }) => (
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
                        onClick={() => downloadDocument(docKey, docs[docKey], label, ext)}
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