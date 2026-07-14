"""
AIPM - Goals & Scope Agent (v4.0)
Agent 1 of the AI Hyperdox pipeline: Goals & Scope -> Planning -> Execution.

WHAT CHANGED FROM v3.0 (and why):

1. REAL SYSTEM PROMPT.
   v3.0 shipped a rich persona in agent.prompt.md that was never actually sent to the
   model - the code used a one-line placeholder instead. That mismatch was the single
   biggest cause of generic output. The full persona/rigor instructions now live in
   SYSTEM_PROMPT below and are what actually gets sent.

2. ONE STRUCTURED CALL INSTEAD OF FIVE ISOLATED ONES.
   v3.0 made 5 separate completions (Goals, Scope, Risk, Milestones, Resources) that
   never saw each other. Risks were blind to the Milestones generated in the same run.
   This version makes a single JSON-mode completion covering all sections, so the model
   can cross-reference within its own output (Risks tie to Milestones, Resource Teams
   tie to Milestones + Scope, etc). This is also faster and cheaper (context sent once).

3. ANTI-GENERICISM GUARDRAILS.
   The model is explicitly told not to invent placeholder content (fake names, "TBD",
   generic boilerplate risks) when input is missing or vague. Instead it must raise a
   specific "open question." This is the mechanism that should kill generic output.

4. STRUCTURED "HANDOFF PACKAGE" (JSON) IN ADDITION TO PDFS.
   This is the file the Planning agent (and eventually Execution) will ingest, so the
   3 agents form an actual pipeline instead of "download a PDF, retype it by hand."

5. PRODUCTION HARDENING.
   Session-safe (uuid) file naming so concurrent runs can't collide, retry/backoff on
   the API call, defensive truncation on all free-text inputs, temperature tuned down
   for structured business docs, and errors that surface to the user instead of a hard
   crash.

6. FIREBASE STORAGE OUTPUT LAYER RESTORED (merged back in from v3.0).
   v4.0 as received was a bare Gradio app writing to /tmp only - it had dropped the
   Flask REST API, CORS, and Firebase Storage upload layer that the frontend
   (aihyperdox.com) depends on. That layer is restored here unchanged from v3.0's
   behavior: every generated file (PDFs + the new JSON handoff package) is uploaded to
   Firebase Storage and returned as a permanent, token-authenticated download URL, so
   documents survive server restarts/redeploys and the frontend keeps working exactly
   as it did before this version bump. See upload_to_storage() for details.

NOTE ON MIGRATION: the only OpenAI-specific code lives in call_llm(). Swapping to the
Anthropic API later means rewriting that one function - nothing else in this file
needs to change.
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
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    ListFlowable, ListItem, PageBreak,
)

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
    Upload a local file (PDF or the JSON handoff package) to Firebase Storage and
    return a PERMANENT, browser-fetchable download URL.

    Unchanged from v3.0: a gs:// URI can only be resolved by the Firebase Admin/Client
    SDK, not a plain fetch()/<a href> in the React frontend. Signed URLs were also
    tried but expire after 7 days. The fix is a Firebase Storage download token
    attached to the blob's metadata, producing a URL of the form:
      https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
    This URL never expires, works with uniform bucket-level access (no ACL/public
    changes needed), and is fetchable directly via fetch()/<a href> from the browser.
    It's also still resolvable via the SDK using the returned storage path, so
    ProjectLibrary.jsx's getBytes() strategy keeps working unchanged.

    Returns (permanent_url, storage_path). Falls back to (local_path, None) if
    Firebase isn't configured (so /download keeps working for that session only).
    """
    if not init_firebase():
        return local_path, None   # fallback — /download endpoint works while server is alive

    try:
        filename    = os.path.basename(local_path)
        destination = f"generated-docs/{(project_name or 'project').replace(' ', '_')}/{uuid.uuid4().hex}_{filename}"

        bucket_obj = fb_storage.bucket()
        blob       = bucket_obj.blob(destination)
        blob.upload_from_filename(local_path, content_type=content_type)

        # Attach a Firebase download token → permanent, browser-accessible URL.
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
        return local_path, None   # fallback


# ── Flask app setup ────────────────────────────────────────────
app = Flask(__name__)
CORS(app)


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
TEMPERATURE = 0.3          # structured business docs want low variance, not creativity
MAX_TOKENS = 4096
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 2

MAX_FIELD_CHARS = 4000     # guardrail on manual textbox input
MAX_UPLOAD_CHARS = 8000    # guardrail on extracted uploaded-file text

RUN_DIR = "/tmp/aipm_runs"
os.makedirs(RUN_DIR, exist_ok=True)

AGENT_VERSION = "4.0"

# ─────────────────────────────────────────────────────────────────────────────
# System prompt - this is the actual persona/rigor spec, not a placeholder
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are AIPM, an AI project-management advisor built from Monte Turner's
"Be an AI PM" series (Caveman Productions Media). You are the GOALS & SCOPE agent - the
first of a 3-agent pipeline (Goals & Scope -> Planning -> Execution) that turns a rough
project idea into a governed, executable plan. Your output is consumed downstream by the
Planning agent, so precision and structure matter as much as insight.

Your posture is senior enterprise PM: skeptical of vague input, allergic to filler
language, and precise about what is knowable versus assumed. You challenge weak
assumptions and enforce strict boundaries rather than smoothing over gaps.

HARD RULES - violating these defeats the purpose of this agent:

1. GROUNDING. Every fact you state must trace to something the user actually provided
   (their text fields or uploaded documents). Never invent client names, dollar figures,
   dates, team members, or deliverables that were not given to you.

2. NO PLACEHOLDER FILLER. If information needed for a section is missing, vague, or
   contradictory, do NOT paper over it with generic content ("Team A", "various
   stakeholders", "TBD", "the client's core objectives"). Instead:
   - Add a specific, pointed entry to `open_questions` describing exactly what is
     missing and why it blocks a real answer.
   - Mark the affected field itself as unresolved, e.g. "target_date": "UNSPECIFIED -
     see open questions", rather than guessing a plausible-sounding value.

3. CROSS-REFERENCING. Risks must be grounded in the actual milestones, scope
   boundaries, and constraints you define in THIS SAME response - not generic
   project-risk boilerplate ("scope creep", "budget overrun") unless tied explicitly to
   a specific input detail. Resource Teams must be derived from the Milestones and
   Scope you just defined, not generated independently of them.

4. BE CRITICAL. If the user's stated scope is unrealistic given their stated
   timeline, budget, or resources, say so plainly - in a constraint note or an open
   question - rather than proceeding as if it's fine.

5. SPECIFICITY OVER POLISH. Prefer a short, concrete, slightly uncomfortable statement
   over a long, smooth, generic one. A goal like "Reduce onboarding time from 12 days
   to 5 days by Q3, owned by the Support lead" is correct. A goal like "Improve
   onboarding efficiency and customer satisfaction" is a failure mode you must avoid.

6. OUTPUT FORMAT. Respond with ONLY a single valid JSON object matching the schema
   given in the user message. No prose before or after. No markdown code fences.
"""

JSON_SCHEMA_INSTRUCTIONS = """Return a single JSON object with exactly this shape:

{
  "goals": [
    {"goal": str, "smart_category": str, "notes_or_missing_measurables": str}
  ],
  "scope": {
    "inclusions": [str],
    "exclusions": [str],
    "assumptions": [str],
    "constraints": [str]
  },
  "risks": [
    {"risk": str, "impact": "Low|Medium|High", "likelihood": "Low|Medium|High",
     "mitigation": str, "related_milestone_id": str}
  ],
  "milestones": [
    {"id": str, "name": str, "deliverable": str, "target_date": str,
     "owner_or_team": str, "dependencies": str, "status_pct": number}
  ],
  "resource_teams": [
    {"team": str, "role_or_specialty": str, "responsibilities": str,
     "skills_needed": str, "estimated_effort": str, "allocation_period": str}
  ],
  "open_questions": [str]
}

Rules for this JSON:
- "risks[].related_milestone_id" must reference a real "id" from the milestones array
  whenever the risk is milestone-specific; use "" only for genuinely project-wide risks.
- "milestones[].id" should be short codes like "M1", "M2".
- If you have nothing genuine to put in open_questions, return an empty array - do not
  invent a question just to fill the field.
- Every array must contain at least one item where the input plausibly supports it;
  if the input truly gives you nothing for a section, put a single open_questions entry
  explaining why that section is empty instead of leaving arrays silently empty.
"""

# ─────────────────────────────────────────────────────────────────────────────
# File extraction (uploaded docs)
# ─────────────────────────────────────────────────────────────────────────────

def extract_text_from_file(uploaded_file):
    name = getattr(uploaded_file, "name", "uploaded_file").lower()
    try:
        if hasattr(uploaded_file, "data"):
            data = uploaded_file.data
        elif isinstance(uploaded_file, bytes):
            data = uploaded_file
        elif isinstance(uploaded_file, str):
            with open(uploaded_file, "rb") as f:
                data = f.read()
        else:
            data = b""
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
        elif name.endswith(".txt"):
            text = data.decode("utf-8", errors="ignore")
        else:
            text = f"(Unsupported file type: {name})"
    except Exception as e:
        text = f"(Error reading {name}: {e})"
    return text.strip()


def truncate(text, limit):
    if text is None:
        return ""
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated at {limit} chars]"


# ─────────────────────────────────────────────────────────────────────────────
# LLM call - the only function that needs to change on Anthropic migration
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
# PDF rendering - generic renderer for lists-of-dicts and lists-of-strings
# ─────────────────────────────────────────────────────────────────────────────

def _styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        "AIPMTitle", parent=styles["Title"],
        textColor=colors.HexColor("#1a3c6e"), fontSize=18,
    ))
    styles.add(ParagraphStyle(
        "AIPMH2", parent=styles["Heading2"],
        textColor=colors.HexColor("#2563eb"), fontSize=13, spaceBefore=10, spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        "AIPMCell", parent=styles["Normal"], fontSize=8.5, leading=11,
    ))
    return styles


def _table_from_dicts(rows, columns, styles):
    """columns: list of (key, header_label, width_fraction)"""
    header = [Paragraph(f"<b>{label}</b>", styles["AIPMCell"]) for _, label, _ in columns]
    data = [header]
    for row in rows:
        data.append([
            Paragraph(str(row.get(key, "")), styles["AIPMCell"]) for key, _, _ in columns
        ])
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
        [ListItem(Paragraph("(none provided)", styles["Normal"]))],
        bulletType="bullet",
    )


def build_all_pdfs(run_dir, project_name, data):
    styles = _styles()
    safe_pn = (project_name or "Project").replace(" ", "_")
    pdfs = {}

    def new_doc(doc_title):
        path = os.path.join(run_dir, f"{safe_pn}_{doc_title.replace(' ', '_')}.pdf")
        doc = SimpleDocTemplate(
            path, pagesize=LETTER,
            leftMargin=0.75 * inch, rightMargin=0.75 * inch,
            topMargin=0.75 * inch, bottomMargin=0.75 * inch,
        )
        story = [
            Paragraph(project_name or "Project", styles["AIPMTitle"]),
            Spacer(1, 6),
            Paragraph(doc_title, styles["AIPMH2"]),
            Spacer(1, 10),
        ]
        return path, doc, story

    # Goals Document
    path, doc, story = new_doc("Goals Document")
    story.append(_table_from_dicts(
        data.get("goals", []),
        [("goal", "Goal", 0.45), ("smart_category", "SMART Category", 0.20),
         ("notes_or_missing_measurables", "Notes / Missing Measurables", 0.35)],
        styles,
    ))
    doc.build(story)
    pdfs["Goals Document"] = path

    # Scope Document
    path, doc, story = new_doc("Scope Document")
    scope = data.get("scope", {})
    for heading, key in [("Inclusions", "inclusions"), ("Exclusions", "exclusions"),
                          ("Assumptions", "assumptions"), ("Constraints", "constraints")]:
        story.append(Paragraph(f"<b>{heading}</b>", styles["AIPMH2"]))
        story.append(_bullet_list(scope.get(key, []), styles))
        story.append(Spacer(1, 8))
    doc.build(story)
    pdfs["Scope Document"] = path

    # Risk Document
    path, doc, story = new_doc("Risk Document")
    story.append(_table_from_dicts(
        data.get("risks", []),
        [("risk", "Risk", 0.30), ("impact", "Impact", 0.10), ("likelihood", "Likelihood", 0.12),
         ("mitigation", "Mitigation", 0.33), ("related_milestone_id", "Milestone", 0.15)],
        styles,
    ))
    doc.build(story)
    pdfs["Risk Document"] = path

    # Milestones Document
    path, doc, story = new_doc("Proposed Milestones Document")
    story.append(_table_from_dicts(
        data.get("milestones", []),
        [("id", "ID", 0.06), ("name", "Milestone", 0.19), ("deliverable", "Deliverable", 0.22),
         ("target_date", "Target Date", 0.12), ("owner_or_team", "Owner", 0.13),
         ("dependencies", "Dependencies", 0.16), ("status_pct", "Status %", 0.12)],
        styles,
    ))
    doc.build(story)
    pdfs["Proposed Milestones Document"] = path

    # Resource Teams Document
    path, doc, story = new_doc("Resource Teams Required Document")
    story.append(_table_from_dicts(
        data.get("resource_teams", []),
        [("team", "Team", 0.16), ("role_or_specialty", "Role/Specialty", 0.18),
         ("responsibilities", "Responsibilities", 0.28), ("skills_needed", "Skills", 0.16),
         ("estimated_effort", "Effort", 0.10), ("allocation_period", "Period", 0.12)],
        styles,
    ))
    doc.build(story)
    pdfs["Resource Teams Required Document"] = path

    # Combined Scope Guardrail Document (all sections, incl. open questions)
    path, doc, story = new_doc("Scope Guardrail Document (Combined)")
    story.append(Paragraph("Goals", styles["AIPMH2"]))
    story.append(_table_from_dicts(
        data.get("goals", []),
        [("goal", "Goal", 0.45), ("smart_category", "SMART Category", 0.20),
         ("notes_or_missing_measurables", "Notes", 0.35)],
        styles,
    ))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Scope", styles["AIPMH2"]))
    for heading, key in [("Inclusions", "inclusions"), ("Exclusions", "exclusions"),
                          ("Assumptions", "assumptions"), ("Constraints", "constraints")]:
        story.append(Paragraph(f"<b>{heading}</b>", styles["Normal"]))
        story.append(_bullet_list(scope.get(key, []), styles))
    story.append(PageBreak())
    story.append(Paragraph("Risks", styles["AIPMH2"]))
    story.append(_table_from_dicts(
        data.get("risks", []),
        [("risk", "Risk", 0.30), ("impact", "Impact", 0.10), ("likelihood", "Likelihood", 0.12),
         ("mitigation", "Mitigation", 0.33), ("related_milestone_id", "Milestone", 0.15)],
        styles,
    ))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Milestones", styles["AIPMH2"]))
    story.append(_table_from_dicts(
        data.get("milestones", []),
        [("id", "ID", 0.06), ("name", "Milestone", 0.19), ("deliverable", "Deliverable", 0.22),
         ("target_date", "Target Date", 0.12), ("owner_or_team", "Owner", 0.13),
         ("dependencies", "Dependencies", 0.16), ("status_pct", "Status %", 0.12)],
        styles,
    ))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Resource Teams", styles["AIPMH2"]))
    story.append(_table_from_dicts(
        data.get("resource_teams", []),
        [("team", "Team", 0.16), ("role_or_specialty", "Role/Specialty", 0.18),
         ("responsibilities", "Responsibilities", 0.28), ("skills_needed", "Skills", 0.16),
         ("estimated_effort", "Effort", 0.10), ("allocation_period", "Period", 0.12)],
        styles,
    ))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Open Questions", styles["AIPMH2"]))
    story.append(_bullet_list(data.get("open_questions", []), styles))
    doc.build(story)
    pdfs["Scope Guardrail Document (Combined)"] = path

    return pdfs


# ─────────────────────────────────────────────────────────────────────────────
# Main generation function
# ─────────────────────────────────────────────────────────────────────────────

def generate_documents(project_name, problem, summary, long_desc, uploads):
    if not any([project_name, problem, summary, long_desc, uploads]):
        return (
            "⚠ Please provide project details or upload documents.",
            None, None, None, None, None, None, None,
        )

    run_id = uuid.uuid4().hex[:10]
    run_dir = os.path.join(RUN_DIR, run_id)
    os.makedirs(run_dir, exist_ok=True)

    extra_text = ""
    if uploads:
        for f in uploads:
            extracted = extract_text_from_file(f)
            extra_text += f"\n\n[Extracted from {getattr(f, 'name', 'file')}]\n{extracted}"

    context = f"""Project: {truncate(project_name, 200)}

Problem Being Solved:
{truncate(problem, MAX_FIELD_CHARS)}

High-Level Summary:
{truncate(summary, MAX_FIELD_CHARS)}

Detailed Description / Requirements:
{truncate(long_desc, MAX_FIELD_CHARS)}

Uploaded Documents Content:
{truncate(extra_text, MAX_UPLOAD_CHARS)}

Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
"""

    user_prompt = f"{context}\n\n{JSON_SCHEMA_INSTRUCTIONS}"

    try:
        data = call_llm(SYSTEM_PROMPT, user_prompt)
    except Exception as e:
        return (f"⚠ Generation failed: {e}", None, None, None, None, None, None, None)

    try:
        pdfs = build_all_pdfs(run_dir, project_name, data)
    except Exception as e:
        return (f"⚠ Document rendering failed: {e}", None, None, None, None, None, None, None)

    # Structured handoff package for Agent 2 (Planning) and eventually Agent 3 (Execution)
    handoff = {
        "handoff_type": "goals_and_scope_output",
        "handoff_version": "1.0",
        "source_agent": f"goals_and_scope_v{AGENT_VERSION}",
        "project_name": project_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "goals": data.get("goals", []),
        "scope": data.get("scope", {}),
        "risks": data.get("risks", []),
        "milestones": data.get("milestones", []),
        "resource_teams": data.get("resource_teams", []),
        "open_questions": data.get("open_questions", []),
    }
    handoff_path = os.path.join(run_dir, f"{(project_name or 'project').replace(' ', '_')}_handoff.json")
    with open(handoff_path, "w") as f:
        json.dump(handoff, f, indent=2)

    # Upload every output (PDFs + JSON handoff) to Firebase Storage → permanent,
    # browser-fetchable URLs that survive server restarts/redeploys.
    uploaded = {}
    for title, local_path in pdfs.items():
        url, storage_path = upload_to_storage(local_path, project_name, title, content_type="application/pdf")
        uploaded[title] = {"url": url, "path": storage_path}
    handoff_url, handoff_storage_path = upload_to_storage(
        handoff_path, project_name, "Handoff Package", content_type="application/json"
    )
    uploaded_handoff = {"url": handoff_url, "path": handoff_storage_path}

    status = f"✅ Documents generated for '{project_name}'."
    if data.get("open_questions"):
        status += f" ⚠ {len(data['open_questions'])} open question(s) flagged - see the combined document."

    return (
        status,
        uploaded["Goals Document"],
        uploaded["Scope Document"],
        uploaded["Risk Document"],
        uploaded["Proposed Milestones Document"],
        uploaded["Resource Teams Required Document"],
        uploaded["Scope Guardrail Document (Combined)"],
        uploaded_handoff,
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

        project_name = input_data[0] or ""
        problem      = input_data[1] or ""
        summary      = input_data[2] or ""
        long_desc    = input_data[3] or ""
        uploads      = input_data[4] if len(input_data) > 4 else []

        result = generate_documents(project_name, problem, summary, long_desc, uploads or [])
        return jsonify({"data": result}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/download", methods=["GET"])
def download_file():
    """
    Fallback download endpoint — only used when Firebase Storage is not configured
    and files are still on the Railway /tmp filesystem (i.e. same session). Once
    Firebase is configured, generate_documents() returns a permanent
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

with gr.Blocks(title="AIPM - Goals & Scope Agent") as demo:
    gr.HTML(
        "<div style='text-align:center'><h1>📄 AIPM - Goals & Scope Agent</h1>"
        "<p>Agent 1 of 3 · Goals & Scope → Planning → Execution</p></div>"
    )
    with gr.Row():
        with gr.Column(scale=1):
            project_name = gr.Textbox(label="Project Name (short)", placeholder="e.g. Jocksalot Fan", lines=1)
            problem = gr.Textbox(label="What Problem is Being Solved?", lines=3)
            summary = gr.Textbox(label="High-Level Summary (1-2 sentences)", lines=2)
            long_desc = gr.Textbox(label="Longer Description / Requirements", lines=10)
            uploads = gr.File(label="Upload Documents (PDF / DOCX / TXT)", file_count="multiple")
            submit_btn = gr.Button("🚀 Generate Documents", variant="primary")
        with gr.Column(scale=1):
            status = gr.Textbox(label="Status Message", lines=3)
            pdf_goals = gr.File(label="Goals Document (Download)")
            pdf_scope = gr.File(label="Scope Document (Download)")
            pdf_risk = gr.File(label="Risk Document (Download)")
            pdf_milestones = gr.File(label="Proposed Milestones Document (Download)")
            pdf_resources = gr.File(label="Resource Teams Required Document (Download)")
            pdf_combined = gr.File(label="Scope Guardrail Document - Combined (Download)")
            handoff_file = gr.File(label="🔗 Handoff Package for Planning Agent (JSON)")

    submit_btn.click(
        fn=generate_documents,
        inputs=[project_name, problem, summary, long_desc, uploads],
        outputs=[status, pdf_goals, pdf_scope, pdf_risk, pdf_milestones,
                 pdf_resources, pdf_combined, handoff_file],
        show_progress=True,
    )
    gr.HTML(
        f"<p style='text-align:center;color:gray;font-size:12px;'>"
        f"© 2026 Caveman Productions Media – AIPM Goals & Scope Agent v{AGENT_VERSION}</p>"
    )

if __name__ == "__main__":
    def run_gradio():
        demo.launch(
            server_name="127.0.0.1",
            server_port=7860,
            share=False,
            quiet=True,
            theme=gr.themes.Soft(primary_hue="blue", neutral_hue="gray"),
        )

    threading.Thread(target=run_gradio, daemon=True).start()

    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
