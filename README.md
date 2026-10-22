# SpeechFlow — Procucev AI Tech Hiring Assignment

A Flask web application for incremental multilingual speech transcription with Faster-Whisper and PostgreSQL-backed CRUD history.

## Features

- Microphone capture in the browser and WebSocket audio streaming
- Local multilingual speech recognition using Faster-Whisper
- Progressive transcript updates while speaking (chunk-based; not zero-latency)
- PostgreSQL storage, search, view, edit and delete for transcript records
- Responsive dashboard and health endpoint

## Prerequisites

- Python 3.12 recommended
- PostgreSQL 14+ (or a compatible managed PostgreSQL database)
- VS Code
- A working microphone; browsers generally require `localhost` or HTTPS

Faster-Whisper downloads the selected model on first use. `base` is the default. First transcription may take longer while model files download and initialise. A CPU-only laptop may transcribe more slowly than real time.

## Windows setup (PowerShell)

```powershell
# 1. Create and enter a project directory, then open it in VS Code.
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# If PowerShell blocks activation for this terminal only:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
pip install -r requirements-dev.txt
```

Create a PostgreSQL database named `speechflow` using pgAdmin or `psql`. Copy `.env.example` to `.env`, then replace `YOUR_PASSWORD` with your local PostgreSQL password. Do not commit `.env`.

```powershell
Copy-Item .env.example .env
# Edit .env and set DATABASE_URL to your PostgreSQL credentials.
python app.py
```

Open http://127.0.0.1:5000. The first microphone recording may trigger a model download. Allow microphone permission.

If you cannot install PostgreSQL immediately, remove/leave unset `DATABASE_URL` only if you also change the default database URI in `app.py` to `sqlite:///speechflow_dev.db`; SQLite is only a temporary local fallback, not the final assignment database.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | local SQLite fallback | PostgreSQL connection string |
| `WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` if correctly configured |
| `WHISPER_COMPUTE_TYPE` | `int8` on CPU | Faster-Whisper compute precision |
| `AUDIO_CHUNK_SECONDS` | `3` | Number of seconds transcribed per chunk |

For PostgreSQL, a SQLAlchemy connection string can look like:
`postgresql+psycopg://USER:PASSWORD@HOST:5432/DATABASE`

## API

- `GET /health` — health check
- `GET /api/transcriptions?q=keyword` — list/search records
- `POST /api/transcriptions` — create `{ "title": "...", "text": "...", "language": "en" }`
- `GET /api/transcriptions/<id>` — read a record
- `PUT /api/transcriptions/<id>` — update title/text/language
- `DELETE /api/transcriptions/<id>` — delete a record
- `WS /ws/transcribe` — sends JSON `{ "sample_rate": 48000 }`, then binary float32 mono PCM frames; send `{ "type": "stop" }` to finish and save

## Test the REST API

Run the automated tests from the active virtual environment:

```powershell
python -m pytest -q
```

To exercise the running service manually:

```powershell
curl.exe http://127.0.0.1:5000/health
curl.exe -X POST http://127.0.0.1:5000/api/transcriptions -H "Content-Type: application/json" -d "{\"title\":\"Demo\",\"text\":\"Hello from SpeechFlow\"}"
curl.exe http://127.0.0.1:5000/api/transcriptions
```

## Deployment notes

This app needs a Python web service that supports WebSockets and has enough RAM/CPU to run the selected Whisper model. A free web instance may be too constrained for reliable model inference; check the host's current memory, CPU, timeout and WebSocket limits before selecting it.

For Render:
- Create a managed PostgreSQL database and copy its **internal** connection URL to the service environment variable `DATABASE_URL`.
- Create a Web Service connected to this repository.
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn --workers 1 --threads 8 --timeout 120 --bind 0.0.0.0:$PORT app:app`
- Add `WHISPER_MODEL=base`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`.
- Confirm the service plan has sufficient RAM. Model download and loading may make initial startup or first use slow.

## Known limitations / next improvements

- This assignment implementation uses short non-overlapping audio chunks. Word boundaries can be imperfect and there may be a pause while each chunk is transcribed.
- Browser `ScriptProcessorNode` is deprecated but widely available. An AudioWorklet implementation is a production improvement.
- Add authentication, rate limits, migrations (Flask-Migrate/Alembic), CSRF protections and privacy controls before exposing this as a multi-user production service.
- Add automated tests and measure Hindi-English code-switching accuracy using representative audio samples.
