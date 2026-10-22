import json
import os
import threading
import time
from datetime import datetime, timezone

import numpy as np
from flask import Flask, jsonify, render_template, request
from flask_sock import Sock
from flask_sqlalchemy import SQLAlchemy
from faster_whisper import WhisperModel
from dotenv import load_dotenv
from sqlalchemy import func
from werkzeug.exceptions import NotFound

load_dotenv()

app = Flask(__name__)
database_url = os.getenv("DATABASE_URL", "sqlite:///speechflow_dev.db")
# Render and some managed hosts still provide postgres:// or postgresql:// URLs.
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql+psycopg://", 1)
elif database_url.startswith("postgresql://"):
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

db = SQLAlchemy(app)
sock = Sock(app)

class Transcription(db.Model):
    __tablename__ = "transcriptions"
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(160), nullable=False, default="Untitled transcription")
    text = db.Column(db.Text, nullable=False, default="")
    language = db.Column(db.String(40), nullable=True)
    duration_seconds = db.Column(db.Float, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False,
                           default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False,
                           default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))

_model = None
_model_lock = threading.Lock()

def get_model():
    """Load the multilingual model lazily so the dashboard can start first."""
    global _model
    with _model_lock:
        if _model is None:
            model_size = os.getenv("WHISPER_MODEL", "base")
            device = os.getenv("WHISPER_DEVICE", "cpu")
            compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
            _model = WhisperModel(model_size, device=device, compute_type=compute_type)
        return _model

def transcribe_audio(audio_float32, sample_rate):
    """Transcribe float32 mono audio. Resample to 16 kHz if necessary."""
    if audio_float32.size == 0:
        return "", None
    if sample_rate != 16000:
        from scipy.signal import resample_poly
        import math
        divisor = math.gcd(int(sample_rate), 16000)
        audio_float32 = resample_poly(audio_float32, 16000 // divisor, int(sample_rate) // divisor).astype(np.float32)
    model = get_model()
    segments, info = model.transcribe(
        audio_float32,
        language=None,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, getattr(info, "language", None)

@app.get("/")
def index():
    return render_template("index.html")

@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "SpeechFlow"})

@app.get("/api/transcriptions")
def list_transcriptions():
    query = request.args.get("q", "").strip()
    statement = Transcription.query
    if query:
        statement = statement.filter(
            db.or_(Transcription.title.ilike(f"%{query}%"),
                   Transcription.text.ilike(f"%{query}%"))
        )
    records = statement.order_by(Transcription.created_at.desc()).limit(200).all()
    return jsonify([record_to_dict(item) for item in records])

@app.post("/api/transcriptions")
def create_transcription():
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    if not text:
        return jsonify({"error": "Transcript text is required."}), 400
    record = Transcription(
        title=(str(payload.get("title") or "Untitled transcription").strip()[:160]),
        text=text,
        language=(str(payload.get("language") or "").strip()[:40] or None),
        duration_seconds=max(0, float(payload.get("duration_seconds") or 0)),
    )
    db.session.add(record)
    db.session.commit()
    return jsonify(record_to_dict(record)), 201

@app.get("/api/transcriptions/<int:record_id>")
def get_transcription(record_id):
    return jsonify(record_to_dict(get_record(record_id)))

@app.put("/api/transcriptions/<int:record_id>")
def update_transcription(record_id):
    record = get_record(record_id)
    payload = request.get_json(silent=True) or {}
    if "title" in payload:
        title = str(payload["title"]).strip()
        if not title:
            return jsonify({"error": "Title cannot be empty."}), 400
        record.title = title[:160]
    if "text" in payload:
        text = str(payload["text"]).strip()
        if not text:
            return jsonify({"error": "Transcript text cannot be empty."}), 400
        record.text = text
    if "language" in payload:
        record.language = str(payload["language"]).strip()[:40] or None
    db.session.commit()
    return jsonify(record_to_dict(record))

@app.delete("/api/transcriptions/<int:record_id>")
def delete_transcription(record_id):
    record = get_record(record_id)
    db.session.delete(record)
    db.session.commit()
    return jsonify({"deleted": True, "id": record_id})

def get_record(record_id):
    record = db.session.get(Transcription, record_id)
    if record is None:
        raise NotFound("Transcription not found.")
    return record

def record_to_dict(record):
    created = record.created_at
    updated = record.updated_at
    return {
        "id": record.id,
        "title": record.title,
        "text": record.text,
        "language": record.language,
        "duration_seconds": round(record.duration_seconds or 0, 2),
        "created_at": created.isoformat() if created else None,
        "updated_at": updated.isoformat() if updated else None,
    }

@sock.route("/ws/transcribe")
def websocket_transcribe(ws):
    """Receive JSON config then float32 PCM frames; emit partials and save on stop."""
    started = time.monotonic()
    sample_rate = 48000
    chunk_seconds = float(os.getenv("AUDIO_CHUNK_SECONDS", "3"))
    buffer = np.empty(0, dtype=np.float32)
    transcript_parts = []
    detected_language = None
    try:
        first = ws.receive()
        if not first:
            return
        config = json.loads(first)
        sample_rate = int(config.get("sample_rate", 48000))
        if sample_rate < 8000 or sample_rate > 96000:
            ws.send(json.dumps({"type": "error", "message": "Unsupported audio sample rate."}))
            return
        samples_per_chunk = int(sample_rate * chunk_seconds)
        while True:
            message = ws.receive()
            if message is None:
                break
            if isinstance(message, str):
                try:
                    command = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if command.get("type") == "stop":
                    break
                continue
            if not isinstance(message, (bytes, bytearray)):
                continue
            frame = np.frombuffer(message, dtype=np.float32)
            if frame.size == 0:
                continue
            buffer = np.concatenate((buffer, frame))
            while buffer.size >= samples_per_chunk:
                audio_chunk = buffer[:samples_per_chunk]
                buffer = buffer[samples_per_chunk:]
                text, language = transcribe_audio(audio_chunk, sample_rate)
                if language:
                    detected_language = language
                if text:
                    transcript_parts.append(text)
                    ws.send(json.dumps({
                        "type": "partial",
                        "text": text,
                        "full_text": " ".join(transcript_parts),
                        "language": detected_language,
                    }))
        # Transcribe the remaining audio when the user stops.
        if buffer.size > int(sample_rate * 0.35):
            text, language = transcribe_audio(buffer, sample_rate)
            if text:
                transcript_parts.append(text)
            if language:
                detected_language = language
        full_text = " ".join(transcript_parts).strip()
        if full_text:
            with app.app_context():
                record = Transcription(
                    title=f"Transcription {datetime.now().strftime('%d %b %Y, %H:%M')}",
                    text=full_text,
                    language=detected_language,
                    duration_seconds=time.monotonic() - started,
                )
                db.session.add(record)
                db.session.commit()
                ws.send(json.dumps({"type": "saved", "record": record_to_dict(record)}))
        else:
            ws.send(json.dumps({"type": "empty", "message": "No speech was detected."}))
    except Exception as exc:
        app.logger.exception("WebSocket transcription failed")
        try:
            ws.send(json.dumps({"type": "error", "message": "Transcription failed. Check server logs and model setup."}))
        except Exception:
            pass

@app.errorhandler(NotFound)
def handle_not_found(error):
    return jsonify({"error": "Transcription not found."}), 404

@app.errorhandler(413)
def too_large(error):
    return jsonify({"error": "Request is too large."}), 413

with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
            host="127.0.0.1", port=int(os.getenv("PORT", "5000")))
