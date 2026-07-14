"""
AIPM - Planning Agent (v2.0)
Agent 2 of the AI Hyperdox pipeline: Goals & Scope -> Planning -> Execution.

WHAT CHANGED FROM v1.0 (and why):

1. REAL SYSTEM PROMPT, not a one-line placeholder (see agent.prompt.md for the
   authored persona - that content is what's actually sent to the model now).

2. INGESTS THE GOALS & SCOPE HANDOFF PACKAGE.
   v1.0 expected the user to manually retype milestones/resources into text boxes
   after reading a PDF from Agent 1. This version accepts the handoff JSON produced
   by the Goals & Scope agent directly, so the pipeline actually chains: what Agent 1
   decided about scope, risks, and milestones is available context for the WBS,
   timeline, and resourcing here - not just whatever the user manually retypes.
   Manual fields are still available and are treated as overrides/additions.

3. ONE STRUCTURED JSON CALL instead of 4 isolated ones, for the same reasons as
   Agent 1: coherence (Resource Allocation can reference actual WBS task IDs, the
   Timeline can reference actual WBS phases) plus speed and cost.

4. ANTI-GENERICISM GUARDRAILS + open_questions, mirroring Agent 1's approach so the
   whole pipeline behaves consistently: missing/vague input gets flagged, not papered
   over with invented dates, names, or costs.

5. PRODUCES ITS OWN HANDOFF PACKAGE ("Backbone Plan" JSON) - this is the artifact the
   Execution agent (Agent 3, not yet built) is designed to consume, per the blueprint.

6. PRODUCTION HARDENING: session-safe file naming, retries with backoff, input
   truncation, temperature tuned down, and errors surfaced instead of raised.

7. FIREBASE STORAGE OUTPUT LAYER RESTORED (merged back in from v1.0).
   v2.0 as received was a bare Gradio app writing to /tmp only - it had dropped the
   Flask REST API, CORS, and Firebase Storage upload layer that the frontend
   (aihyperdox.com) depends on. That layer is restored here unchanged from v1.0's
   behavior, including v1.0's origin-restricted CORS policy: every generated file
   (PDFs + the new "Backbone Plan" JSON handoff) is uploaded to Firebase Storage and
   returned as a permanent, token-authenticated download URL, so documents survive
   server restarts/redeploys and the frontend keeps working exactly as it did before
   this version bump. See upload_to_storage() for details.

NOTE ON MIGRATION: the only OpenAI-specific code lives in call_llm() - identical
shape to Agent 1's, so both can be swapped to Anthropic in the same pass later.
"""

import json
import os
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO

import docx
import gradio as gr
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from openai import OpenAI
from PyPDF2 import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, ListFlowable, ListItem,
)

try:
    import openpyxl
    XLSX_AVAILABLE = True
except ImportError:
    XLSX_AVAILABLE = False

# ── Firebase Admin ──────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, storage as fb_storage

_firebase_ready = False


def init_firebase():
    global _firebase_ready
    if _firebase_ready:
        return True
    try:
        sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")   # full JSON string
        bucket  = os.getenv("FIREBASE_STORAGE_BUCKET")    # e.g. your-project.appspot.com
        if not sa_json or not bucket:
            print("⚠ Firebase env vars not set — files will use /tmp fallback.")
            return False
        cred = credentials.Certificate(json.loads(sa_json))
        firebase_admin.initialize_app(cred, {"storageBucket": bucket})
        _firebase_ready = True
        print("✅ Firebase Admin initialised.")
        return True
    except Exception as e:
        print(f"⚠ Firebase init failed: {e}")
        return False


def upload_to_storage(local_path: str, project_name: str, doc_title: str, content_type: str = "application/pdf"):
    """
    Upload a local file (PDF or the Backbone Plan JSON handoff) to Firebase Storage
    and return a PERMANENT, browser-fetchable download URL.

    Unchanged from v1.0: a gs:// URI can only be resolved by the Firebase SDK
    (getBytes()/getDownloadURL()), not a plain fetch()/<a href> in the frontend.
    Signed URLs were also considered but expire after 7 days. The fix is a Firebase
    Storage download token attached to the blob's metadata, producing a URL of the
    form:
      https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
    This URL never expires, works with uniform bucket-level access (no ACL changes
    needed), and is fetchable directly from the browser.

    Returns (permanent_url, storage_path). Falls back to (local_path, None) if
    Firebase isn't configured (so /download keeps working for that session only).
    """
    if not init_firebase():
        return local_path, None

    try:
        filename    = os.path.basename(local_path)
        destination = f"generated-docs/{(project_name or 'project').replace(' ', '_')}/{uuid.uuid4().hex}_{filename}"

        bucket_obj = fb_storage.bucket()
        blob       = bucket_obj.blob(destination)
        blob.upload_from_filename(local_path, content_type=content_type)

        # Attach a Firebase download token → permanent, browser-accessible URL —
        # works fine even with uniform bucket-level access enabled.
        download_token = str(uuid.uuid4())
        blob.metadata  = {"firebaseStorageDownloadTokens": download_token}
        blob.patch()  # persist the metadata so the token URL resolves

        encoded_path  = urllib.parse.quote(destination, safe="")
        permanent_url = (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket_obj.name}/o/{encoded_path}"
            f"?alt=media&token={download_token}"
        )

        print(f"✅ Uploaded {filename} → permanent URL generated")
        return permanent_url, destination   # ← real https:// URL + storage path

    except Exception as e:
        print(f"⚠ Upload failed for {local_path}: {e}")
        return local_path, None


# ── App setup ───────────────────────────────────────────────────
app = Flask(__name__)

# ── CORS fix: explicitly allow all frontend origins ─────────────
CORS(app, resources={r"/api/*": {
    "origins": [
        "https://aihyperdox.com",
        "https://ai-hyperdox.vercel.app",
        "http://localhost:5173",
    ],
    "methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["Content-Type", "Authorization"],
    "supports_credentials": False,
}})


# ── Health server (port 8081) ───────────────────────────────────
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, format, *args):
        pass

threading.Thread(target=lambda: HTTPServer(("0.0.0.0", 8081), HealthHandler).serve_forever(), daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

MODEL = "gpt-4o"
TEMPERATURE = 0.3
MAX_TOKENS = 4096
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 2

MAX_FIELD_CHARS = 4000
MAX_UPLOAD_CHARS = 6000
MAX_HANDOFF_CHARS = 6000

RUN_DIR = "/tmp/aipm_runs"
os.makedirs(RUN_DIR, exist_ok=True)

AGENT_VERSION = "2.0"

# ─────────────────────────────────────────────────────────────────────────────
# System prompt
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are AIPM, an AI project-management advisor built from Monte Turner's
"Be an AI PM" series (Caveman Productions Media). You are the PLANNING agent - the second
of a 3-agent pipeline (Goals & Scope -> Planning -> Execution). You take the governed scope
from the Goals & Scope agent (when provided) plus the user's planning inputs, and produce an
executable plan. Your output is consumed downstream by the Execution agent, so structure and
traceability matter as much as the plan itself.

Your posture is senior enterprise PM: skeptical of vague input, allergic to filler language,
precise about what is knowable versus assumed.

HARD RULES - violating these defeats the purpose of this agent:

1. GROUNDING. Every task, date, resource, and cost figure must trace to something actually
   provided - either the Goals & Scope handoff (if present) or the user's manual planning
   inputs. Never invent team member names, dollar figures, or durations that were not given
   to you or that cannot be reasonably derived from what was given.

2. NO PLACEHOLDER FILLER. If information needed for a section is missing or vague, do not
   invent plausible-sounding filler ("Team A", "TBD", generic 2-week estimates with no
   basis). Instead:
   - Add a specific entry to `open_questions` describing exactly what's missing and why
     it blocks a real answer.
   - Mark the affected field as unresolved, e.g. "start_date": "UNSPECIFIED - see open
     questions", rather than guessing.

3. CROSS-REFERENCING IS MANDATORY.
   - Every row in the Project Timeline must reference a real "wbs_id" from the WBS you
     just generated.
   - Every row in the Resource Allocation Plan must reference a real "wbs_id" or phase
     name from the WBS/timeline, not float independently.
   - The Cost Management Plan's cost baseline categories should map to actual WBS phases,
     not a generic cost-category template.
   - If a Goals & Scope handoff was provided, milestones/risks from it should visibly
     shape the WBS and Timeline (e.g. milestone target dates should show up as phase-gate
     or sprint-end dates), not be ignored in favor of a fresh generic plan.

4. BE CRITICAL. If the stated timeline is unrealistic given the resource list or budget,
   or if a Goals & Scope risk was flagged and nothing in the plan addresses it, say so in
   an open question rather than silently proceeding.

5. SPECIFICITY OVER POLISH. A WBS task like "Anshika: rough-in Episode 1 backgrounds,
   Scenes 1-4, due Jun 25" is correct. A task like "Design team completes visual assets" is
   the generic failure mode to avoid.

6. OUTPUT FORMAT. Respond with ONLY a single valid JSON object matching the schema given
   in the user message. No prose before or after. No markdown code fences.
"""

JSON_SCHEMA_INSTRUCTIONS = """Return a single JSON object with exactly this shape:

{
  "wbs": [
    {"wbs_id": str, "task_name": str, "description": str, "owner": str,
     "est_duration": str, "dependencies": str, "phase_or_epic": str}
  ],
  "timeline": {
    "gantt_summary": str,
    "rows": [
      {"phase_or_sprint": str, "wbs_id": str, "task": str, "start_date": str,
       "end_date": str, "duration": str, "milestone": str, "owner": str, "status": str}
    ]
  },
  "resource_allocation": {
    "rows": [
      {"resource_name_or_role": str, "type": "Human|Tool|Budget", "wbs_id_or_phase": str,
       "allocation_pct": number, "est_hours": number, "cost_rate": str, "notes": str}
    ],
    "utilization_summary": str,
    "overallocation_warnings": [str]
  },
  "cost_plan": {
    "cost_baseline": [
      {"category": str, "wbs_id_or_phase": str, "est_cost": str, "actual": str, "variance": str}
    ],
    "estimation_method": str,
    "contingency_pct": str,
    "control_thresholds": str,
    "reporting_cadence": str,
    "performance_metrics": str
  },
  "open_questions": [str]
}

Rules for this JSON:
- "timeline.rows[].wbs_id" and "resource_allocation.rows[].wbs_id_or_phase" must reference
  real IDs/phases from the "wbs" array you generate in this same response.
- "wbs[].wbs_id" should follow the pattern "1.0", "1.1", "1.1.1" (Waterfall) or
  "EPIC-1", "STORY-1.1" (Agile), matching whichever methodology was specified.
- If you have nothing genuine for open_questions, return an empty array.
"""

# ─────────────────────────────────────────────────────────────────────────────
# File extraction
# ─────────────────────────────────────────────────────────────────────────────

def extract_text_from_file(uploaded_file):
    name = getattr(uploaded_file, "name", "uploaded_file").lower()
    try:
        with open(uploaded_file, "rb") as f:
            data = f.read()
    except Exception:
        data = b""

    text = ""
    try:
        if name.endswith(".pdf"):
            reader = PdfReader(BytesIO(data))
            for page in reader.pages:
                text += page.extract_text() or ""
        elif name.endswith(".docx"):
            doc = docx.Document(BytesIO(data))
            for p in doc.paragraphs:
                text += p.text + "\n"
        elif name.endswith((".txt", ".csv")):
            text = data.decode("utf-8", errors="ignore")
        elif name.endswith((".xlsx", ".xls")):
            if XLSX_AVAILABLE:
                wb = openpyxl.load_workbook(BytesIO(data), data_only=True)
                for sheet in wb.worksheets:
                    text += f"\n[Sheet: {sheet.title}]\n"
                    for row in sheet.iter_rows(values_only=True):
                        row_text = "\t".join(str(c) if c is not None else "" for c in row)
                        if row_text.strip():
                            text += row_text + "\n"
            else:
                text = "(openpyxl not installed - cannot read Excel file)"
        else:
            text = f"(Unsupported file type: {name})"
    except Exception as e:
        text = f"(Error reading {name}: {e})"
    return text.strip()


def extract_handoff_json(uploaded_file):
    """Reads a Goals & Scope handoff .json file. Returns dict or None."""
    if uploaded_file is None:
        return None, None
    try:
        path = uploaded_file if isinstance(uploaded_file, str) else getattr(uploaded_file, "name", None)
        with open(path, "r") as f:
            raw = f.read()
        data = json.loads(raw)
        if data.get("handoff_type") != "goals_and_scope_output":
            return None, "⚠ Uploaded file doesn't look like a Goals & Scope handoff package - ignoring it."
        return data, None
    except Exception as e:
        return None, f"⚠ Could not read handoff file: {e}"


def truncate(text, limit):
    if text is None:
        return ""
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated at {limit} chars]"


# ─────────────────────────────────────────────────────────────────────────────
# LLM call
# ─────────────────────────────────────────────────────────────────────────────

def call_llm(system_msg, user_prompt):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY is not set. Go to Space Settings -> Repository Secrets "
            "and add OPENAI_API_KEY."
        )
    client = OpenAI(api_key=api_key)

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            completion = client.chat.completions.create(
                model=MODEL,
                temperature=TEMPERATURE,
                max_tokens=MAX_TOKENS,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_prompt},
                ],
            )
            raw = completion.choices[0].message.content
            return json.loads(raw)
        except json.JSONDecodeError as e:
            last_error = f"Model returned invalid JSON on attempt {attempt}: {e}"
        except Exception as e:
            last_error = f"API error on attempt {attempt}: {e}"
        if attempt < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"LLM call failed after {MAX_RETRIES} attempts. Last error: {last_error}")


# ─────────────────────────────────────────────────────────────────────────────
# PDF rendering
# ─────────────────────────────────────────────────────────────────────────────

def _styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("AIPMTitle", parent=styles["Title"],
                               textColor=colors.HexColor("#1a3c6e"), fontSize=18))
    styles.add(ParagraphStyle("AIPMH2", parent=styles["Heading2"],
                               textColor=colors.HexColor("#2563eb"), fontSize=13,
                               spaceBefore=10, spaceAfter=6))
    styles.add(ParagraphStyle("AIPMCell", parent=styles["Normal"], fontSize=8.5, leading=11))
    return styles


def _table_from_dicts(rows, columns, styles):
    header = [Paragraph(f"<b>{label}</b>", styles["AIPMCell"]) for _, label, _ in columns]
    data = [header]
    for row in rows:
        data.append([Paragraph(str(row.get(key, "")), styles["AIPMCell"]) for key, _, _ in columns])
    total_width = 7.0 * inch
    col_widths = [total_width * frac for _, _, frac in columns]
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a3c6e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f6fb")]),
    ]))
    return table


def _bullet_list(items, styles):
    return ListFlowable(
        [ListItem(Paragraph(str(i), styles["Normal"])) for i in items] or
        [ListItem(Paragraph("(none)", styles["Normal"]))],
        bulletType="bullet",
    )


def build_all_pdfs(run_dir, project_name, data):
    styles = _styles()
    safe_pn = (project_name or "Project").replace(" ", "_")
    pdfs = {}

    def new_doc(title):
        path = os.path.join(run_dir, f"{safe_pn}_{title.replace(' ', '_')}.pdf")
        doc = SimpleDocTemplate(path, pagesize=LETTER,
                                 leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                                 topMargin=0.75 * inch, bottomMargin=0.75 * inch)
        story = [
            Paragraph(project_name or "Project", styles["AIPMTitle"]),
            Spacer(1, 6),
            Paragraph(title, styles["AIPMH2"]),
            Spacer(1, 10),
        ]
        return path, doc, story

    # WBS
    path, doc, story = new_doc("Work Breakdown Structure (WBS)")
    story.append(_table_from_dicts(
        data.get("wbs", []),
        [("wbs_id", "WBS ID", 0.09), ("task_name", "Task", 0.18), ("description", "Description", 0.27),
         ("owner", "Owner", 0.12), ("est_duration", "Duration", 0.10), ("dependencies", "Deps", 0.12),
         ("phase_or_epic", "Phase/Epic", 0.12)],
        styles,
    ))
    doc.build(story)
    pdfs["Work Breakdown Structure (WBS)"] = path

    # Timeline
    path, doc, story = new_doc("Project Timeline")
    timeline = data.get("timeline", {})
    story.append(Paragraph(f"<i>{timeline.get('gantt_summary', '')}</i>", styles["Normal"]))
    story.append(Spacer(1, 8))
    story.append(_table_from_dicts(
        timeline.get("rows", []),
        [("phase_or_sprint", "Phase/Sprint", 0.13), ("wbs_id", "WBS ID", 0.08), ("task", "Task", 0.19),
         ("start_date", "Start", 0.10), ("end_date", "End", 0.10), ("duration", "Dur.", 0.08),
         ("milestone", "Milestone", 0.12), ("owner", "Owner", 0.10), ("status", "Status", 0.10)],
        styles,
    ))
    doc.build(story)
    pdfs["Project Timeline"] = path

    # Resource Allocation
    path, doc, story = new_doc("Resource Allocation Plan")
    ra = data.get("resource_allocation", {})
    story.append(_table_from_dicts(
        ra.get("rows", []),
        [("resource_name_or_role", "Resource", 0.18), ("type", "Type", 0.10),
         ("wbs_id_or_phase", "WBS/Phase", 0.14), ("allocation_pct", "Alloc %", 0.09),
         ("est_hours", "Hours", 0.09), ("cost_rate", "Rate", 0.12), ("notes", "Notes", 0.28)],
        styles,
    ))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Utilization Summary", styles["AIPMH2"]))
    story.append(Paragraph(ra.get("utilization_summary", ""), styles["Normal"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Over-Allocation Warnings", styles["AIPMH2"]))
    story.append(_bullet_list(ra.get("overallocation_warnings", []), styles))
    doc.build(story)
    pdfs["Resource Allocation Plan"] = path

    # Cost Management Plan
    path, doc, story = new_doc("Cost Management Plan")
    cp = data.get("cost_plan", {})
    story.append(Paragraph("Cost Baseline", styles["AIPMH2"]))
    story.append(_table_from_dicts(
        cp.get("cost_baseline", []),
        [("category", "Category", 0.22), ("wbs_id_or_phase", "WBS/Phase", 0.15), ("est_cost", "Est. Cost", 0.18),
         ("actual", "Actual", 0.18), ("variance", "Variance", 0.27)],
        styles,
    ))
    for label, key in [("Cost Estimation Method", "estimation_method"),
                        ("Budget Contingency", "contingency_pct"),
                        ("Cost Control Thresholds", "control_thresholds"),
                        ("Reporting Cadence", "reporting_cadence"),
                        ("Cost Performance Metrics", "performance_metrics")]:
        story.append(Spacer(1, 8))
        story.append(Paragraph(label, styles["AIPMH2"]))
        story.append(Paragraph(str(cp.get(key, "")), styles["Normal"]))
    doc.build(story)
    pdfs["Cost Management Plan"] = path

    return pdfs


# ─────────────────────────────────────────────────────────────────────────────
# Main generation function
# ─────────────────────────────────────────────────────────────────────────────

def generate_project_plan(project_name, milestones, timeline_input, resources,
                           budget_file, methodology, handoff_upload):
    if not any([project_name, milestones, timeline_input, resources, handoff_upload]):
        return (
            "⚠ Please provide at least a Project Name and some planning details, "
            "or upload a Goals & Scope handoff package.",
            None, None, None, None, None,
        )

    run_id = uuid.uuid4().hex[:10]
    run_dir = os.path.join(RUN_DIR, run_id)
    os.makedirs(run_dir, exist_ok=True)

    handoff_data, handoff_warning = extract_handoff_json(handoff_upload)

    budget_text = ""
    if budget_file is not None:
        budget_text = extract_text_from_file(budget_file)

    handoff_context = "Not provided - no Goals & Scope handoff package was uploaded."
    if handoff_data:
        handoff_context = truncate(json.dumps({
            "project_name": handoff_data.get("project_name"),
            "scope": handoff_data.get("scope"),
            "milestones": handoff_data.get("milestones"),
            "risks": handoff_data.get("risks"),
            "resource_teams": handoff_data.get("resource_teams"),
            "open_questions": handoff_data.get("open_questions"),
        }, indent=2), MAX_HANDOFF_CHARS)

    context = f"""Project: {project_name}
Methodology: {methodology}

Goals & Scope Handoff Package (from Agent 1, if provided):
{handoff_context}

Manual Milestones Input (may overlap with or extend the handoff above):
{truncate(milestones, MAX_FIELD_CHARS) or 'Not specified'}

Manual High-Level Timeline Input:
{truncate(timeline_input, MAX_FIELD_CHARS) or 'Not specified'}

Manual Resource List Input:
{truncate(resources, MAX_FIELD_CHARS) or 'Not specified'}

Budget / Financial Data:
{truncate(budget_text, MAX_UPLOAD_CHARS) or 'Not provided'}

Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
"""

    methodology_note = (
        "Use Agile sprint-based decomposition - organize by Epic -> User Story -> Task with "
        "Sprint assignments, wbs_id like EPIC-1 / STORY-1.1."
        if methodology == "Agile" else
        "Use classic Waterfall hierarchical WBS decomposition aligned to phase gates with "
        "sign-off points, wbs_id like 1.0 / 1.1 / 1.1.1."
    )

    user_prompt = f"{context}\n{methodology_note}\n\n{JSON_SCHEMA_INSTRUCTIONS}"

    try:
        data = call_llm(SYSTEM_PROMPT, user_prompt)
    except Exception as e:
        return (f"⚠ Generation failed: {e}", None, None, None, None, None)

    try:
        pdfs = build_all_pdfs(run_dir, project_name, data)
    except Exception as e:
        return (f"⚠ Document rendering failed: {e}", None, None, None, None, None)

    # Handoff package for Agent 3 (Execution) - "Backbone Plan"
    backbone = {
        "handoff_type": "planning_output",
        "handoff_version": "1.0",
        "source_agent": f"planning_v{AGENT_VERSION}",
        "upstream_handoff_used": bool(handoff_data),
        "project_name": project_name,
        "methodology": methodology,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "wbs": data.get("wbs", []),
        "timeline": data.get("timeline", {}),
        "resource_allocation": data.get("resource_allocation", {}),
        "cost_plan": data.get("cost_plan", {}),
        "open_questions": data.get("open_questions", []),
    }
    backbone_path = os.path.join(run_dir, f"{(project_name or 'project').replace(' ', '_')}_backbone_plan.json")
    with open(backbone_path, "w") as f:
        json.dump(backbone, f, indent=2)

    # Upload every output (PDFs + Backbone Plan JSON) to Firebase Storage → permanent,
    # browser-fetchable URLs that survive server restarts/redeploys.
    uploaded = {}
    for title, local_path in pdfs.items():
        url, storage_path = upload_to_storage(local_path, project_name, title, content_type="application/pdf")
        uploaded[title] = {"url": url, "path": storage_path}
    backbone_url, backbone_storage_path = upload_to_storage(
        backbone_path, project_name, "Backbone Plan", content_type="application/json"
    )
    uploaded_backbone = {"url": backbone_url, "path": backbone_storage_path}

    status_lines = []
    if handoff_warning:
        status_lines.append(handoff_warning)
    status_lines.append(f"✅ All planning documents generated for '{project_name}'" +
                         (" (using Goals & Scope handoff)" if handoff_data else "") + ".")
    if data.get("open_questions"):
        status_lines.append(f"⚠ {len(data['open_questions'])} open question(s) flagged in the Backbone Plan.")

    return (
        "\n".join(status_lines),
        uploaded["Work Breakdown Structure (WBS)"],
        uploaded["Project Timeline"],
        uploaded["Resource Allocation Plan"],
        uploaded["Cost Management Plan"],
        uploaded_backbone,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Flask REST API — this is what the aihyperdox.com frontend actually calls
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/predict", methods=["POST", "OPTIONS"])
def api_predict():
    if request.method == "OPTIONS":
        return "", 204
    try:
        data       = request.json or {}
        input_data = data.get("data", [])

        if len(input_data) < 4:
            return jsonify({"error": "Missing required fields"}), 400

        project_name   = input_data[0] or ""
        milestones     = input_data[1] or ""
        timeline_input = input_data[2] or ""
        resources      = input_data[3] or ""
        budget_file    = input_data[4] if len(input_data) > 4 else None
        methodology    = input_data[5] if len(input_data) > 5 else "Agile"
        handoff_upload = input_data[6] if len(input_data) > 6 else None

        result = generate_project_plan(
            project_name, milestones, timeline_input, resources,
            budget_file, methodology, handoff_upload,
        )
        return jsonify({"data": result}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/download", methods=["GET"])
def download_file():
    """
    Fallback download endpoint — only used when Firebase Storage is not configured
    and files are still on the Railway /tmp filesystem (i.e. same session). Once
    Firebase is configured, generate_project_plan() returns a permanent
    firebasestorage.googleapis.com URL instead, and this endpoint is never hit for
    new runs.
    """
    path = request.args.get("path")
    if not path:
        abort(400, description="Missing 'path' query parameter.")
    if not path.startswith(RUN_DIR):
        abort(403, description="Access denied.")
    if not os.path.exists(path):
        abort(404, description=f"File not found: {path}. The server may have restarted — please regenerate the documents.")
    return send_file(
        path,
        as_attachment=True,
        download_name=os.path.basename(path),
        mimetype="application/pdf"
    )


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok", "firebase": _firebase_ready}), 200


# ─────────────────────────────────────────────────────────────────────────────
# Gradio UI
# ─────────────────────────────────────────────────────────────────────────────

CUSTOM_CSS = """
    .header { text-align:center; padding:14px 0 6px; }
    .header h1 { font-size:1.75rem; font-weight:700; color:#1a3c6e; }
    .header p  { color:#555; font-size:.93rem; margin-top:3px; }
    footer { visibility:hidden; }
"""

with gr.Blocks(title="AIPM - Project Plan Documents") as demo:

    gr.HTML("""
        <div class="header">
            <h1>🗂️ AIPM – Planning Agent</h1>
            <p>Agent 2 of 3 &nbsp;·&nbsp; Goals & Scope → Planning → Execution</p>
        </div>
    """)

    with gr.Row():
        with gr.Column(scale=1):
            handoff_upload = gr.File(
                label="🔗 Goals & Scope Handoff Package (optional, .json from Agent 1)",
                file_count="single",
            )
            project_name = gr.Textbox(
                label="Project Name", placeholder="e.g. Uggalot Episode 1 Production", lines=1,
            )
            methodology = gr.Radio(
                choices=["Agile", "Waterfall"], value="Agile", label="📐 Methodology",
                info="Agile = sprint/epic decomposition. Waterfall = phase-gate planning.",
            )
            milestones = gr.Textbox(
                label="Milestones (optional if handoff package provided - will be merged)",
                placeholder="e.g.\nM1 – Script Finalized | 2026-06-20\nM2 – Animation Draft Complete | 2026-07-15",
                lines=5,
            )
            timeline = gr.Textbox(
                label="High-Level Timeline",
                placeholder="e.g.\nPhase 1: Pre-Production (Jun 1 – Jun 30)\nPhase 2: Production (Jul 1 – Jul 31)",
                lines=4,
            )
            resources = gr.Textbox(
                label="Resource List (optional if handoff package provided - will be merged)",
                placeholder="e.g.\nAnshika – Illustrator (full-time)\nDeepanshu – Animator Intern",
                lines=5,
            )
            budget_file = gr.File(
                label="📊 Budget Spreadsheet - optional (XLSX / CSV / PDF / TXT)", file_count="single",
            )
            submit_btn = gr.Button("🚀 Generate Project Plan Documents", variant="primary")

        with gr.Column(scale=1):
            status = gr.Textbox(label="Status", interactive=False, lines=4)
            pdf_wbs = gr.File(label="📥 Work Breakdown Structure (WBS)")
            pdf_tl = gr.File(label="📥 Project Timeline")
            pdf_ra = gr.File(label="📥 Resource Allocation Plan")
            pdf_cm = gr.File(label="📥 Cost Management Plan")
            backbone_file = gr.File(label="🔗 Backbone Plan - Handoff for Execution Agent (JSON)")

    submit_btn.click(
        fn=generate_project_plan,
        inputs=[project_name, milestones, timeline, resources, budget_file, methodology, handoff_upload],
        outputs=[status, pdf_wbs, pdf_tl, pdf_ra, pdf_cm, backbone_file],
        show_progress=True,
    )

    gr.HTML(
        f"<p style='text-align:center;color:#bbb;font-size:11px;margin-top:16px;'>"
        f"© 2026 Caveman Productions Media &nbsp;·&nbsp; AIPM Planning Agent v{AGENT_VERSION} "
        f"&nbsp;·&nbsp; Agent 2 of 3</p>"
    )

if __name__ == "__main__":
    def run_gradio():
        demo.launch(
            server_name="127.0.0.1",
            server_port=7860,
            share=False,
            quiet=True,
            theme=gr.themes.Soft(primary_hue="blue", neutral_hue="gray"),
            css=CUSTOM_CSS,
        )

    threading.Thread(target=run_gradio, daemon=True).start()

    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
