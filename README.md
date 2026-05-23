# Enterprise Knowledge Agent

An intelligent enterprise knowledge base Agent built with LangGraph, featuring **summary-based routing + on-demand loading** — no vector database needed, achieving 90%+ token savings.

> Deployed on [EdgeOne Pages](https://edgeone.ai/pages) | [中文文档](./README.zh-CN.md)

## Core Concept

Traditional knowledge base solutions require vectorizing all documents into a vector database, scanning all embeddings on every query. This project takes a fundamentally different approach:

```
User Question
    ↓
Agent reads [Document Summary Layer] (lightweight, ~200 words each)
    ↓
LLM autonomously decides: which 1-2 documents likely contain the answer
    ↓
On-demand loading of selected document's full content
    ↓
Generate answer (unselected documents = zero token cost)
```

## Architecture

```
┌─────────────────── LangGraph StateGraph ───────────────────┐
│                                                             │
│   START → [Router] → [Load Docs] → [Generate Answer] → END │
│              │              │                                │
│        Read summaries   Load full text                       │
│        (all docs)      (selected 1-2 only)                  │
└─────────────────────────────────────────────────────────────┘

Storage Layer (EdgeOne Pages Blob):
  summary/{docId}.json  →  Document summary + keywords
  docs/{docId}.txt      →  Full document content
```

## Comparison with Traditional RAG

| Dimension | Traditional RAG (Vector Search) | This Approach (Summary Routing) |
|-----------|--------------------------------|-------------------------------|
| Vector Database | Required (Pinecone/Weaviate/Chroma) | **Not needed** |
| Embedding Computation | Full embedding on every upload | **Not needed** |
| Query Token Cost | High (Top-K chunks all sent to LLM) | **Low** (only selected docs) |
| Document Updates | Re-indexing required | **Just replace the file** |
| 100-doc scenario | ~8000 tokens/query | **~1200 tokens/query** |

## Features

- **Intelligent Routing** — LLM autonomously decides where to look based on summaries
- **Multi-format Support** — PDF, Word (.docx), Excel (.xlsx), PPT (.pptx), Markdown, TXT, CSV, JSON, LaTeX, code files
- **Three Import Methods** — Frontend drag & drop / Batch API / CLI script
- **Real-time Decision Visualization** — SSE streaming shows Agent routing process (which docs were selected and why)
- **EdgeOne Pages Deployment** — Serverless, zero ops

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Agent Framework | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) (StateGraph) |
| Frontend | Next.js 16 + React 19 + Tailwind CSS |
| LLM | EdgeOne AI Gateway (DeepSeek / GPT / etc.) |
| Storage | EdgeOne Pages Blob (no external database) |
| Document Parsing | pdf-parse + mammoth + xlsx + jszip |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

```env
AI_GATEWAY_BASE_URL=https://your-gateway.edgeone.ai/v1
AI_GATEWAY_API_KEY=your-api-key
AI_MODEL=@Pages/deepseek-v4-flash
```

### 3. Local Development

```bash
edgeone pages dev -t <your-token>
```

### 4. Batch Import Documents (Optional)

```bash
npx tsx scripts/import.ts ./your-docs-folder
```

### 5. Deploy

```bash
edgeone pages deploy
```

## Project Structure

```
├── agents/
│   ├── _shared.ts         # Shared utilities (Model, SSE, Logger)
│   ├── chat.ts            # Core: LangGraph on-demand retrieval Agent
│   ├── upload.ts          # Single file upload + summary generation
│   ├── batch-upload.ts    # Batch upload Agent (SSE progress)
│   ├── manage.ts          # Document management (list/delete)
│   └── stop.ts            # Abort running queries
├── lib/
│   ├── doc-store.ts       # Blob storage layer (list-based, no race conditions)
│   └── parser.ts          # Multi-format document parser
├── app/
│   ├── page.tsx           # Main page
│   └── components/
│       ├── chat-panel.tsx       # Chat interface (SSE streaming)
│       ├── upload-zone.tsx      # Drag & drop upload (binary file support)
│       └── document-list.tsx    # Document list (expandable summaries)
├── scripts/
│   └── import.ts          # CLI batch import script
└── edgeone.json           # EdgeOne Pages deployment config
```

## How It Works

### Upload Flow

```
File → parser.ts extracts text → AI Gateway generates summary + keywords → Blob storage
```

Supported: PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, JSON, TEX, code files

### Query Flow

```
Question → Router (read summaries, LLM selects docs) → Load Docs (on-demand) → Generate (cited answer)
```

SSE streams each node's execution status in real-time, showing the complete decision process in the frontend.

### Why No Vector Database?

1. **Summary layer is ultra-lightweight** — 200 words each, 100 docs = only 20K tokens total
2. **LLM comprehension > cosine similarity** — Semantic routing is more accurate than vector matching
3. **Truly on-demand** — Unselected documents = zero cost, unlike vector search which scans all embeddings

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | Intelligent Q&A (SSE streaming) |
| POST | `/upload` | Upload single document |
| POST | `/batch-upload` | Batch upload (SSE progress) |
| POST | `/manage` | List/delete documents |
| POST | `/stop` | Abort running query |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_BASE_URL` | Yes | EdgeOne AI Gateway URL |
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway API Key |
| `AI_MODEL` | No | Model name (default: `@Pages/deepseek-v4-flash`) |
| `PROJECT_ID` | No | Blob storage project ID (auto-injected on deploy) |
| `EDGEONE_PAGES_API_TOKEN` | No | Blob storage token (auto-injected on deploy) |

## License

MIT
