import os
import tempfile
import pytest

# Set before importing app.py so tests never use a real developer database.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = "sqlite:///" + _tmp_db.name

from app import app, db

@pytest.fixture()
def client():
    app.config.update(TESTING=True)
    with app.app_context():
        db.drop_all()
        db.create_all()
    with app.test_client() as client:
        yield client
    with app.app_context():
        db.session.remove()
        db.drop_all()

def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json["status"] == "ok"

def test_transcription_crud(client):
    created = client.post("/api/transcriptions", json={
        "title": "Test", "text": "Namaste, hello world", "language": "en"
    })
    assert created.status_code == 201
    record_id = created.json["id"]

    fetched = client.get(f"/api/transcriptions/{record_id}")
    assert fetched.status_code == 200
    assert fetched.json["text"] == "Namaste, hello world"

    updated = client.put(f"/api/transcriptions/{record_id}", json={
        "title": "Updated title", "text": "Updated transcript"
    })
    assert updated.status_code == 200
    assert updated.json["title"] == "Updated title"

    deleted = client.delete(f"/api/transcriptions/{record_id}")
    assert deleted.status_code == 200
    assert client.get(f"/api/transcriptions/{record_id}").status_code == 404

def test_empty_transcription_rejected(client):
    response = client.post("/api/transcriptions", json={"title": "Empty", "text": " "})
    assert response.status_code == 400
