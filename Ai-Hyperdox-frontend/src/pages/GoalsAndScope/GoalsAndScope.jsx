import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db } from "../../firebase";
import { doc, getDoc } from "firebase/firestore";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import GoalsScopeIcon from '../../assets/Documenticon/GoalsscopeIcon.png';
import "./GoalsAndScope.css";

const BASE_URL = import.meta.env.VITE_API_URL;

// ── Load all icons from assets/projecticon ──
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
  if (/^https?:\/\//.test(iconValue) || iconValue.startsWith('/')) {
    return iconValue;
  }
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
  { docKey: "goals",      label: "Goals Document (Download)" },
  { docKey: "scope",      label: "Scope Document (Download)" },
  { docKey: "risk",       label: "Risk Document (Download)" },
  { docKey: "milestones", label: "Proposed Milestones Document (Download)" },
  { docKey: "resources",  label: "Resource Teams Required Document (Download)" },
];

export default function GoalsAndScope() {
  const { projectId }           = useParams();
  const { currentUser, logout } = useAuth();
  const navigate                = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [projectIcon, setProjectIcon] = useState(null);
  const [lastRunDate, setLastRunDate] = useState(null);
  const [fetching,    setFetching]    = useState(true);

  const [form, setForm] = useState({
    project_name: "",
    problem:      "",
    summary:      "",
    long_desc:    "",
  });
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isDragging,   setIsDragging]   = useState(false);
  const [status,       setStatus]       = useState("");
  const [docs,         setDocs]         = useState(null);
  const [loading,      setLoading]      = useState(false);

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
          if (data.lastGoalsScopeRun) setLastRunDate(data.lastGoalsScopeRun);
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

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) setUploadedFile(file);
  }

  async function handleGenerate() {
    if (!form.project_name.trim()) {
      setStatus("⚠ Please enter a project name.");
      return;
    }

    if (!BASE_URL) {
      setStatus("❌ API configuration error. BASE_URL is not set.");
      return;
    }

    setLoading(true);
    setStatus("Generating documents...");
    setDocs(null);

    try {
      const response = await fetch(`${BASE_URL}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            form.project_name,
            form.problem,
            form.summary,
            form.long_desc,
            null,
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      if (!result.data || !Array.isArray(result.data)) {
        throw new Error("Invalid response format from server.");
      }

      const [statusMsg, goals, scope, risk, milestones, resources] = result.data;

      setStatus(statusMsg);
      setDocs({ goals, scope, risk, milestones, resources });
    } catch (err) {
      setStatus(`❌ Error: ${err.message || "Connection failed. Please try again."}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function getDownloadUrl(fileObj) {
    if (!fileObj) return null;
    const fileName = typeof fileObj === "string" ? fileObj : fileObj.name;
    return `${BASE_URL}/file=${fileName}`;
  }

  return (
    <div className="ndr-root">

      {/* Sidebar */}
      <aside className="ndr-sidebar">
        <Link to="/" className="ndr-logo-wrap">
          <div className="ndr-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>

        <Link to="/dashboard" className="ndr-back-link">Back To Projects</Link>

        {!fetching && (
          <div className="ndr-project-section">
            <span className="ndr-project-label">{projectName}:</span>
            <Link to={`/project/${projectId}/edit`} className="ndr-project-link">Project Details</Link>
            <Link to={`/project/${projectId}/run`}  className="ndr-project-link ndr-project-link--active">New Document Run</Link>
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
          <div className="gs-topbar-inner">
            <h1 className="ndr-page-title">{projectName} Goals & Scope Document Run</h1>
            {projectIcon && (
              <img
                src={projectIcon}
                alt="Project"
                className="gs-project-icon"
                onError={e => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = logo;
                }}
              />
            )}
          </div>
        </header>

        <section className="ndr-content">

          {/* Icon + Last Run */}
          <div className="gs-run-header">
            <img src={GoalsScopeIcon} alt="Goals & Scope" className="gs-doc-icon" />
            <p className="gs-last-run">
              {lastRunDate
                ? <>Last Goals & Scope Run For <strong>{projectName}</strong> Was {lastRunDate}&nbsp;
                    <span className="gs-view-run">View Run</span>
                  </>
                : <>No previous Goals & Scope runs for <strong>{projectName}</strong></>
              }
            </p>
          </div>

          {/* Two columns */}
          <div className="gs-columns">

            {/* LEFT - Inputs */}
            <div className="gs-inputs">
              <div className="gs-field-group">
                <label className="gs-label">Project Name (short)</label>
                <input
                  className="gs-input"
                  name="project_name"
                  placeholder="e.g. Jocksalot Fan"
                  value={form.project_name}
                  onChange={handleChange}
                />
              </div>

              <div className="gs-field-group">
                <label className="gs-label">What Problem is Being Solved?</label>
                <textarea
                  className="gs-textarea"
                  name="problem"
                  value={form.problem}
                  onChange={handleChange}
                  rows={3}
                />
              </div>

              <div className="gs-field-group">
                <label className="gs-label">High-Level Summary (1-2 sentences)</label>
                <textarea
                  className="gs-textarea"
                  name="summary"
                  value={form.summary}
                  onChange={handleChange}
                  rows={2}
                />
              </div>

              <div className="gs-field-group">
                <label className="gs-label">Longer Description / Requirements</label>
                <textarea
                  className="gs-textarea"
                  name="long_desc"
                  value={form.long_desc}
                  onChange={handleChange}
                  rows={6}
                />
              </div>

              {/* Upload */}
              <div className="gs-field-group">
                <label className="gs-label">Upload Documents (PDF / DOCX / TXT)</label>
                <div
                  className={`gs-upload-box ${isDragging ? "gs-upload-box--drag" : ""}`}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById("gs-file-input").click()}
                >
                  <input
                    id="gs-file-input"
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={e => setUploadedFile(e.target.files[0])}
                    hidden
                  />
                  {uploadedFile ? (
                    <p className="gs-upload-name">📎 {uploadedFile.name}</p>
                  ) : (
                    <>
                      <div className="gs-upload-icon">↑</div>
                      <p className="gs-upload-text">Drop File Here<br/>- or -<br/>Click to Upload</p>
                    </>
                  )}
                </div>
              </div>

              <button
                className="gs-generate-btn"
                onClick={handleGenerate}
                disabled={loading}
              >
                {loading ? "Generating..." : "🚀 Generate Documents"}
              </button>
            </div>

            {/* RIGHT - Outputs */}
            <div className="gs-outputs">
              <div className="gs-field-group">
                <label className="gs-label">Status Message</label>
                <div className="gs-status-box">
                  {status && <p className="gs-status-text">{status}</p>}
                </div>
              </div>

              {OUTPUT_DOCS.map(({ docKey, label }) => (
                <div key={docKey} className="gs-field-group">
                  <label className="gs-label">📄 {label}</label>
                  <div className="gs-output-box">
                    {docs?.[docKey] ? (
                      <a
                        className="gs-download-link"
                        href={getDownloadUrl(docs[docKey])}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ⬇ Download
                      </a>
                    ) : (
                      <span className="gs-output-empty-icon">📄</span>
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