---
title: AIPMAgent1
emoji: 🦀
colorFrom: indigo
colorTo: green
sdk: gradio
sdk_version: 6.5.1
app_file: app.py
pinned: false
short_description: Goals & Scope Agent (v4.0) — Agent 1 of 3
---

# AIPM — Goals & Scope Agent (v4.0)

Part of Monte Turner's *Be an AI PM* agent series under Caveman Productions Media.
Agent 1 of 3 in the AI Hyperdox pipeline: **Goals & Scope → Planning → Execution**.

## What This Does
Takes a rough project idea (problem statement, summary, requirements, optional uploaded
documents) and produces a governed set of Goals, Scope, Risks, Milestones, and Resource
Team requirements — plus a machine-readable handoff package the Planning agent consumes
directly.

## What Changed in v4.0
- The actual persona/rigor system prompt is now what's sent to the model (previously a
  placeholder one-liner was used instead — see `agent.prompt.md`).
- One structured JSON completion instead of five isolated calls, so sections cross-reference
  each other (Risks tie to Milestones, etc.) instead of being generated blind.
- Explicit anti-genericism guardrails: missing/vague input is flagged as an "open question"
  instead of getting papered over with placeholder content.
- Produces a structured **Handoff Package** (`*_handoff.json`) alongside the PDFs, so Agent 2
  (Planning) can ingest this agent's output directly instead of the user retyping a PDF.
- Session-safe file naming (no collisions between concurrent runs), retries with backoff,
  and input truncation guardrails.

## Outputs
| Document | Description |
|---|---|
| **Goals Document** | SMART goals table |
| **Scope Document** | Inclusions / Exclusions / Assumptions / Constraints |
| **Risk Document** | Risks tied to specific milestones, with impact/likelihood/mitigation |
| **Proposed Milestones Document** | Milestone table with owners, dates, dependencies |
| **Resource Teams Required Document** | Team/role table derived from milestones & scope |
| **Scope Guardrail Document (Combined)** | All of the above in one document, plus Open Questions |
| **Handoff Package (.json)** | Machine-readable input for the Planning agent |

## Agent Series
| Agent | Purpose |
|---|---|
| **Agent 1** | **Goals & Scope** ← you are here |
| Agent 2 | Planning |
| Agent 3 | Execution *(not yet built)* |

## Setup
Set `OPENAI_API_KEY` as a Hugging Face Space secret (Settings → Repository Secrets).

## Stack
- Gradio 6.5.1
- OpenAI GPT-4o (JSON mode, temperature 0.3)
- ReportLab (PDF generation, real tables)

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference
