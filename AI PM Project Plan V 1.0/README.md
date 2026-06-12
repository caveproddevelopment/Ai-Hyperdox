---
title: AIPMAgent2
emoji: 🗂️
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 6.5.1
app_file: app.py
pinned: false
short_description: AIPM Agent 2 – Project Plan Documents
---

# AIPM Agent 2 – Project Plan Documents

Part of Monte Turner's *Be an AI PM* agent series under Caveman Productions Media.

## What This Does

Takes your milestones, timeline, resource list, and optional budget spreadsheet and generates four structured project planning PDFs — in either **Agile** or **Waterfall** methodology.

## Outputs

| Document | Description |
|---|---|
| **Work Breakdown Structure (WBS)** | Hierarchical task decomposition with WBS ID codes |
| **Project Timeline** | Phase/sprint table with Gantt-style summary |
| **Resource Allocation Plan** | Utilization table with over-allocation warnings |
| **Cost Management Plan** | Budget baseline, contingency, thresholds, and metrics |

## Agent Series

| Agent | Purpose |
|---|---|
| Agent 1 | Goals & Scope |
| **Agent 2** | **Project Plan Documents** ← you are here |
| Agent 3 | Risk & Issues |
| Agent 4 | Status Reporting |
| Agent 5 | Closeout & Lessons Learned |

## Setup

Set `OPENAI_API_KEY` as a Hugging Face Space secret (Settings → Repository Secrets).

## Stack
- Gradio 6.5.1
- OpenAI GPT-4o
- ReportLab (PDF generation)
- openpyxl (Excel budget parsing)

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference
