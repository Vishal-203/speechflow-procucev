const $ = (id) => document.getElementById(id);
const state = { socket: null, audioContext: null, processor: null, source: null, stream: null,
  recording: false, startedAt: 0, timer: null, currentTranscript: "", history: [] };
const liveView = $("live-view"), historyView = $("history-view");

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3000);
}
function setStatus(message) { $("connection-status").textContent = message; }
function updateWordCount() {
  const words = $("live-transcript").value.trim().split(/\s+/).filter(Boolean).length;
  $("word-count").textContent = `${words} ${words === 1 ? "word" : "words"}`;
}
function formatDate(value) {
  if (!value) return "Date unavailable";
  return new Date(value).toLocaleString([], {dateStyle:"medium", timeStyle:"short"});
}
function showView(view) {
  const history = view === "history";
  liveView.classList.toggle("hidden", history); historyView.classList.toggle("hidden", !history);
  $("nav-live").classList.toggle("active", !history); $("nav-history").classList.toggle("active", history);
  $("page-title").textContent = history ? "Transcription history" : "Live transcription";
  if (history) loadHistory();
}
$("nav-live").addEventListener("click", () => showView("live"));
$("nav-history").addEventListener("click", () => showView("history"));
$("empty-start").addEventListener("click", () => showView("live"));
$("live-transcript").addEventListener("input", updateWordCount);

async function startRecording() {
  if (state.recording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Microphone access requires localhost or HTTPS."); return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({audio:{
      channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true
    }});
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await state.audioContext.resume();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    state.socket = new WebSocket(`${protocol}//${location.host}/ws/transcribe`);
    state.socket.binaryType = "arraybuffer";
    state.socket.onopen = () => {
      state.socket.send(JSON.stringify({sample_rate: state.audioContext.sampleRate}));
      state.source = state.audioContext.createMediaStreamSource(state.stream);
      // ScriptProcessor is deprecated but broadly supported; kept for a compact assignment demo.
      state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);
      state.processor.onaudioprocess = (event) => {
        if (!state.recording || state.socket?.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        // Send a copy; browser audio buffers are reused.
        state.socket.send(input.slice().buffer);
      };
      state.source.connect(state.processor);
      state.processor.connect(state.audioContext.destination);
      state.recording = true; state.startedAt = Date.now();
      $("record-button").classList.add("is-recording");
      $("record-button").setAttribute("aria-label", "Recording in progress");
      $("record-label").textContent = "Listening…";
      $("record-hint").textContent = "Speak clearly; transcript updates every few seconds";
      $("recording-badge").classList.add("live");
      $("recording-badge").innerHTML = "<i></i> RECORDING";
      $("stop-button").disabled = false; $("record-button").disabled = true;
      setStatus("Microphone active"); $("live-message").textContent = "Listening for speech…";
      state.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
        $("elapsed").textContent = `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
      }, 250);
    };
    state.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "partial") {
        state.currentTranscript = message.full_text || state.currentTranscript;
        $("live-transcript").value = state.currentTranscript;
        updateWordCount();
        $("live-message").textContent = message.language
          ? `Recognised language: ${message.language}` : "Transcript updated";
      } else if (message.type === "saved") {
        toast("Transcription saved to your history.");
        $("live-message").textContent = "Saved to history.";
      } else if (message.type === "empty") {
        toast(message.message || "No speech detected.");
      } else if (message.type === "error") {
        toast(message.message || "Transcription error.");
      }
    };
    state.socket.onerror = () => toast("WebSocket connection error. Check server logs.");
    state.socket.onclose = () => { setStatus("Connection closed"); };
  } catch (error) {
    console.error(error); toast(`Could not start microphone: ${error.message}`);
    await cleanupAudio();
  }
}
async function cleanupAudio() {
  state.recording = false; clearInterval(state.timer);
  try { state.processor?.disconnect(); state.source?.disconnect(); } catch {}
  state.stream?.getTracks().forEach(track => track.stop());
  if (state.audioContext && state.audioContext.state !== "closed") await state.audioContext.close();
  state.processor = state.source = state.stream = state.audioContext = null;
  $("record-button").classList.remove("is-recording");
  $("record-button").setAttribute("aria-label", "Start recording");
  $("record-button").disabled = false; $("stop-button").disabled = true;
  $("record-label").textContent = "Start speaking";
  $("record-hint").textContent = "Press the microphone to begin";
  $("recording-badge").classList.remove("live");
  $("recording-badge").innerHTML = "<i></i> NOT RECORDING";
}
async function stopRecording() {
  if (!state.socket) return;
  $("stop-button").disabled = true;
  $("record-label").textContent = "Finishing transcription…";
  setStatus("Finishing…");
  if (state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({type:"stop"}));
  await cleanupAudio();
  // Keep the WebSocket open until the server responds with saved/empty/error.
  // Model inference can take longer than a fixed timeout on a CPU-only machine.
  const socket = state.socket;
  setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN && !state.recording) {
      // Safety timeout for a stalled server; do not interrupt normal model inference.
      toast("Still processing audio. Please check server logs if this persists.");
    }
  }, 30000);
  setTimeout(() => loadHistory(), 3000);
  setStatus("Ready to record");
}
$("record-button").addEventListener("click", startRecording);
$("stop-button").addEventListener("click", stopRecording);
$("clear-button").addEventListener("click", () => {
  if (state.recording) { toast("Stop recording before clearing the transcript."); return; }
  state.currentTranscript = ""; $("live-transcript").value = ""; updateWordCount();
  $("live-message").textContent = "Text cleared.";
});
$("save-edit-button").addEventListener("click", async () => {
  const text = $("live-transcript").value.trim();
  if (!text) { toast("There is no transcript text to save."); return; }
  try {
    const response = await fetch("/api/transcriptions", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({title:`Edited transcript ${new Date().toLocaleString()}`,text})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save transcript.");
    toast("Edited transcript saved to history."); loadHistory();
  } catch (error) { toast(error.message); }
});

async function loadHistory() {
  try {
    const query = $("history-search").value.trim();
    const response = await fetch(`/api/transcriptions?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Unable to load history.");
    state.history = await response.json(); renderHistory();
  } catch (error) { toast(error.message); }
}
function renderHistory() {
  const list = $("history-list"); list.replaceChildren();
  $("empty-history").classList.toggle("hidden", state.history.length !== 0);
  state.history.forEach(record => {
    const card = document.createElement("article"); card.className = "history-item";
    const content = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = record.title;
    const meta = document.createElement("div"); meta.className = "history-meta";
    meta.textContent = `${formatDate(record.created_at)} · ${record.language || "Language not detected"} · ${record.text.trim().split(/\s+/).filter(Boolean).length} words`;
    const preview = document.createElement("div"); preview.className = "history-preview";
    preview.textContent = record.text.length > 260 ? record.text.slice(0,260) + "…" : record.text;
    content.append(title, meta, preview);
    const actions = document.createElement("div"); actions.className = "history-actions";
    const open = document.createElement("button"); open.className = "icon-button"; open.textContent = "Open";
    open.addEventListener("click", () => { $("live-transcript").value = record.text; state.currentTranscript = record.text; updateWordCount(); showView("live"); });
    const edit = document.createElement("button"); edit.className = "icon-button"; edit.textContent = "Edit";
    edit.addEventListener("click", () => openEdit(record));
    const del = document.createElement("button"); del.className = "icon-button"; del.textContent = "Delete";
    del.addEventListener("click", () => deleteRecord(record.id));
    actions.append(open, edit, del); card.append(content, actions); list.append(card);
  });
}
function openEdit(record) {
  $("edit-id").value = record.id; $("edit-title").value = record.title; $("edit-text").value = record.text;
  $("edit-dialog").showModal();
}
$("edit-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const id = $("edit-id").value;
  try {
    const response = await fetch(`/api/transcriptions/${id}`, {method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({title:$("edit-title").value,text:$("edit-text").value})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Update failed.");
    $("edit-dialog").close(); toast("Transcription updated."); loadHistory();
  } catch (error) { toast(error.message); }
});
async function deleteRecord(id) {
  if (!confirm("Delete this transcription permanently?")) return;
  try {
    const response = await fetch(`/api/transcriptions/${id}`, {method:"DELETE"});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Delete failed.");
    toast("Transcription deleted."); loadHistory();
  } catch (error) { toast(error.message); }
}
let searchTimer;
$("history-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadHistory, 250); });
window.addEventListener("beforeunload", () => {
  try { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({type:"stop"})); } catch {}
});
updateWordCount();
