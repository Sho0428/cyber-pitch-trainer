# CYBER PITCH TRAINER PRO MAX - Render deployment

## Render settings
- Runtime: Python 3
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn server:app --host 0.0.0.0 --port $PORT`

## Files
- `server.py`: FastAPI backend
- `index.html`: frontend
- `static/app.js`: browser logic
- `requirements.txt`: Python dependencies

The app writes uploaded/converted audio to `temp_audio/`. Render Free services have an ephemeral filesystem,
so temporary audio files can disappear after restarts, redeploys, or spin-downs.
