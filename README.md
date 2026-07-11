<div align="center">

# 🎙️ EchoMind

**Point it at a video. Get the meeting back.**

EchoMind turns any YouTube video (or local recording) into a searchable, question-answerable knowledge base — automatically transcribed, summarized, and broken into action items, decisions, and open questions, with a RAG-powered chat interface to ask it anything the recording said.

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![LangChain](https://img.shields.io/badge/LangChain-LCEL-1C3C3C?logo=langchain&logoColor=white)](https://www.langchain.com/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Whisper](https://img.shields.io/badge/OpenAI-Whisper-412991?logo=openai&logoColor=white)](https://github.com/openai/whisper)
[![ChromaDB](https://img.shields.io/badge/ChromaDB-Vector%20Store-FF6F61)](https://www.trychroma.com/)
</div>

---

## What it does

Give EchoMind a YouTube link. It will:

1. **Download & chunk** the audio (`yt-dlp` + `pydub`)
2. **Transcribe** it — locally via Whisper (English) or via the Sarvam AI speech API (Hinglish)
3. **Generate a title** and a **structured summary** of the recording
4. **Extract** action items, key decisions, and open questions as clean, formatted lists
5. **Embed and index** the transcript into a Chroma vector store
6. **Let you ask it questions** — a LangChain RAG pipeline answers strictly from the transcript, with source-grounded responses

It's usable two ways: as a **CLI** (`main.py`) or through a **full web app** (FastAPI backend + a live-status, animated frontend) that streams processing progress in real time and unlocks a chat panel once the video is ready.

---

## Demo flow

```
  YouTube URL
       │
       ▼
 ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
 │  Download    │ →  │ Transcribe   │ →  │ Summarize +  │
 │  & chunk     │    │ (Whisper /   │    │ extract      │
 │  audio       │    │  Sarvam AI)  │    │ (Mistral AI) │
 └─────────────┘    └──────────────┘    └─────────────┘
                                                │
                                                ▼
                                       ┌─────────────────┐
                                       │ Embed + index    │
                                       │ (ChromaDB)        │
                                       └─────────────────┘
                                                │
                                                ▼
                                       💬 Ask it anything
```

---

## Tech stack

| Layer | Tech |
|---|---|
| Orchestration | [LangChain](https://www.langchain.com/) (LCEL pipelines) |
| LLM | [Mistral AI](https://mistral.ai/) (`mistral-small-latest`) |
| Transcription | [OpenAI Whisper](https://github.com/openai/whisper) (local) · [Sarvam AI](https://www.sarvam.ai/) (Hinglish) |
| Vector store | [ChromaDB](https://www.trychroma.com/) + HuggingFace `all-MiniLM-L6-v2` embeddings |
| Audio pipeline | `yt-dlp`, `pydub`, `ffmpeg` |
| Backend API | [FastAPI](https://fastapi.tiangolo.com/) + WebSockets (live progress streaming) |
| Frontend | Vanilla HTML / CSS / JS — no build step |

---

## Project structure

```
EchoMind/
├── core/
│   ├── transcriber.py      # Whisper / Sarvam AI transcription
│   ├── summarize.py        # title + summary generation
│   ├── extractor.py        # action items / decisions / questions
│   ├── rag.py               # RAG chain: build + query
│   └── vector_store.py     # Chroma embedding + retrieval
├── utils/
│   └── audio_processor.py  # download, convert, chunk audio
├── backend/
│   ├── app.py               # FastAPI server (REST + WebSocket)
│   └── pipeline_runner.py  # staged pipeline with progress events
├── frontend/
│   ├── index.html
│   └── static/
│       ├── style.css        # sonar/echo-themed UI
│       └── app.js
├── main.py                  # CLI entry point
└── requirements.txt
```

---

## Getting started

### Prerequisites

- Python 3.10+
- `ffmpeg` installed and on your PATH
- A [Mistral AI](https://mistral.ai/) API key
- A [Sarvam AI](https://www.sarvam.ai/) API key *(optional — only needed for Hinglish transcription)*

### 1. Clone & install

```bash
git clone https://github.com/arya-manohar-16/EchoMind.git
cd EchoMind
pip install -r requirements.txt
pip install -r backend/requirements-backend.txt   # only needed for the web app
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
MISTRAL_API_KEY=your_mistral_key_here
SARVAM_API_KEY=your_sarvam_key_here
WHISPER_MODEL=small
```

### 3. Run it

**As a CLI:**
```bash
python main.py
```

**As a web app:**
```bash
uvicorn backend.app:app --reload --port 8000
```
Then open **http://localhost:8000**.

---

## How the web app works

- `POST /api/jobs` kicks off the pipeline on a background thread for a given `{source, language}`
- `WS /ws/jobs/{id}` streams live status — which stage is running, progress %, and the final result — so the frontend can animate a stage tracker in real time
- `POST /api/jobs/{id}/chat` answers questions against that job's transcript via the RAG chain
- The frontend is a single-page app with no framework: a sonar-style visual reflects the active pipeline stage, a waveform tracker fills as processing advances, and a docked chat panel unlocks once the index is ready

---

## Roadmap

- [ ] Multi-file / batch processing
- [ ] Export summary + action items to PDF
- [ ] Speaker diarization
- [ ] Persistent job history (currently in-memory, per session)

---

<div align="center">
Built by <a href="https://github.com/arya-manohar-16">Arya Manohar</a>
</div>
