---
title: AIPMAgent2
emoji: 🗂️
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 6.5.1
app_file: app.py
pinned: false
short_description: Planning Agent (v2.0) — Agent 2 of 3
---

# AIPM — Planning Agent (v2.0)

Part of Monte Turner's *Be an AI PM* agent series under Caveman Productions Media.
Agent 2 of 3 in the AI Hyperdox pipeline: Goals & Scope → **Planning** → Execution.

## What This Does
Takes the Goals & Scope handoff package (optional upload) plus milestones, timeline,
resource list, and optional budget spreadsheet, and generates four structured project
planning PDFs — in either **Agile** or **Waterfall** methodology — plus a Backbone Plan
handoff package for the future Execution agent.

## What Changed in v2.0
- The actual persona/rigor system prompt is now what's sent to the model (see `agent.prompt.md`).
- **Ingests the Goals & Scope handoff JSON directly** — no more manually retyping milestones
  and resources from a PDF. Manual fields still work as overrides/additions.
- One structured JSON completion instead of four isolated calls: Timeline references real
  WBS IDs, Resource Allocation references real WBS phases, Cost Baseline maps to real WBS
  categories — instead of four disconnected generations.
- Anti-genericism guardrails matching Agent 1: missing/vague input becomes a flagged open
  question, not an invented placeholder.
- Produces a structured **Backbone Plan** handoff (`*_backbone_plan.json`) for Agent 3
  (Execution) to consume once it's built.
- Session-safe file naming, retries with backoff, input truncation guardrails.

## Outputs
| Document | Description |
|---|---|
| **Work Breakdown Structure (WBS)** | Hierarchical task decomposition with WBS ID codes |
| **Project Timeline** | Phase/sprint table with Gantt-style summary, tied to WBS IDs |
| **Resource Allocation Plan** | Utilization table with over-allocation warnings, tied to WBS |
| **Cost Management Plan** | Budget baseline (by WBS phase), contingency, thresholds, metrics |
| **Backbone Plan (.json)** | Machine-readable input for the future Execution agent |

## Agent Series
| Agent | Purpose |
|---|---|
| Agent 1 | Goals & Scope |
| **Agent 2** | **Planning** ← you are here |
| Agent 3 | Execution *(not yet built — see `agent.prompt.md` for its intended handoff contract)* |

## Setup
Set `OPENAI_API_KEY` as a Hugging Face Space secret (Settings → Repository Secrets).

## Stack
- Gradio 6.5.1
- OpenAI GPT-4o (JSON mode, temperature 0.3)
- ReportLab (PDF generation, real tables)
- openpyxl (Excel budget parsing)

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference
