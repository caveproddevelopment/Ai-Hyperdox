from openai import OpenAI
from reportlab.lib.pagesizes import LETTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import inch
from PyPDF2 import PdfReader
from io import BytesIO
import docx
import gradio as gr
import os
import threading
import json
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS

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


def upload_to_storage(local_path: str, project_name: str, doc_title: str):
    """
    Upload a local PDF to Firebase Storage.
    Returns (url_or_path, storage_path).
    Falls back to (local_path, None) if Firebase is not configured.
    """
    if not init_firebase():
        return local_path, None

    try:
        filename    = os.path.basename(local_path)
        destination = f"generated-docs/{project_name.replace(' ', '_')}/{uuid.uuid4().hex}_{filename}"

        bucket_obj = fb_storage.bucket()
        blob       = bucket_obj.blob(destination)
        blob.upload_from_filename(local_path, content_type="application/pdf")

        # Uniform bucket-level access — no public ACLs/signed URLs.
        # Frontend downloads via Firebase SDK getBytes() using the storage path.
        url = f"gs://{bucket_obj.name}/{destination}"

        print(f"✅ Uploaded {filename} → {url}")
        return url, destination

    except Exception as e:
        print(f"⚠ Upload failed for {local_path}: {e}")
        return local_path, None


# ── App setup ───────────────────────────────────────────────────
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


# ── File extraction ────────────────────────────────────────────
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
        elif name.endswith(".csv"):
            text = data.decode("utf-8", errors="ignore")
        elif name.endswith(".xlsx") or name.endswith(".xls"):
            if XLSX_AVAILABLE:
                wb = openpyxl.load_workbook(BytesIO(data), data_only=True)
                for sheet in wb.worksheets:
                    text += f"\n[Sheet: {sheet.title}]\n"
                    for row in sheet.iter_rows(values_only=True):
                        row_text = "\t".join(
                            str(cell) if cell is not None else "" for cell in row
                        )
                        if row_text.strip():
                            text += row_text + "\n"
            else:
                text = "(openpyxl not installed — cannot read Excel file)"
        else:
            text = f"(Unsupported file type: {name})"
    except Exception as e:
        text = f"(Error reading {name}: {e})"
    return text.strip()


# ── PDF builder ───────────────────────────────────────────────
def create_pdf(project_name, doc_title, content):
    styles   = getSampleStyleSheet()
    safe_pn  = (project_name or "Project").replace(" ", "_")
    safe_dt  = doc_title.replace(" ", "_")
    filepath = f"/tmp/{safe_pn}_{safe_dt}.pdf"

    title_style = ParagraphStyle(
        "PPTitle", parent=styles["Title"],
        textColor=colors.HexColor("#1a3c6e"), fontSize=18
    )
    h2_style = ParagraphStyle(
        "PPH2", parent=styles["Heading2"],
        textColor=colors.HexColor("#2563eb"), fontSize=13
    )

    doc = SimpleDocTemplate(
        filepath, pagesize=LETTER,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.75*inch,  bottomMargin=0.75*inch,
    )
    story = [
        Paragraph(safe_pn.replace("_", " "), title_style),
        Spacer(1, 6),
        Paragraph(doc_title, h2_style),
        Spacer(1, 12),
        Paragraph(content.replace("\n", "<br/>"), styles["Normal"]),
    ]
    doc.build(story)
    return filepath


# ── GPT call (lazy client) ──────────────────────────────────────
def call_gpt(system_msg, user_prompt):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is not set.")
    _client = OpenAI(api_key=api_key)
    completion = _client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user",   "content": user_prompt},
        ],
    )
    return completion.choices[0].message.content


# ── Core generation ──────────────────────────────────────────────
def generate_project_plan(project_name, milestones, timeline, resources, budget_file, methodology):
    if not any([project_name, milestones, timeline, resources]):
        return ("⚠ Please provide at least a Project Name and some planning details.",
                None, None, None, None)

    budget_text = ""
    if budget_file is not None:
        budget_text = extract_text_from_file(budget_file)

    context = f"""Project: {project_name}
Methodology: {methodology}

Milestones:
{milestones or 'Not specified'}

High-Level Timeline:
{timeline or 'Not specified'}

Resource List:
{resources or 'Not specified'}

Budget / Financial Data:
{budget_text[:4000] if budget_text else 'Not provided'}

Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
"""

    system_msg = (
        "You are AIPM, an expert AI Project Manager from Monte Turner's 'Be an AI PM' series. "
        f"Apply {methodology} methodology throughout all outputs. "
        "Generate concise, professional, structured project planning documentation."
    )

    methodology_note = (
        "Use Agile sprint-based decomposition — organize by Epic → User Story → Task with Sprint assignments."
        if methodology == "Agile"
        else "Use classic Waterfall hierarchical WBS decomposition aligned to phase gates with sign-off points."
    )

    prompts = {
        "Work Breakdown Structure (WBS)": (
            f"{context}\n{methodology_note}\n\n"
            "Generate a complete Work Breakdown Structure (WBS).\n"
            "Structure: Level 1 = Major Phases, Level 2 = Deliverables, Level 3 = Work Packages/Tasks.\n"
            "Include WBS ID codes (1.0, 1.1, 1.1.1...).\n"
            "Format as a table: WBS ID | Task Name | Description | Owner | Est. Duration | Dependencies."
        ),
        "Project Timeline": (
            f"{context}\n\n"
            f"Create a detailed project timeline aligned to {methodology} principles.\n"
            "Include a Gantt-style text summary at the top.\n"
            "Then a table: Phase/Sprint | Task | Start Date | End Date | Duration | Milestone | Owner | Status.\n"
            "Agile: organize by Sprint/Iteration. Waterfall: organize by phase gates."
        ),
        "Resource Allocation Plan": (
            f"{context}\n\n"
            "Develop a Resource Allocation Plan.\n"
            "Table: Resource Name/Role | Type (Human/Tool/Budget) | Assigned Phase or Sprint | "
            "Allocation % | Est. Hours | Cost Rate (if known) | Notes.\n"
            "Include a resource utilization summary and flag any over-allocations."
        ),
        "Cost Management Plan": (
            f"{context}\n\n"
            "Develop a Cost Management Plan with these sections:\n"
            "1. Cost Baseline — itemized by phase or work package (table: Category | Est. Cost | Actual | Variance)\n"
            "2. Cost Estimation Method — how costs were derived\n"
            "3. Budget Contingency — recommended reserve %\n"
            "4. Cost Control Thresholds — variance triggers for escalation\n"
            "5. Reporting Cadence — who reviews costs and how often\n"
            "6. Cost Performance Metrics — CPI, SPI where applicable"
        ),
    }

    pdfs   = {}
    errors = []
    for title, prompt in prompts.items():
        try:
            content    = call_gpt(system_msg, prompt)
            local_path = create_pdf(project_name, title, content)
            url, storage_path = upload_to_storage(local_path, project_name, title)
            pdfs[title] = {"url": url, "path": storage_path}
        except Exception as e:
            errors.append(f"{title}: {e}")
            pdfs[title] = None

    if errors:
        status = "⚠ Errors occurred:\n" + "\n".join(errors)
    else:
        status = f"✅ All four Project Plan documents generated for '{project_name}'!"

    return (
        status,
        pdfs.get("Work Breakdown Structure (WBS)"),
        pdfs.get("Project Timeline"),
        pdfs.get("Resource Allocation Plan"),
        pdfs.get("Cost Management Plan"),
    )


# ── Flask REST API ───────────────────────────────────────────────
@app.route("/api/predict", methods=["POST"])
def api_predict():
    try:
        data       = request.json or {}
        input_data = data.get("data", [])

        if len(input_data) < 4:
            return jsonify({"error": "Missing required fields"}), 400

        project_name = input_data[0] or ""
        milestones    = input_data[1] or ""
        timeline      = input_data[2] or ""
        resources     = input_data[3] or ""
        budget_file   = input_data[4] if len(input_data) > 4 else None
        methodology   = input_data[5] if len(input_data) > 5 else "Agile"

        result = generate_project_plan(project_name, milestones, timeline, resources, budget_file, methodology)
        return jsonify({"data": result}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/download", methods=["GET"])
def download_file():
    path = request.args.get("path")
    if not path:
        abort(400, description="Missing 'path' query parameter.")
    if not path.startswith("/tmp/"):
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


# ── Gradio UI (optional local testing) ────────────────────────────
with gr.Blocks(
    title="AIPM – Project Plan Documents",
    theme=gr.themes.Soft(primary_hue="blue", neutral_hue="gray"),
) as demo:
    gr.HTML("<div style='text-align:center'><h1>🗂️ AIPM – Project Plan Documents</h1></div>")
    with gr.Row():
        with gr.Column(scale=1):
            project_name = gr.Textbox(label="Project Name", lines=1)
            methodology  = gr.Radio(choices=["Agile", "Waterfall"], value="Agile", label="Methodology")
            milestones   = gr.Textbox(label="Milestones", lines=6)
            timeline     = gr.Textbox(label="High-Level Timeline", lines=5)
            resources    = gr.Textbox(label="Resource List", lines=6)
            budget_file  = gr.File(label="Budget Spreadsheet", file_count="single")
            submit_btn   = gr.Button("🚀 Generate Project Plan Documents", variant="primary")
        with gr.Column(scale=1):
            status  = gr.Textbox(label="Status", lines=4)
            pdf_wbs = gr.JSON(label="WBS")
            pdf_tl  = gr.JSON(label="Project Timeline")
            pdf_ra  = gr.JSON(label="Resource Allocation Plan")
            pdf_cm  = gr.JSON(label="Cost Management Plan")
    submit_btn.click(
        fn=generate_project_plan,
        inputs=[project_name, milestones, timeline, resources, budget_file, methodology],
        outputs=[status, pdf_wbs, pdf_tl, pdf_ra, pdf_cm],
        show_progress=True,
    )


if __name__ == "__main__":
    def run_gradio():
        demo.launch(
            server_name="127.0.0.1",
            server_port=7860,
            share=False,
            quiet=True,
        )

    threading.Thread(target=run_gradio, daemon=True).start()

    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)