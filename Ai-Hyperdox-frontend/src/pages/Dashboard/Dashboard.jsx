// src/pages/Dashboard/Dashboard.jsx
import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, storage } from "../../firebase"; // make sure `storage` is exported from firebase.js
import {
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  doc,
  deleteDoc,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import { ref as storageRef, deleteObject } from "firebase/storage";
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import "./Dashboard.css";

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
  return PROJECT_ICONS.find(i => i.name === iconName)?.url ?? "";
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day:   "numeric",
    year:  "numeric",
  });
}

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

// ── Deletes every run + generated file belonging to a project, then the project itself ──
async function deleteProjectAndDocuments(projectId) {
  // 1. Find every run tied to this project.
  const runsQuery = query(collection(db, "runs"), where("projectId", "==", projectId));
  const runsSnap = await getDocs(runsQuery);

  // 2. For each run, delete every generated PDF referenced in its `documents` map.
  //    Keys vary by docType (goals/milestones/resources/risk/scope vs cost/resource/timeline/wbs),
  //    so we iterate values rather than hardcoding key names.
  await Promise.all(
    runsSnap.docs.map(async (runDoc) => {
      const documentsMap = runDoc.data().documents || {};
      const fileEntries = Object.values(documentsMap); // [{path, url}, ...]

      await Promise.all(
        fileEntries.map(async (entry) => {
          if (!entry?.url) return;
          try {
            await deleteObject(storageRef(storage, entry.url)); // entry.url is a full gs:// URI
          } catch (err) {
            console.warn(`Could not delete storage file ${entry.path}:`, err);
          }
        })
      );
    })
  );

  // 3. Batch-delete the run documents themselves (Firestore batches cap at 500 ops,
  //    so chunk if a project could ever have more than that many runs).
  const batch = writeBatch(db);
  runsSnap.docs.forEach((runDoc) => batch.delete(runDoc.ref));
  await batch.commit();

  // 4. Finally, delete the project document.
  await deleteDoc(doc(db, "projects", projectId));
}

// ── Create New Project card ──────────────────────────────────────
function CreateCard({ onClick }) {
  return (
    <button className="dash-create-card" onClick={onClick} type="button">
      <span className="dash-create-icon">+</span>
      <span className="dash-create-label">Create<br />New<br />Project</span>
    </button>
  );
}

// ── Project Card ─────────────────────────────────────────────────
function ProjectCard({ project, onDeleteClick }) {
  const iconUrl = resolveIcon(project.icon);

  return (
    <div className="dash-project-card">
      <div className="dash-project-thumb">
        {iconUrl
          ? <img src={iconUrl} alt={project.name} />
          : <div className="dash-project-thumb-placeholder" />
        }
      </div>
      <h3 className="dash-project-name">{project.name}</h3>
      <p className="dash-project-date">Created {formatDate(project.createdAt)}</p>
      <div className="dash-project-links">
        <Link to={`/project/${project.id}/edit`} className="dash-proj-link">
          Edit Details
        </Link>
        {project.runCount > 0 && (
          <Link to={`/project/${project.id}/library`} className="dash-proj-link">
            See Project Library
          </Link>
        )}
        <Link to={`/project/${project.id}/run`} className="dash-proj-link">
          New Document Run
        </Link>
        <button
          type="button"
          className="dash-proj-link dash-proj-link-delete"
          onClick={() => onDeleteClick(project)}
        >
          Delete Project
        </button>
      </div>
    </div>
  );
}

// ── Simple confirm/result modal ──────────────────────────────────
function Modal({ children }) {
  return (
    <div className="dash-modal-overlay">
      <div className="dash-modal-box">
        {children}
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────
export default function Dashboard() {
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();

  const [profileOpen,     setProfileOpen]     = useState(false);
  const [projects,        setProjects]        = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  // ── Delete flow state ──
  const [deleteTarget, setDeleteTarget] = useState(null);   // project pending confirmation
  const [deleting,      setDeleting]      = useState(false); // in-progress flag
  const [deleteError,   setDeleteError]   = useState("");
  const [deletedName,   setDeletedName]   = useState(null);  // set after success, drives success modal

  const initials = getInitials(currentUser);

  // ── Fetch projects in real-time ──
  useEffect(() => {
    if (!currentUser) return;

    const q = query(
      collection(db, "projects"),
      where("ownerId", "==", currentUser.uid),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setProjects(data);
      setLoadingProjects(false);
    }, (err) => {
      console.error("Error fetching projects:", err);
      setLoadingProjects(false);
    });

    return () => unsubscribe();
  }, [currentUser]);

  async function handleLogout() {
    try { await logout(); navigate("/signin"); } catch {}
  }

  function handleCreateProject() {
    navigate("/project/new");
  }

  function handleDeleteClick(project) {
    setDeleteError("");
    setDeleteTarget(project);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProjectAndDocuments(deleteTarget.id);
      setDeletedName(deleteTarget.name);
      setDeleteTarget(null);
    } catch (err) {
      console.error("Error deleting project:", err);
      setDeleteError("Something went wrong while deleting. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="dash-root">

      {/* ── Left Sidebar ── */}
      <aside className="dash-sidebar">
        <Link to="/dashboard" className="dash-logo-wrap">
          <div className="dash-logo-icon">
            <img src={logo} alt="AI Hyperdox" />
          </div>
        </Link>
        <nav className="dash-nav">
          {NAV_LINKS.map(({ label, to }) => (
            <Link key={to} to={to} className="dash-nav-link">{label}</Link>
          ))}
        </nav>
        <div className="dash-sidebar-footer">
          <button className="dash-signout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className="dash-main">

        {/* Top bar */}
        <header className="dash-topbar">
          <h1 className="dash-page-title">Your Projects</h1>

          <div className="dash-profile-wrap">
            <button
              className="dash-avatar"
              onClick={() => setProfileOpen((v) => !v)}
              title="Profile"
              type="button"
            >
              {initials}
            </button>

            {profileOpen && (
              <div className="dash-profile-dropdown">
                <div className="dash-profile-info">
                  <span className="dash-profile-name">
                    {currentUser?.displayName || currentUser?.email || "User"}
                  </span>
                  <span className="dash-profile-email">{currentUser?.email}</span>
                </div>
                <hr className="dash-dropdown-divider" />
                <Link to="/profile" className="dash-dropdown-item"
                  onClick={() => setProfileOpen(false)}>
                  View Profile
                </Link>
                <Link to="/settings" className="dash-dropdown-item"
                  onClick={() => setProfileOpen(false)}>
                  Settings
                </Link>
                <button className="dash-dropdown-item dash-dropdown-logout"
                  onClick={handleLogout}>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Projects grid */}
        <section className="dash-projects-grid">
          <CreateCard onClick={handleCreateProject} />

          {loadingProjects
            ? <p style={{ color: "#888", fontSize: "0.85rem" }}>Loading projects...</p>
            : projects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onDeleteClick={handleDeleteClick}
                />
              ))
          }
        </section>

      </main>

      {/* ── Pre-delete confirmation ── */}
      {deleteTarget && (
        <Modal>
          <h3 className="dash-modal-title">Delete "{deleteTarget.name}"?</h3>
          <p className="dash-modal-body">
            This will permanently delete this project and every document inside it.
            This action cannot be undone.
          </p>
          {deleteError && (
            <p className="dash-modal-error">{deleteError}</p>
          )}
          <div className="dash-modal-actions">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="dash-modal-btn dash-modal-btn-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deleting}
              className="dash-modal-btn dash-modal-btn-danger"
            >
              {deleting ? "Deleting…" : "Delete Permanently"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Post-delete confirmation ── */}
      {deletedName && (
        <Modal>
          <h3 className="dash-modal-title">Project Deleted</h3>
          <p className="dash-modal-body">
            "{deletedName}" and all of its documents have been permanently deleted.
          </p>
          <div className="dash-modal-actions dash-modal-actions-end">
            <button
              type="button"
              onClick={() => setDeletedName(null)}
              className="dash-modal-btn dash-modal-btn-primary"
            >
              OK
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}