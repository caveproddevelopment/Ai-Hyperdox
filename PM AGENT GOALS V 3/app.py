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
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, format, *args):
        pass

def run_health_server():
    server = HTTPServer(("0.0.0.0", 8081), HealthHandler)
    server.serve_forever()

threading.Thread(target=run_health_server, daemon=True).start()

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

def create_pdf(project_name, doc_title, content):
    styles = getSampleStyleSheet()
    file_path = f"/tmp/{project_name.replace(' ', '_')}_{doc_title.replace(' ', '_')}.pdf"
    doc = SimpleDocTemplate(file_path, pagesize=LETTER)
    story = [
        Paragraph(f"{project_name}", styles["Title"]),
        Spacer(1, 8),
        Paragraph(f"{doc_title}", styles["Heading2"]),
        Spacer(1, 12),
        Paragraph(content.replace("\n", "<br/>"), styles["Normal"]),
    ]
    doc.build(story)
    return file_path

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
        "Goals Document": f"{context}\nGenerate SMART goals for this project.",
        "Scope Document": f"{context}\nWrite a clear Project Scope statement (Inclusions, Exclusions, Assumptions, Constraints).",
        "Risk Document": f"{context}\nIdentify key project risks with Impact, Likelihood, and Mitigation strategies.",
        "Proposed Milestones Document": f"{context}\nList proposed milestones with deliverables and target dates.",
        "Resource Teams Required Document": f"{context}\nIdentify resource teams required with roles, skills, and estimated effort.",
    }
    pdfs = {}
    for title, prompt in prompts.items():
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are an AI Project Manager creating concise project documentation."},
                {"role": "user", "content": prompt},
            ],
        )
        content = completion.choices[0].message.content
        pdfs[title] = create_pdf(project_name, title, content)
    return (
        f"✅ Documents generated successfully for '{project_name}'!",
        pdfs["Goals Document"],
        pdfs["Scope Document"],
        pdfs["Risk Document"],
        pdfs["Proposed Milestones Document"],
        pdfs["Resource Teams Required Document"],
    )

with gr.Blocks(
    title="AIPM – Monte Turner's AI Project Manager",
    queue=True
) as demo:
    gr.HTML("<div style='text-align:center'><h1>📄 AIPM – AI Project Manager Enhanced</h1>"
            "<p>Generate SMART Goals | Scope | Risk | Milestones | Resources</p></div>")
    with gr.Row():
        with gr.Column(scale=1):
            project_name = gr.Textbox(label="Project Name (short)", placeholder="e.g. Jocksalot Fan", lines=1)
            problem = gr.Textbox(label="What Problem is Being Solved?", lines=3)
            summary = gr.Textbox(label="High‑Level Summary (1–2 sentences)", lines=2)
            long_desc = gr.Textbox(label="Longer Description / Requirements", lines=10)
            uploads = gr.File(label="Upload Documents (PDF / DOCX / TXT)", file_count="multiple")
            submit_btn = gr.Button("🚀 Generate Documents", variant="primary")
        with gr.Column(scale=1):
            status = gr.Textbox(label="Status Message")
            pdf_goals = gr.File(label="Goals Document (Download)")
            pdf_scope = gr.File(label="Scope Document (Download)")
            pdf_risk = gr.File(label="Risk Document (Download)")
            pdf_milestones = gr.File(label="Proposed Milestones Document (Download)")
            pdf_resources = gr.File(label="Resource Teams Required Document (Download)")
    submit_btn.click(
        fn=generate_documents,
        inputs=[project_name, problem, summary, long_desc, uploads],
        outputs=[status, pdf_goals, pdf_scope, pdf_risk, pdf_milestones, pdf_resources],
        show_progress=True
    )
    gr.HTML("<p style='text-align:center;color:gray;font-size:12px;'>© 2026 Caveman Productions Media – AIPM v1.2 Enhanced</p>")

if __name__ == "__main__":
    demo.launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", 8080)),
        inactivity_timeout=None,
        show_error=True
    )