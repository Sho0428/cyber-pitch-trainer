from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import librosa
import numpy as np
from scipy.signal import medfilt
import os
import requests
import uuid
import soundfile as sf
import yt_dlp
import imageio_ffmpeg

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMP_DIR = "temp_audio"
os.makedirs(TEMP_DIR, exist_ok=True)

class UrlRequest(BaseModel):
    url: str

def convert_and_load_audio(file_path):
    sr = 22050
    y, _ = librosa.load(file_path, sr=sr, mono=True)
    wav_path = os.path.splitext(file_path)[0] + "_converted.wav"
    sf.write(wav_path, y, sr)
    return y, sr, wav_path

def process_audio_file(file_path, manual_bpm=116.0):
    y, sr, wav_path = convert_and_load_audio(file_path)
    duration = float(len(y) / sr)
    hop_length = 512
    frame_time = hop_length / sr

    # 1. BPM検出 ＆ 16分音符/8分音符長の算出
    if manual_bpm and manual_bpm > 0:
        bpm = manual_bpm
    else:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo[0]) if isinstance(tempo, (list, np.ndarray)) else float(tempo)
        if bpm <= 0:
            bpm = 120.0

    sixteenth_note_dur = 60.0 / (bpm * 4.0)
    eighth_note_dur = 60.0 / (bpm * 2.0)

    # 2. HPSS ＆ 音量閾値自動フィッティング
    y_harmonic, _ = librosa.effects.hpss(y)
    rms_raw = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_harm = librosa.feature.rms(y=y_harmonic, hop_length=hop_length)[0]
    rms_max = np.maximum(rms_raw, rms_harm)

    active_rms = rms_max[rms_max > 0]
    if len(active_rms) > 0:
        auto_rms_threshold = np.percentile(active_rms, 10) * 0.5
    else:
        auto_rms_threshold = np.mean(rms_max) * 0.05

    # 3. pYIN ピッチ抽出
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y_harmonic,
        fmin=librosa.note_to_hz('C2'),
        fmax=librosa.note_to_hz('C6'),
        sr=sr,
        hop_length=hop_length,
        fill_na=0
    )
    
    midi_notes = librosa.hz_to_midi(f0)
    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)

    valid_probs = voiced_probs[voiced_probs > 0]
    median_prob = float(np.median(valid_probs)) if len(valid_probs) > 0 else 0.0
    auto_prob_threshold = max(0.05, min(0.20, median_prob * 0.4))

    cleaned = np.where((voiced_probs >= auto_prob_threshold) & (rms_max > auto_rms_threshold) & (midi_notes > 0), midi_notes, 0)
    cleaned = np.nan_to_num(cleaned, nan=0)

    # 4. BPM基盤の動的補間
    filled_notes = np.copy(cleaned)
    max_gap_frames = max(2, int(eighth_note_dur / frame_time))
    
    gap_len = 0
    for i in range(len(cleaned)):
        if cleaned[i] == 0:
            gap_len += 1
        else:
            if 0 < gap_len <= max_gap_frames and (i - gap_len - 1) >= 0:
                prev_val = cleaned[i - gap_len - 1]
                next_val = cleaned[i]
                if prev_val > 0 and next_val > 0:
                    interp_vals = np.linspace(prev_val, next_val, gap_len + 2)[1:-1]
                    filled_notes[i - gap_len : i] = interp_vals
            gap_len = 0

    # 5. 平滑化
    kernel_size = max(3, int(sixteenth_note_dur / frame_time))
    if kernel_size % 2 == 0:
        kernel_size += 1
    
    filtered = medfilt(filled_notes, kernel_size=kernel_size)
    dt = float(times[1] - times[0]) if len(times) > 1 else 0.023
    
    # 6. ガイドバー型ノート群（半音単位の矩形ノート）への変換処理
    notes_data = []
    current_bar = None

    for t, note in zip(times, filtered):
        if note > 0:
            rounded_midi = int(round(note))
            if current_bar is None:
                current_bar = {
                    "midi": rounded_midi,
                    "time": round(float(t), 3),
                    "duration": round(dt, 3)
                }
            elif current_bar["midi"] == rounded_midi and (t - (current_bar["time"] + current_bar["duration"])) < (dt * 2.5):
                current_bar["duration"] = round(float(t + dt - current_bar["time"]), 3)
            else:
                if current_bar["duration"] >= 0.08:
                    notes_data.append(current_bar)
                current_bar = {
                    "midi": rounded_midi,
                    "time": round(float(t), 3),
                    "duration": round(dt, 3)
                }
        else:
            if current_bar is not None:
                if current_bar["duration"] >= 0.08:
                    notes_data.append(current_bar)
                current_bar = None

    if current_bar is not None and current_bar["duration"] >= 0.08:
        notes_data.append(current_bar)
            
    return duration, notes_data, wav_path, round(bpm, 1)

@app.get("/")
def read_index():
    return FileResponse("index.html")

@app.post("/api/upload-file")
async def upload_file(file: UploadFile = File(...)):
    file_id = str(uuid.uuid4())
    ext = os.path.splitext(file.filename)[1]
    saved_path = os.path.join(TEMP_DIR, f"{file_id}{ext}")
    
    with open(saved_path, "wb") as f:
        content = await file.read()
        f.write(content)
        
    try:
        duration, notes, processed_wav_path, bpm = process_audio_file(saved_path)
        filename = os.path.basename(processed_wav_path)
        return {
            "status": "success",
            "audio_url": f"/temp_audio/{filename}",
            "duration": duration,
            "bpm": bpm,
            "notes": notes
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"解析エラー: {str(e)}")

@app.post("/api/load-url")
def load_from_url(req: UrlRequest):
    url = req.url
    file_id = str(uuid.uuid4())
    
    try:
        if "youtube.com" in url or "youtu.be" in url:
            output_template = os.path.join(TEMP_DIR, f"{file_id}.%(ext)s")
            ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
            
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': output_template,
                'quiet': True,
                'no_warnings': True,
                'noplaylist': True,
                'ffmpeg_location': ffmpeg_exe,
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'wav',
                }],
                'http_headers': {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                }
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
            
            audio_path = os.path.join(TEMP_DIR, f"{file_id}.wav")
        else:
            response = requests.get(url, timeout=15)
            audio_path = os.path.join(TEMP_DIR, f"{file_id}.mp3")
            with open(audio_path, "wb") as f:
                f.write(response.content)

        duration, notes, processed_wav_path, bpm = process_audio_file(audio_path)
        filename = os.path.basename(processed_wav_path)
        return {
            "status": "success",
            "audio_url": f"/temp_audio/{filename}",
            "duration": duration,
            "bpm": bpm,
            "notes": notes
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"音源取得エラー: {str(e)}")

app.mount("/temp_audio", StaticFiles(directory=TEMP_DIR), name="temp_audio")
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))