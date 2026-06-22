from openai import OpenAI
from reportlab.lib.pagesizes import LETTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from PyPDF2 import PdfReader
from io import BytesIO
import docx
import gradio as gr
import os
import threading
import json
import uuid
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS

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
    Upload a local PDF to Firebase Storage and return a PERMANENT,
    browser-fetchable download URL.

    FIX (replaces the gs:// URI approach): a gs:// URI can only be resolved
    by the Firebase Admin/Client SDK (e.g. getBytes() in ProjectLibrary.jsx).
    It can't be passed to a plain fetch()/<a href> in RunView.jsx or
    GoalsAndScope.jsx. Signed URLs were also tried but expire after 7 days.

    The fix: attach a Firebase Storage download token to the blob's
    metadata. That produces a URL of the form:
      https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
    This URL:
      - never expires
      - works with uniform bucket-level access (no ACL/public changes needed)
      - is fetchable directly via fetch()/<a href> from the browser
      - is also still resolvable via the SDK using the returned storage path,
        so ProjectLibrary.jsx's getBytes() strategy keeps working unchanged.

    Returns (permanent_url, storage_path). Falls back to (local_path, None)
    if Firebase isn't configured (so /download keeps working for that
    session only, same as before).
    """
    if not init_firebase():
        return local_path, None   # fallback — /download endpoint works while server is alive

    try:
        filename    = os.path.basename(local_path)
        destination = f"generated-docs/{project_name.replace(' ', '_')}/{uuid.uuid4().hex}_{filename}"

        bucket_obj = fb_storage.bucket()
        blob       = bucket_obj.blob(destination)
        blob.upload_from_filename(local_path, content_type="application/pdf")

        # Attach a Firebase download token → permanent, browser-accessible
        # URL. No expiry. No ACL/public-access changes needed — this works
        # fine even with uniform bucket-level access enabled.
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


# ── App setup ───────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


# ── Health server (port 8081) ───────────────────────────────────
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, format, *args):
        pass

threading.Thread(target=lambda: HTTPServer(("0.0.0.0", 8081), HealthHandler).serve_forever(), daemon=True).start()


# ── Helpers ─────────────────────────────────────────────────────
def extract_text_from_file(uploaded_file):
    name = getattr(uploaded_file, "name", "uploaded_file").lower()
    if hasattr(uploaded_file, "data"):
        data = uploaded_file.data
    elif isinstance(uploaded_file, bytes):
        data = uploaded_file
    elif isinstance(uploaded_file, str):
        with open(uploaded_file, "rb") as f:
            data = f.read()
    else:
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


def create_pdf(project_name: str, doc_title: str, content: str) -> str:
    """Create PDF in /tmp and return its local path."""
    styles    = getSampleStyleSheet()
    file_path = f"/tmp/{project_name.replace(' ', '_')}_{doc_title.replace(' ', '_')}.pdf"
    doc       = SimpleDocTemplate(file_path, pagesize=LETTER)
    story     = [
        Paragraph(project_name, styles["Title"]),
        Spacer(1, 8),
        Paragraph(doc_title, styles["Heading2"]),
        Spacer(1, 12),
        Paragraph(content.replace("\n", "<br/>"), styles["Normal"]),
    ]
    doc.build(story)
    return file_path


# ── Core generation ─────────────────────────────────────────────
def generate_documents(project_name, problem, summary, long_desc, uploads):
    extra_text = ""
    if uploads:
        for f in uploads:
            extracted = extract_text_from_file(f)
            extra_text += f"\n\n[Extracted from {f.name}]\n{extracted}"

    if not any([project_name, problem, summary, long_desc, extra_text]):
        return "⚠ Please provide project details or upload documents.", None, None, None, None, None

    context = f"""Project: {project_name}

Problem Being Solved:
{problem}

High‑Level Summary:
{summary}

Detailed Description / Requirements:
{long_desc}

Uploaded Documents Content:
{extra_text[:8000]}

Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
"""
    prompts = {
        "Goals Document":                   f"{context}\nGenerate SMART goals for this project.",
        "Scope Document":                   f"{context}\nWrite a clear Project Scope statement (Inclusions, Exclusions, Assumptions, Constraints).",
        "Risk Document":                    f"{context}\nIdentify key project risks with Impact, Likelihood, and Mitigation strategies.",
        "Proposed Milestones Document":     f"{context}\nList proposed milestones with deliverables and target dates.",
        "Resource Teams Required Document": f"{context}\nIdentify resource teams required with roles, skills, and estimated effort.",
    }

    pdfs = {}
    for title, prompt in prompts.items():
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are an AI Project Manager creating concise project documentation."},
                {"role": "user",   "content": prompt},
            ],
        )
        content    = completion.choices[0].message.content
        local_path = create_pdf(project_name, title, content)

        # Upload to Firebase Storage → get a PERMANENT, browser-fetchable URL
        permanent_url, storage_path = upload_to_storage(local_path, project_name, title)

        # Store both url and path:
        #   url  → real https://firebasestorage.googleapis.com/... link,
        #          fetchable directly by RunView.jsx / GoalsAndScope.jsx
        #   path → storage path, used by ProjectLibrary.jsx's SDK getBytes()
        #          and for deleting the file from Storage later
        pdfs[title] = {
            "url":  permanent_url,
            "path": storage_path,   # None only when using /tmp fallback
        }

    return (
        f"✅ Documents generated successfully for '{project_name}'!",
        pdfs["Goals Document"],
        pdfs["Scope Document"],
        pdfs["Risk Document"],
        pdfs["Proposed Milestones Document"],
        pdfs["Resource Teams Required Document"],
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
    Fallback download endpoint — only used when Firebase Storage is not
    configured and files are still on the Railway /tmp filesystem (i.e.
    same session). Once Firebase is configured, generate_documents()
    returns a permanent firebasestorage.googleapis.com URL instead, and
    this endpoint is never hit for new runs.
    """
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


# ── Gradio UI ────────────────────────────────────────────────────
with gr.Blocks(title="AIPM – Monte Turner's AI Project Manager") as demo:
    gr.HTML("<div style='text-align:center'><h1>📄 AIPM – AI Project Manager Enhanced</h1>"
            "<p>Generate SMART Goals | Scope | Risk | Milestones | Resources</p></div>")
    with gr.Row():
        with gr.Column(scale=1):
            project_name = gr.Textbox(label="Project Name (short)", placeholder="e.g. Jocksalot Fan", lines=1)
            problem      = gr.Textbox(label="What Problem is Being Solved?", lines=3)
            summary      = gr.Textbox(label="High‑Level Summary (1–2 sentences)", lines=2)
            long_desc    = gr.Textbox(label="Longer Description / Requirements", lines=10)
            uploads      = gr.File(label="Upload Documents (PDF / DOCX / TXT)", file_count="multiple")
            submit_btn   = gr.Button("🚀 Generate Documents", variant="primary")
        with gr.Column(scale=1):
            status         = gr.Textbox(label="Status Message")
            pdf_goals      = gr.File(label="Goals Document (Download)")
            pdf_scope      = gr.File(label="Scope Document (Download)")
            pdf_risk       = gr.File(label="Risk Document (Download)")
            pdf_milestones = gr.File(label="Proposed Milestones Document (Download)")
            pdf_resources  = gr.File(label="Resource Teams Required Document (Download)")
    submit_btn.click(
        fn=generate_documents,
        inputs=[project_name, problem, summary, long_desc, uploads],
        outputs=[status, pdf_goals, pdf_scope, pdf_risk, pdf_milestones, pdf_resources],
        show_progress=True
    )
    gr.HTML("<p style='text-align:center;color:gray;font-size:12px;'>© 2026 Caveman Productions Media – AIPM v1.2 Enhanced</p>")


if __name__ == "__main__":
    def run_gradio():
        demo.launch(
            server_name="127.0.0.1",
            server_port=7860,
            share=False,
            quiet=True,
            theme=gr.themes.Soft(primary_hue="blue", neutral_hue="gray")
        )

    threading.Thread(target=run_gradio, daemon=True).start()

    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)