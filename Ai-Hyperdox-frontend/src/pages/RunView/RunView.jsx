// src/pages/RunView/RunView.jsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, functions } from "../../firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";
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
      { key: "projectPlan", label: "Project Plan Document (Download)" },
    ],
    buildPayload: (form) => ({
      data: [form.projectName, form.problem, form.summary, form.longDesc, []],
      api_name: "/generate_project_plan",
    }),
    parseResponse: (data) => {
      const [statusMsg, projectPlan] = data;
      return { statusMsg, docs: { projectPlan } };
    },
  },
};

function getDownloadUrl(fileObj) {
  if (!fileObj) return null;
  if (typeof fileObj === "string" && fileObj.startsWith("http")) return fileObj;
  if (typeof fileObj === "string")
    return `${BASE_URL}/download?path=${encodeURIComponent(fileObj)}`;
  const filePath = fileObj?.path ?? fileObj?.url ?? fileObj?.name;
  if (!filePath) return null;
  return `${BASE_URL}/download?path=${encodeURIComponent(filePath)}`;
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
  });

  const [uploadedFile, setUploadedFile] = useState(null);
  const [fileError,    setFileError]    = useState("");
  const [isDragging,   setIsDragging]   = useState(false);

  const [status,       setStatus]       = useState("");
  const [docs,         setDocs]         = useState(null);
  const [generating,   setGenerating]   = useState(false);
  const [currentRunId, setCurrentRunId] = useState(null);

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
            longDesc:    runData.inputs.longDesc     ?? "",
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
      await updateDoc(doc(db, "projects", projectId), { lastGoalsScopeRun: runDate });

      if (activeRunId) {
        await updateDoc(doc(db, "runs", activeRunId), {
          documents:   newDocs,
          completedAt: Date.now(),
          projectName: form.projectName,
          inputs: {
            projectName: form.projectName,
            problem:     form.problem,
            summary:     form.summary,
            longDesc:    form.longDesc,
          },
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

  return (
    <div className="rv-root">

      {/* ── Sidebar ── */}
      <aside className="rv-sidebar">
        <Link to="/" className="rv-logo-wrap">
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

                  {/* File upload */}
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
                            <a className="rv-download-link" href={url} target="_blank" rel="noreferrer">
                              ⬇ Download
                            </a>
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