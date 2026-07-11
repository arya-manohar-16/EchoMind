(() => {
  "use strict";

  // Fallback in case /api/stages can't be reached — keep this in sync with
  // backend/pipeline_runner.py's STAGES list.
  const FALLBACK_STAGES = [
    ["queued", "Queued", 0],
    ["downloading", "Fetching audio", 8],
    ["transcribing", "Transcribing", 35],
    ["titling", "Titling", 55],
    ["summarizing", "Summarizing", 65],
    ["actions", "Action items", 78],
    ["decisions", "Decisions", 86],
    ["questions", "Open questions", 93],
    ["indexing", "Indexing", 97],
    ["ready", "Ready", 100],
  ].map(([key, label, progress]) => ({ key, label, progress }));

  // stage key -> ring/core color on the sonar visual
  const STAGE_TONE = {
    queued: "teal",
    downloading: "teal",
    transcribing: "violet",
    titling: "violet",
    summarizing: "violet",
    actions: "amber",
    decisions: "amber",
    questions: "amber",
    indexing: "amber",
    ready: "teal",
    error: "coral",
  };

  const el = (id) => document.getElementById(id);

  const form = el("jobForm");
  const sourceInput = el("sourceInput");
  const submitBtn = el("submitBtn");
  const formHint = el("formHint");
  const langButtons = Array.from(document.querySelectorAll(".lang-option"));

  const heroVisual = document.querySelector(".hero-visual");
  const sonarCaption = el("sonarCaption");

  const pipelineSection = el("pipelineSection");
  const pipelineStatusText = el("pipelineStatusText");
  const trackerFill = el("trackerFill");
  const trackerNodes = el("trackerNodes");
  const errorBanner = el("errorBanner");
  const errorMessage = el("errorMessage");
  const retryBtn = el("retryBtn");

  const resultsSection = el("resultsSection");
  const resultTitle = el("resultTitle");
  const summaryBody = el("summaryBody");
  const actionsBody = el("actionsBody");
  const decisionsBody = el("decisionsBody");
  const questionsBody = el("questionsBody");
  const transcriptBody = el("transcriptBody");

  const chatDock = el("chatDock");
  const chatToggle = el("chatToggle");
  const chatStatusDot = el("chatStatusDot");
  const chatMessages = el("chatMessages");
  const chatForm = el("chatForm");
  const chatInput = el("chatInput");
  const chatSend = el("chatSend");
  const engineBadge = el("engineBadge");

  let stages = FALLBACK_STAGES;
  let selectedLanguage = "english";
  let currentJobId = null;
  let socket = null;

  // ---------------------------------------------------------------------
  // Stage list / tracker
  // ---------------------------------------------------------------------

  async function loadStages() {
    try {
      const res = await fetch("/api/stages");
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      if (Array.isArray(data.stages) && data.stages.length) stages = data.stages;
    } catch (_) {
      stages = FALLBACK_STAGES; // backend not reachable yet — fine, use fallback
    }
    buildTracker();
  }

  function buildTracker() {
    trackerNodes.innerHTML = "";
    // Skip "queued" and "ready" as visible nodes — they're the start/end states,
    // the line itself communicates start and finish.
    const visible = stages.filter((s) => s.key !== "queued" && s.key !== "ready");
    visible.forEach((stage) => {
      const li = document.createElement("li");
      li.dataset.key = stage.key;
      li.innerHTML = `<span class="tracker-dot"></span><span class="tracker-label">${stage.label}</span>`;
      trackerNodes.appendChild(li);
    });
  }

  function updateTracker(currentKey, progress) {
    trackerFill.style.width = `${progress}%`;
    const currentIndex = stages.findIndex((s) => s.key === currentKey);
    Array.from(trackerNodes.children).forEach((li) => {
      const key = li.dataset.key;
      const idx = stages.findIndex((s) => s.key === key);
      li.classList.remove("is-done", "is-active");
      if (idx < currentIndex || currentKey === "ready") li.classList.add("is-done");
      else if (idx === currentIndex) li.classList.add("is-active");
    });
  }

  // ---------------------------------------------------------------------
  // Sonar visual
  // ---------------------------------------------------------------------

  function setSonar(stageKey, message, active) {
    const tone = STAGE_TONE[stageKey] || "teal";
    heroVisual.dataset.tone = tone;
    heroVisual.dataset.active = active ? "true" : "false";
    sonarCaption.textContent = message;
  }

  // ---------------------------------------------------------------------
  // Language toggle
  // ---------------------------------------------------------------------

  langButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      langButtons.forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");
      selectedLanguage = btn.dataset.lang;
      engineBadge.textContent = selectedLanguage === "hinglish" ? "Sarvam AI engine" : "Whisper engine";
    });
  });

  // ---------------------------------------------------------------------
  // Job submission
  // ---------------------------------------------------------------------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = sourceInput.value.trim();
    if (!source) return;
    await startJob(source, selectedLanguage);
  });

  retryBtn.addEventListener("click", () => {
    const source = sourceInput.value.trim();
    if (source) startJob(source, selectedLanguage);
  });

  async function startJob(source, language) {
    setFormBusy(true);
    hideError();
    resultsSection.hidden = true;
    pipelineSection.hidden = false;
    resetChat();
    updateTracker("downloading", 2);
    setSonar("downloading", "Fetching the video…", true);
    pipelineStatusText.textContent = "Queued…";

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, language }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "Couldn't start the job.");
      }
      const data = await res.json();
      currentJobId = data.job_id;
      connectSocket(currentJobId);
    } catch (err) {
      setFormBusy(false);
      showFormError(err.message || "Something went wrong starting the job.");
      setSonar("error", "Couldn't start", false);
    }
  }

  function connectSocket(jobId) {
    if (socket) socket.close();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}/ws/jobs/${jobId}`);

    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      pipelineStatusText.textContent = data.message || "";
      updateTracker(data.status, data.progress || 0);
      setSonar(data.status, data.message || "", data.status !== "ready" && data.status !== "error");

      if (data.status === "ready" && data.result) {
        onJobReady(data.result);
      } else if (data.status === "error") {
        onJobError(data.error);
      }
    });

    socket.addEventListener("error", () => {
      // WebSocket hiccup — poll once as a fallback so the UI doesn't hang.
      pollJobOnce(jobId);
    });
  }

  async function pollJobOnce(jobId) {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const data = await res.json();
      updateTracker(data.status, data.progress || 0);
      pipelineStatusText.textContent = data.message || "";
      if (data.status === "ready" && data.result) onJobReady(data.result);
      else if (data.status === "error") onJobError(data.error);
    } catch (_) {
      /* nothing more we can do client-side */
    }
  }

  function onJobReady(result) {
    setFormBusy(false);
    setSonar("ready", "Ready — ask away", false);

    resultTitle.textContent = result.title || "Untitled recording";
    summaryBody.textContent = result.summary || "—";
    actionsBody.textContent = result.action_items || "—";
    decisionsBody.textContent = result.key_decisions || "—";
    questionsBody.textContent = result.open_questions || "—";
    transcriptBody.textContent = result.transcript || "—";

    resultsSection.hidden = false;
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    enableChat();
  }

  function onJobError(error) {
    setFormBusy(false);
    const stageLabel = error && error.stage ? ` (during "${error.stage}")` : "";
    showPipelineError(`${(error && error.message) || "Unknown error"}${stageLabel}`);
    setSonar("error", "Something went wrong", false);
  }

  function setFormBusy(isBusy) {
    submitBtn.disabled = isBusy;
    sourceInput.disabled = isBusy;
    submitBtn.querySelector("span").textContent = isBusy ? "Listening…" : "Listen to it";
  }

  function showFormError(message) {
    formHint.textContent = message;
    formHint.classList.add("is-error");
  }
  function hideError() {
    formHint.textContent = "Paste a public YouTube URL to start. Local file paths work too if the backend can reach them.";
    formHint.classList.remove("is-error");
    errorBanner.hidden = true;
  }
  function showPipelineError(message) {
    errorMessage.textContent = message;
    errorBanner.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Chat dock
  // ---------------------------------------------------------------------

  chatToggle.addEventListener("click", () => {
    const isOpen = chatDock.classList.toggle("is-open");
    chatToggle.setAttribute("aria-expanded", String(isOpen));
  });

  function enableChat() {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatStatusDot.classList.add("is-ready");
    chatDock.classList.add("is-open");
    chatToggle.setAttribute("aria-expanded", "true");
  }

  function resetChat() {
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatStatusDot.classList.remove("is-ready");
    chatMessages.innerHTML = `<div class="chat-msg chat-msg-system">Once this video finishes processing, ask it anything — "what did we decide about the launch date?", "who owns the follow-up?"</div>`;
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = chatInput.value.trim();
    if (!question || !currentJobId) return;

    appendMessage("user", question);
    chatInput.value = "";
    chatInput.disabled = true;
    chatSend.disabled = true;

    const typingEl = appendMessage("ai-typing", "Listening back through the transcript…");

    try {
      const res = await fetch(`/api/jobs/${currentJobId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      typingEl.remove();
      if (!res.ok) {
        appendMessage("ai", data.detail || "Couldn't get an answer for that.");
      } else {
        appendMessage("ai", data.answer);
      }
    } catch (err) {
      typingEl.remove();
      appendMessage("ai", "Lost the connection while answering — try again.");
    } finally {
      chatInput.disabled = false;
      chatSend.disabled = false;
      chatInput.focus();
    }
  });

  function appendMessage(kind, text) {
    const div = document.createElement("div");
    if (kind === "user") div.className = "chat-msg chat-msg-user";
    else if (kind === "ai-typing") div.className = "chat-msg chat-msg-ai is-typing";
    else div.className = "chat-msg chat-msg-ai";
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  loadStages();
})();
