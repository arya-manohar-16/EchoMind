"""
EchoMind pipeline runner.

Wraps the *existing* core/ and utils/ modules with stage-by-stage progress
reporting, so the FastAPI layer can push live status updates to the
frontend over a WebSocket.

Nothing in core/ or utils/ needs to change for this to work.
"""

from typing import Callable

from utils.audio_processor import process_input
from core.transcriber import transcribe_all
from core.summarize import summarize, generate_title
from core.extractor import extract_actions_items, extract_key_decisions, extract_questions
from core.rag import build_rag_chain, ask_question

# Ordered pipeline stages: (key, label, progress %).
# This is the single source of truth for stage order/labels — both the
# backend (to report status) and the frontend (via GET /api/stages) read
# from this list, so they can never drift out of sync.
STAGES = [
    ("queued",       "Queued",                          0),
    ("downloading",  "Fetching & chunking audio",        8),
    ("transcribing", "Transcribing speech",             35),
    ("titling",      "Generating title",                55),
    ("summarizing",  "Summarizing the recording",       65),
    ("actions",      "Extracting action items",         78),
    ("decisions",    "Extracting key decisions",        86),
    ("questions",    "Extracting open questions",       93),
    ("indexing",     "Building the searchable index",   97),
    ("ready",        "Ready",                          100),
]

STAGE_LABELS = {key: label for key, label, _ in STAGES}
STAGE_PROGRESS = {key: pct for key, _, pct in STAGES}


class PipelineError(Exception):
    """Raised when a pipeline stage fails; carries which stage failed."""

    def __init__(self, stage: str, message: str):
        self.stage = stage
        self.message = message
        super().__init__(message)


def run_pipeline(source: str, language: str, on_update: Callable[[str, str, int], None]) -> dict:
    """
    Runs the EchoMind pipeline end-to-end, calling
    on_update(stage_key, detail_message, progress_pct) as each stage starts.

    Returns a dict shaped like main.run_pipeline()'s return value:
    title, transcript, summary, action_items, key_decisions,
    open_questions, rag_chain.
    """

    def report(stage: str, detail: str = ""):
        on_update(stage, detail or STAGE_LABELS[stage], STAGE_PROGRESS[stage])

    try:
        report("downloading", "Downloading / reading source and chunking audio…")
        chunks = process_input(source)

        report("transcribing", f"Transcribing {len(chunks)} audio chunk(s)…")
        transcript = transcribe_all(chunks, language=language)

        if not transcript.strip():
            raise PipelineError(
                "transcribing",
                "Transcription came back empty — the audio may be silent, "
                "music-only, or in an unsupported language.",
            )

        report("titling", "Writing a title for this recording…")
        title = generate_title(transcript)

        report("summarizing", "Summarizing the full transcript…")
        summary = summarize(transcript)

        report("actions", "Pulling out action items…")
        action_items = extract_actions_items(transcript)

        report("decisions", "Pulling out key decisions…")
        decisions = extract_key_decisions(transcript)

        report("questions", "Pulling out open questions…")
        questions = extract_questions(transcript)

        report("indexing", "Embedding the transcript and building the vector index…")
        rag_chain = build_rag_chain(transcript)

        report("ready", "Ready — ask away.")

        return {
            "title": title,
            "transcript": transcript,
            "summary": summary,
            "action_items": action_items,
            "key_decisions": decisions,
            "open_questions": questions,
            "rag_chain": rag_chain,
        }

    except PipelineError:
        raise
    except Exception as e:
        raise PipelineError("unknown", f"{type(e).__name__}: {e}") from e


def run_chat(rag_chain, question: str) -> str:
    return ask_question(rag_chain, question)
