"""
AIPM - Goals & Scope Agent (v5.0, production wrapper restored)
Agent 1 of the AI Hyperdox pipeline: Goals & Scope -> Planning -> Execution.

WHAT THIS PASS CHANGES (and why):

The v5.0 agent logic (below) came in as a bare Gradio app - same situation v4.0 was
originally received in. That would have shipped without the Flask REST API, CORS,
Firebase Storage upload layer, or health check server that aihyperdox.com and Railway
actually depend on. This pass does ONE thing: restores that production wrapper around
the v5.0 agent logic, unchanged from how it works in v4.0. No agent behavior below was
touched.

WHAT v5.0 CHANGED FROM v4.0 (carried through unchanged in this pass):

1. SMART EVALUATION IS NOW STRUCTURAL, NOT A SINGLE LABEL.
   v4.0's schema had "smart_category": str - a single slot, so the model picked
   whichever SMART letter fit best and stopped, instead of evaluating a goal against
   all five criteria. goals[].smart_evaluation is now a dict of five booleans plus
   a "missing_elements" list explaining any false ones. Caught in QA against a real
   client input where every goal got exactly one SMART tag and "Relevant" never
   appeared at all.

2. COVERAGE GUARDRAIL FOR RISKS AND RESOURCE TEAMS.
   Same QA pass found Risks and Resource Teams silently under-covering scope.inclusions
   - e.g. 4 inclusions but only 2 risks, and 4 distinct technical workstreams collapsed
   into a single generic resource_teams row. v4.0's anti-genericism guardrail only
   covers *inventing* filler, not *omitting* coverage - different failure modes. Added
   SYSTEM_PROMPT rule 7 (COVERAGE) plus a code-level validate_coverage() check that runs
   after every LLM call, independent of whether the model actually followed the prompt
   instruction. Gaps get surfaced as open_questions instead of silently disappearing.

3. HANDOFF SCHEMA VERSION BUMP.
   goals[] shape changed (smart_category -> smart_evaluation + missing_elements), so
   handoff_version bumped 1.0 -> 1.1. Not backward compatible for any Planning-side
   code that reads smart_category directly - flag this to Aatish explicitly.

4. FILE EXTRACTION BUGFIX. extract_text_from_file() determined file extension via
   getattr(uploaded_file, "name", ...), which silently fails for plain string
   filepaths (no .name attribute) - the actual shape Gradio hands per-item for
   file_count="multiple". Every uploaded document was hitting the "Unsupported file
   type" branch regardless of actual extension. Runtime-verified against .txt and .pdf.

WHAT v4.0 RESTORED (and this pass re-restores over v5.0's bare state):

5. REAL SYSTEM PROMPT sent to the model (not a placeholder) - see SYSTEM_PROMPT below.
6. ONE STRUCTURED CALL covering all sections, so Risks/Resource Teams can cross-reference
   Milestones generated in the same run, instead of five isolated blind completions.
7. STRUCTURED "HANDOFF PACKAGE" (JSON) that the Planning agent ingests directly.
8. PRODUCTION HARDENING: session-safe (uuid) file naming, retry/backoff on the API
   call, defensive truncation on free-text inputs, and errors that surface to the user
   instead of a hard crash.
9. FIREBASE STORAGE OUTPUT LAYER. Every generated file (PDFs + JSON handoff package) is
   uploaded to Firebase Storage and returned as a permanent, token-authenticated
   download URL, so documents survive server restarts/redeploys and the frontend
   (aihyperdox.com) keeps working. See upload_to_storage() for details.
10. FLASK REST API + CORS + health check server. This is what aihyperdox.com actually
    calls (/api/predict) - the Gradio Blocks UI below is a secondary manual-test surface
    that happens to share the same generate_documents() function, not the production path.

KNOWN CARRIED-OVER QUIRK (unchanged from v4.0, not introduced here): generate_documents()
returns {"url": ..., "path": ...} dicts (not bare local paths) so the Flask API and
ProjectLibrary.jsx's Firebase-SDK download strategy keep working. Gradio's gr.File
component expects a plain local path, so the in-app preview/download buttons in the
Blocks UI below will not render correctly when Firebase is configured - this only
affects the manual-test UI, not the /api/predict path the frontend uses. Flagging this
rather than silently changing the return shape, since altering it would break the
frontend's download contract.

NOTE ON MIGRATION: the only OpenAI-specific code lives in call_llm(). Swapping to the
Anthropic API later means rewriting that one function - nothing else in this file needs
to change. Still deprioritized as of v5.0.
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

    Unchanged from v4.0: a gs:// URI can only be resolved by the Firebase Admin/Client
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

AGENT_VERSION = "5.0"
HANDOFF_VERSION = "1.1"    # bumped from 1.0 - goals[] shape changed, see module docstring

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

7. COVERAGE. Every item in scope.inclusions must be traceable to at least one entry
   in BOTH risks and resource_teams - even a Low/Low risk, even if a resource team row
   simply confirms the same person or team covers multiple workstreams. Do not collapse
   distinct inclusions into a single generic row for either section. If genuinely no
   risk or resource distinction exists for an inclusion, say so explicitly in that
   entry's text rather than omitting the inclusion from these sections entirely.
"""

JSON_SCHEMA_INSTRUCTIONS = """Return a single JSON object with exactly this shape:

{
  "goals": [
    {"goal": str,
     "smart_evaluation": {"specific": bool, "measurable": bool, "achievable": bool,
                           "relevant": bool, "time_bound": bool},
     "missing_elements": [str],
     "notes_or_missing_measurables": str}
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
- "goals[].smart_evaluation" must assess ALL FIVE criteria independently for every
  goal - a goal is not "the Measurable one," it either does or doesn't satisfy each
  criterion. If a criterion is false, add a specific reason to "missing_elements"
  (e.g. "No owner or team assigned" for a failed Relevant check).
- "risks[].related_milestone_id" must reference a real "id" from the milestones array
  whenever the risk is milestone-specific; use "" only for genuinely project-wide risks.
- "milestones[].id" should be short codes like "M1", "M2".
- "resource_teams" should have one row per distinct technical workstream visible in
  milestones/scope, not one collapsed row per solo developer. The same person can own
  multiple rows with different skills_needed and estimated_effort per workstream.
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
    # BUGFIX (found during Planning Agent v2.1 testing, backported here): a plain
    # string filepath has no .name attribute, so the old
    # `getattr(uploaded_file, "name", "uploaded_file")` always fell back to the
    # literal string "uploaded_file" for string paths - which is exactly what
    # Gradio's file_count="multiple" hands us per item. That silently sent every
    # upload down the "Unsupported file type" branch regardless of actual extension,
    # meaning uploaded documents were being read into memory but never actually
    # parsed. Runtime-verified fixed against both .txt and real .pdf uploads.
    if isinstance(uploaded_file, str):
        name = uploaded_file.lower()
    else:
        name = str(getattr(uploaded_file, "name", "uploaded_file")).lower()
    try:
        if hasattr(uploaded_file, "data"):
            data = uploaded_file.data
        elif isinstance(uploaded_file, bytes):
            data = uploaded_file
        elif isinstance(uploaded_file, str):
            with open(uploaded_file, "rb") as f:
                data = f.read()
        else:
            with open(getattr(uploaded_file, "name", uploaded_file), "rb") as f:
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
# Coverage validation - new in v5.0
# ─────────────────────────────────────────────────────────────────────────────

def validate_coverage(data):
    """Flag scope inclusions that have no corresponding risk or resource_team entry,
    instead of silently letting the model under-cover them.

    This is a deliberately crude keyword check, not semantic matching - it will have
    false positives on loosely-worded inclusions. That's an acceptable tradeoff: a
    false positive just adds an extra open_questions entry for a human to dismiss,
    while a false negative is the exact silent-omission bug this function exists to
    catch. Consistent with the existing "surface it, don't hide it" philosophy used
    for open_questions elsewhere in this agent.
    """
    inclusions = data.get("scope", {}).get("inclusions", [])
    risks_text = " ".join(r.get("risk", "") for r in data.get("risks", [])).lower()
    resources_text = " ".join(
        rt.get("responsibilities", "") for rt in data.get("resource_teams", [])
    ).lower()

    open_qs = data.setdefault("open_questions", [])
    for inclusion in inclusions:
        key_terms = [w.lower().strip(".,()") for w in inclusion.split() if len(w) > 4][:3]
        if not key_terms:
            continue
        if not any(t in risks_text for t in key_terms):
            open_qs.append(
                f"No risk entry appears tied to scope inclusion '{inclusion}' - "
                f"confirm whether this workstream genuinely carries no risk."
            )
        if not any(t in resources_text for t in key_terms):
            open_qs.append(
                f"No resource team entry appears tied to scope inclusion '{inclusion}' - "
                f"confirm ownership for this workstream."
            )
    return data


def format_smart_evaluation(smart_eval):
    """Render the smart_evaluation dict as a compact table-cell string, e.g.
    'S✓ M✓ A✓ R✗ T✓'."""
    if not isinstance(smart_eval, dict):
        return str(smart_eval or "")
    labels = [
        ("S", "specific"), ("M", "measurable"), ("A", "achievable"),
        ("R", "relevant"), ("T", "time_bound"),
    ]
    check, cross = "✓", "✗"
    parts = []
    for letter, key in labels:
        mark = check if smart_eval.get(key) else cross
        parts.append(f"{letter}{mark}")
    return " ".join(parts)


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
    """columns: list of (key, header_label, width_fraction) OR
    (key, header_label, width_fraction, formatter_fn) to transform the cell value."""
    header = [Paragraph(f"<b>{label}</b>", styles["AIPMCell"]) for label in
              [c[1] for c in columns]]
    data = [header]
    for row in rows:
        cells = []
        for col in columns:
            key, _, _ = col[0], col[1], col[2]
            formatter = col[3] if len(col) > 3 else None
            raw_val = row.get(key, "")
            val = formatter(raw_val) if formatter else str(raw_val)
            cells.append(Paragraph(val, styles["AIPMCell"]))
        data.append(cells)
    total_width = 7.0 * inch
    col_widths = [total_width * c[2] for c in columns]
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


# Goals table columns are shared between the standalone Goals doc and the Combined doc.
GOALS_COLUMNS = [
    ("goal", "Goal", 0.32),
    ("smart_evaluation", "SMART (S/M/A/R/T)", 0.16, format_smart_evaluation),
    ("missing_elements", "Missing Elements", 0.22, lambda v: "; ".join(v) if isinstance(v, list) else str(v or "")),
    ("notes_or_missing_measurables", "Notes", 0.30),
]


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
    story.append(_table_from_dicts(data.get("goals", []), GOALS_COLUMNS, styles))
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
    story.append(_table_from_dicts(data.get("goals", []), GOALS_COLUMNS, styles))
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
            fname = f if isinstance(f, str) else getattr(f, "name", "uploaded file")
            fname = os.path.basename(fname)
            extra_text += f"\n\n[Extracted from {fname}]\n{extracted}"

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

    data = validate_coverage(data)

    try:
        pdfs = build_all_pdfs(run_dir, project_name, data)
    except Exception as e:
        return (f"⚠ Document rendering failed: {e}", None, None, None, None, None, None, None)

    # Structured handoff package for Agent 2 (Planning) and eventually Agent 3 (Execution)
    handoff = {
        "handoff_type": "goals_and_scope_output",
        "handoff_version": HANDOFF_VERSION,
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

def _guess_mimetype(path):
    """Small hardening addition over v4.0: the /download fallback used to hardcode
    application/pdf even for the .json handoff package. Only matters when Firebase
    isn't configured and /download is actually serving files."""
    return "application/json" if path.lower().endswith(".json") else "application/pdf"


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
        mimetype=_guess_mimetype(path),
    )


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok", "firebase": _firebase_ready, "agent_version": AGENT_VERSION}), 200


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