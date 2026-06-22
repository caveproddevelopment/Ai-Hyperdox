// src/pages/RunView/RunView.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, functions } from "../../firebase";
import { doc, getDoc, updateDoc, increment } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import logo            from "../../assets/AI Hyperdox Logo Square V2.png";
import GoalsScopeIcon  from "../../assets/Documenticon/GoalsscopeIcon.png";
import ExecutionIcon   from "../../assets/Documenticon/ExecutionIcon.png";
import ProjectPlanIcon from "../../assets/Documenticon/ProjectPlanIcon.png";
import "./RunView.css";

const BASE_URL       = import.meta.env.VITE_API_URL;
const MAX_FILE_MB    = 2;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

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

const DOC_TYPE_CONFIG = {
  "goals-scope": {
    outputDocs: [
      { key: "goals",      label: "Goals Document (Download)"                   },
      { key: "scope",      label: "Scope Document (Download)"                   },
      { key: "risk",       label: "Risk Document (Download)"                    },
      { key: "milestones", label: "Proposed Milestones Document (Download)"     },
      { key: "resources",  label: "Resource Teams Required Document (Download)" },
    ],
    buildPayload: (form) => ({
      data: [form.projectName, form.problem, form.summary, form.longDesc, []],
      api_name: "/generate_documents",
    }),
    parseResponse: (data) => {
      const [statusMsg, goals, scope, risk, milestones, resources] = data;
      return { statusMsg, docs: { goals, scope, risk, milestones, resources } };
    },
  },
  "execution": {
    outputDocs: [
      { key: "executionPlan", label: "Execution Plan Document (Download)" },
    ],
    buildPayload: (form) => ({
      data: [form.projectName, form.problem, form.summary, form.longDesc, []],
      api_name: "/generate_execution",
    }),
    parseResponse: (data) => {
      const [statusMsg, executionPlan] = data;
      return { statusMsg, docs: { executionPlan } };
    },
  },
  "project-plan": {
    outputDocs: [
      { key: "wbs",      label: "Work Breakdown Structure (Download)" },
      { key: "timeline", label: "Project Timeline (Download)"         },
      { key: "resource", label: "Resource Allocation Plan (Download)" },
      { key: "cost",     label: "Cost Management Plan (Download)"     },
    ],
    buildPayload: (form) => ({
      data: [
        form.projectName,
        form.methodology ?? "",
        form.milestones  ?? "",
        form.resources   ?? "",
        form.timeline    ?? "",
      ],
      api_name: "/generate_project_plan",
    }),
    parseResponse: (data) => {
      const [statusMsg, wbs, timeline, resource, cost] = data;
      return { statusMsg, docs: { wbs, timeline, resource, cost } };
    },
  },
};

// FIX: app.py now returns a PERMANENT Firebase download-token URL
// (https://firebasestorage.googleapis.com/...?alt=media&token=...) in the
// `url` field. That URL never expires and is fetchable directly — no Flask
// involved, no Railway dependency. Legacy branches are kept for runs that
// were generated before this fix (gs:// has no direct branch since it
// can't be fetch()'d from the browser at all).
function getDownloadUrl(fileObj) {
  if (!fileObj) return null;

  // ── Permanent Firebase URL (current format) ─────────────────────
  if (typeof fileObj === "string" && fileObj.startsWith("https://")) return fileObj;
  if (typeof fileObj?.url === "string" && fileObj.url.startsWith("https://")) return fileObj.url;

  // ── Legacy: plain string, /tmp path or other non-gs:// string ───
  // Only works if the same Railway session that generated it is still alive.
  if (typeof fileObj === "string" && !fileObj.startsWith("gs://"))
    return `${BASE_URL}/download?path=${encodeURIComponent(fileObj)}`;

  // ── Legacy: object with a /tmp-style path or name ────────────────
  const filePath = fileObj?.path ?? fileObj?.name;
  if (filePath && !filePath.startsWith("gs://"))
    return `${BASE_URL}/download?path=${encodeURIComponent(filePath)}`;

  // gs:// URI with no usable url/path → not directly downloadable here
  // (ProjectLibrary.jsx's ZIP download resolves these via the SDK instead).
  return null;
}

export default function RunView() {
  const { projectId, runId } = useParams();
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const [run,         setRun]         = useState(null);
  const [projectName, setProjectName] = useState("");
  const [loading,     setLoading]     = useState(true);

  const [form, setForm] = useState({
    projectName: "",
    problem:     "",
    summary:     "",
    longDesc:    "",
    methodology: "",
    milestones:  "",
    resources:   "",
    timeline:    "",
  });

  const [uploadedFile,   setUploadedFile]   = useState(null);
  const [fileError,      setFileError]      = useState("");
  const [isDragging,     setIsDragging]     = useState(false);
  const [status,         setStatus]         = useState("");
  const [docs,           setDocs]           = useState(null);
  const [generating,     setGenerating]     = useState(false);
  const [currentRunId,   setCurrentRunId]   = useState(null);
  const [downloadingKey, setDownloadingKey] = useState(null);

  useEffect(() => {
    if (!runId || !projectId || !currentUser) return;
    async function loadData() {
      try {
        const runSnap = await getDoc(doc(db, "runs", runId));
        if (!runSnap.exists()) { navigate(`/project/${projectId}/library`); return; }
        const runData = { id: runSnap.id, ...runSnap.data() };
        if (runData.userId !== currentUser.uid) { navigate("/dashboard"); return; }
        setRun(runData);
        setCurrentRunId(runData.id);

        if (runData.inputs) {
          setForm({
            projectName: runData.inputs.projectName ?? "",
            problem:     runData.inputs.problem     ?? "",
            summary:     runData.inputs.summary     ?? "",
            longDesc:    runData.inputs.longDesc    ?? "",
            methodology: runData.inputs.methodology ?? "",
            milestones:  runData.inputs.milestones  ?? "",
            resources:   runData.inputs.resources   ?? "",
            timeline:    runData.inputs.timeline    ?? "",
          });
        }

        if (runData.documents) setDocs(runData.documents);

        const projSnap = await getDoc(doc(db, "projects", projectId));
        if (projSnap.exists()) setProjectName(projSnap.data().name ?? "Project");
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [runId, projectId, currentUser, navigate]);

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function validateAndSetFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError(`File too large. Max ${MAX_FILE_MB}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`);
      setUploadedFile(null);
      const inp = document.getElementById("rv-file-input");
      if (inp) inp.value = "";
      return;
    }
    setFileError("");
    setUploadedFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    validateAndSetFile(e.dataTransfer.files[0]);
  }

  function formatDate(r) {
    if (r?.createdAt?.toDate)
      return r.createdAt.toDate().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    if (typeof r?.createdAt === "number")
      return new Date(r.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    return "—";
  }

  function buildInputsPayload() {
    if (run?.docType === "project-plan") {
      return {
        projectName: form.projectName,
        methodology: form.methodology,
        milestones:  form.milestones,
        resources:   form.resources,
        timeline:    form.timeline,
      };
    }
    return {
      projectName: form.projectName,
      problem:     form.problem,
      summary:     form.summary,
      longDesc:    form.longDesc,
    };
  }

  // FIX: surface the real server error instead of a generic "Download
  // failed" message, and reject non-PDF responses (e.g. an HTML error page
  // from an expired legacy /download link) before treating them as a file.
  async function handleDownload(url, label, key) {
    setDownloadingKey(key);
    try {
      const res = await fetch(url);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server returned ${res.status}: ${errText.slice(0, 300)}`);
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
        const errText = await res.text();
        throw new Error(`Expected a PDF but got "${contentType}". ${errText.slice(0, 200)}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = label.replace(' (Download)', '') + '.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      setStatus(`Download failed: ${err.message}`);
      console.error("Download error:", err);
    } finally {
      setDownloadingKey(null);
    }
  }

  async function handleGenerate() {
    if (!form.projectName.trim()) { setStatus("Please enter a project name."); return; }
    if (!BASE_URL)                { setStatus("API configuration error."); return; }
    if (fileError)                { setStatus("Please remove the invalid file before generating."); return; }

    const config = DOC_TYPE_CONFIG[run?.docType];
    if (!config) { setStatus("Unknown document type."); return; }

    setGenerating(true);
    setDocs(null);

    let activeRunId = currentRunId;
    try {
      setStatus("Checking billing...");
      const initiateRun   = httpsCallable(functions, "initiateRun");
      const billingResult = await initiateRun({
        projectId,
        docType:       run.docType,
        existingRunId: currentRunId ?? null,
      });
      activeRunId = billingResult.data.runId ?? activeRunId;
      setCurrentRunId(activeRunId);

      setStatus(
        billingResult.data.status === "free"
          ? `Free run used. ${billingResult.data.freeRunsRemaining} free run(s) remaining. Generating…`
          : "$10 charged successfully. Generating…"
      );
    } catch (err) {
      setStatus(`Billing error: ${err.message}`);
      setGenerating(false);
      return;
    }

    try {
      const response = await fetch(`${BASE_URL}/api/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(config.buildPayload(form)),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const result = await response.json();
      if (!result.data || !Array.isArray(result.data))
        throw new Error("Invalid response format from server.");

      const { statusMsg, docs: newDocs } = config.parseResponse(result.data);
      setStatus(statusMsg);
      setDocs(newDocs);

      const runDate = new Date().toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      });

      await updateDoc(doc(db, "projects", projectId), {
        lastGoalsScopeRun: runDate,
        runCount: increment(1),
      });

      if (activeRunId) {
        await updateDoc(doc(db, "runs", activeRunId), {
          documents:   newDocs,
          completedAt: Date.now(),
          projectName: form.projectName,
          inputs:      buildInputsPayload(),
        });
      }
    } catch (err) {
      setStatus(`Error: ${err.message || "Connection failed. Please try again."}`);
      console.error(err);
    } finally {
      setGenerating(false);
    }
  }

  const meta       = run ? (DOC_TYPE_META[run.docType]   ?? { label: run.docType, icon: GoalsScopeIcon }) : null;
  const config     = run ? (DOC_TYPE_CONFIG[run.docType] ?? null) : null;
  const outputDocs = config?.outputDocs ?? [];
  const isProjectPlan = run?.docType === "project-plan";

  return (
    <div className="rv-root">

      {/* ── Sidebar ── */}
      <aside className="rv-sidebar">
        <Link to="/dashboard" className="rv-logo-wrap">
          <img src={logo} alt="AI Hyperdox" className="rv-logo" />
        </Link>

        <Link to="/dashboard" className="rv-back-link">Back To Projects</Link>

        {projectName && (
          <div className="rv-project-section">
            <span className="rv-project-label">{projectName}:</span>
            <Link to={`/project/${projectId}/edit`}    className="rv-project-link">Project Details</Link>
            <Link to={`/project/${projectId}/library`} className="rv-project-link rv-project-link--active">Project Library</Link>
            <Link to={`/project/${projectId}/run`}     className="rv-project-link">New Document Run</Link>
          </div>
        )}

        <nav className="rv-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="rv-nav-link">{label}</Link>
          ))}
        </nav>

        <div className="rv-sidebar-footer">
          <button className="rv-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="rv-main">
        {loading ? (
          <div className="rv-loading">Loading run…</div>
        ) : !run ? (
          <div className="rv-loading">Run not found.</div>
        ) : (
          <>
            <header className="rv-topbar">
              <h1 className="rv-title">{projectName} {meta.label} Document Run</h1>
            </header>

            <section className="rv-content">

              <div className="rv-run-header">
                <img src={meta.icon} alt={meta.label} className="rv-doc-icon" />
                <p className="rv-last-run">
                  Last {meta.label} Run For <strong>{projectName}</strong> Was {formatDate(run)}&nbsp;
                  <Link to={`/project/${projectId}/library`} className="rv-view-run-link">View Library</Link>
                </p>
              </div>

              <div className="rv-columns">

                {/* ── LEFT: Inputs ── */}
                <div className="rv-inputs">

                  <div className="rv-field-group">
                    <label className="rv-label">Project Name (short)</label>
                    <input
                      className="rv-input"
                      name="projectName"
                      placeholder="e.g. My Project"
                      value={form.projectName}
                      onChange={handleChange}
                    />
                  </div>

                  {/* ── Project Plan fields ── */}
                  {isProjectPlan ? (
                    <>
                      <div className="rv-field-group">
                        <label className="rv-label">Methodology</label>
                        <input
                          className="rv-input"
                          name="methodology"
                          placeholder="e.g. Agile, Waterfall, Scrum"
                          value={form.methodology}
                          onChange={handleChange}
                        />
                      </div>

                      <div className="rv-field-group">
                        <label className="rv-label">Milestones</label>
                        <textarea
                          className="rv-textarea"
                          name="milestones"
                          placeholder="e.g. M1 - Design complete, M2 - Dev complete"
                          value={form.milestones}
                          onChange={handleChange}
                          rows={3}
                        />
                      </div>

                      <div className="rv-field-group">
                        <label className="rv-label">Resources</label>
                        <textarea
                          className="rv-textarea"
                          name="resources"
                          placeholder="e.g. 2 developers, 1 designer"
                          value={form.resources}
                          onChange={handleChange}
                          rows={2}
                        />
                      </div>

                      <div className="rv-field-group">
                        <label className="rv-label">Timeline</label>
                        <textarea
                          className="rv-textarea"
                          name="timeline"
                          placeholder="e.g. 3 months, Q3 2026"
                          value={form.timeline}
                          onChange={handleChange}
                          rows={2}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rv-field-group">
                        <label className="rv-label">What Problem is Being Solved?</label>
                        <textarea
                          className="rv-textarea"
                          name="problem"
                          value={form.problem}
                          onChange={handleChange}
                          rows={3}
                        />
                      </div>

                      <div className="rv-field-group">
                        <label className="rv-label">High-Level Summary (1–2 sentences)</label>
                        <textarea
                          className="rv-textarea"
                          name="summary"
                          value={form.summary}
                          onChange={handleChange}
                          rows={2}
                        />
                      </div>

                      <div className="rv-field-group">
                        <label className="rv-label">Longer Description / Requirements</label>
                        <textarea
                          className="rv-textarea"
                          name="longDesc"
                          value={form.longDesc}
                          onChange={handleChange}
                          rows={6}
                        />
                      </div>
                    </>
                  )}

                  {/* ── File upload ── */}
                  <div className="rv-field-group">
                    <label className="rv-label">
                      Upload Documents (PDF / DOCX / TXT)
                      <span className="rv-file-hint"> — Max {MAX_FILE_MB}MB</span>
                    </label>
                    <div
                      className={`rv-upload-box${isDragging ? " rv-upload-box--drag" : ""}${fileError ? " rv-upload-box--error" : ""}`}
                      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => document.getElementById("rv-file-input").click()}
                    >
                      <input
                        id="rv-file-input"
                        type="file"
                        accept=".pdf,.docx,.txt"
                        onChange={e => validateAndSetFile(e.target.files[0])}
                        hidden
                      />
                      {uploadedFile ? (
                        <p className="rv-upload-name">
                          📎 {uploadedFile.name}
                          <span className="rv-upload-size"> ({(uploadedFile.size / 1024 / 1024).toFixed(2)}MB)</span>
                        </p>
                      ) : (
                        <>
                          <div className="rv-upload-icon">↑</div>
                          <p className="rv-upload-text">Drop File Here<br/>— or —<br/>Click to Upload</p>
                        </>
                      )}
                    </div>

                    {fileError && <p className="rv-file-error">❌ {fileError}</p>}

                    {uploadedFile && !fileError && (
                      <button
                        type="button"
                        className="rv-clear-file-btn"
                        onClick={e => {
                          e.stopPropagation();
                          setUploadedFile(null);
                          setFileError("");
                          const inp = document.getElementById("rv-file-input");
                          if (inp) inp.value = "";
                        }}
                      >
                        ✕ Remove file
                      </button>
                    )}
                  </div>

                  <button
                    className="rv-generate-btn"
                    onClick={handleGenerate}
                    disabled={generating || !!fileError}
                  >
                    {generating ? "Generating…" : "🚀 Generate Documents"}
                  </button>
                </div>

                {/* ── RIGHT: Status + Downloads ── */}
                <div className="rv-outputs">

                  <div className="rv-field-group">
                    <label className="rv-label">Status Message</label>
                    <div className="rv-status-box">
                      {status && <p className="rv-status-text">{status}</p>}
                    </div>
                  </div>

                  {outputDocs.map(({ key, label }) => {
                    const url = getDownloadUrl(docs?.[key]);
                    return (
                      <div key={key} className="rv-field-group">
                        <label className="rv-label">📄 {label}</label>
                        <div className="rv-output-box">
                          {generating ? (
                            <div className="rv-generating">
                              <span className="rv-spinner" />
                              <span className="rv-generating-text">Generating...</span>
                            </div>
                          ) : url ? (
                            <button
                              type="button"
                              className="rv-download-link"
                              onClick={() => handleDownload(url, label, key)}
                              disabled={downloadingKey === key}
                            >
                              {downloadingKey === key ? "Preparing..." : "⬇ Download"}
                            </button>
                          ) : (
                            <span className="rv-output-empty-icon">📄</span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Run meta */}
                  <div className="rv-meta-strip">
                    <span className={`rv-status-badge rv-status-badge--${run.status}`}>
                      {run.status === "free" ? "Free Run" : "Paid ($10)"}
                    </span>
                    <span className="rv-meta-id">ID: {run.id}</span>
                  </div>

                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}