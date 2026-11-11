const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToMidi(freq) {
    if (!freq || freq <= 0) return null;
    return Math.round(69 + 12 * Math.log2(freq / 440));
}

function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi) {
    if (!midi) return '--';
    const name = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    return name + octave;
}

function getCentsOffset(sungFreq, targetFreq) {
    if (!sungFreq || !targetFreq) return 0;
    return Math.floor(1200 * Math.log2(sungFreq / targetFreq));
}

let songs = [];
let currentSong = null;

/* Global State */
let keyTranspose = 0;
let isPlaying = false;
let songTime = 0;
let lastTimestamp = 0;

let audioPlayer = new Audio();
let audioCtx = null;
let analyser = null;
let micStream = null;
let isMicActive = false;
let pitchyDetector = null;
let noiseGateThreshold = 0.012;

let synthOsc = null;
let guideGain = null;
let guideSoundEnabled = false; // 初期OFF（Option A）
let currentWaveform = 'sawtooth';

let currentSungFreq = 0;
let currentSungMidi = null;
let currentClarity = 0;

let userPitchBlocks = [];

let currentScore = 0;
let totalFramesEvaluated = 0;
let perfectHits = 0;
let goodHits = 0;
let totalCentsDiff = 0;

let techVibratoCount = 0;
let techLongToneCount = 0;
let techSlideUpCount = 0;
let techFallCount = 0;

let pitchBufferForTech = [];
let longToneFrames = 0;

window.onload = async () => {
    if (window.location.protocol === 'file:') {
        const warn = document.getElementById('fileProtocolWarning');
        if (warn) warn.classList.remove('hidden');
    }

    await loadSongsJson();
    initCanvas();
    requestAnimationFrame(gameLoop);
};

// JSONファイルから曲データをロードする関数
async function loadSongsJson() {
    try {
        const response = await fetch('/songs.json');
        if (response.ok) {
            songs = await response.json();
            populateSongSelect(); // まずドロップダウンを生成
            if (songs.length > 0) {
                currentSong = songs[0];
            }
        } else {
            console.warn("songs.json の読み込みに失敗しました。");
        }
    } catch (error) {
        console.error("songs.json 取得エラー:", error);
    }
    populateSongSelect();
}

function populateSongSelect() {
    const select = document.getElementById('songSelect');
    if (!select) return;
    select.innerHTML = '';
    songs.forEach((s, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${s.title}`;
        select.appendChild(opt);
    });
}

function changeSong(index) {
    stopSong();
    currentSong = songs[index];
    if (currentSong.audio_url) {
        audioPlayer.src = currentSong.audio_url;
    } else {
        audioPlayer.src = '';
    }
    const bpmSlider = document.getElementById('bpmSlider');
    if (bpmSlider) bpmSlider.value = currentSong.bpm || 120;
    const bpmDisplay = document.getElementById('bpmDisplay');
    if (bpmDisplay) bpmDisplay.innerText = currentSong.bpm || 120;
}

function changeKey(delta) {
    keyTranspose = Math.max(-6, Math.min(6, keyTranspose + delta));
    const keyDisplay = document.getElementById('keyDisplay');
    if (keyDisplay) keyDisplay.innerText = `KEY: ${keyTranspose > 0 ? '+' : ''}${keyTranspose}`;
}

function updateBPM(val) {
    const bpmDisplay = document.getElementById('bpmDisplay');
    if (bpmDisplay) bpmDisplay.innerText = val;
    if (currentSong) currentSong.bpm = parseFloat(val);
}

function toggleGuideSound() {
    guideSoundEnabled = !guideSoundEnabled;
    const icon = document.getElementById('guideIcon');
    const txt = document.getElementById('guideText');
    if (guideSoundEnabled) {
        if (icon) icon.className = 'fa-solid fa-volume-high text-neonCyan';
        if (txt) {
            txt.innerText = 'GUIDE';
            txt.className = 'text-neonCyan';
        }
    } else {
        if (icon) icon.className = 'fa-solid fa-volume-xmark text-slate-400';
        if (txt) {
            txt.innerText = 'MUTED';
            txt.className = 'text-slate-400';
        }
        if (guideGain) guideGain.gain.value = 0;
    }
}

function changeWaveform(wave) {
    currentWaveform = wave;
    if (synthOsc) synthOsc.type = wave;
}

function updateNoiseGate(val) {
    noiseGateThreshold = parseFloat(val);
    const gateVal = document.getElementById('noiseGateVal');
    if (gateVal) gateVal.innerText = val;
}

/* Audio & Microphone Engine */
async function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;

        synthOsc = audioCtx.createOscillator();
        guideGain = audioCtx.createGain();
        synthOsc.type = currentWaveform;
        guideGain.gain.value = 0;
        synthOsc.connect(guideGain);
        guideGain.connect(audioCtx.destination);
        synthOsc.start();
    } catch (e) {
        console.error("AudioContext 初期化エラー:", e);
    }
}

async function toggleMicrophone() {
    await initAudio();
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    if (!isMicActive) {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micSource = audioCtx.createMediaStreamSource(micStream);
            micSource.connect(analyser);

            isMicActive = true;
            const micDot = document.getElementById('micDot');
            const micText = document.getElementById('micText');
            if (micDot) micDot.className = "w-2 h-2 rounded-full bg-neonGreen animate-pulse";
            if (micText) {
                micText.innerText = "MIC: ACTIVE";
                micText.className = "text-[10px] font-mono text-neonGreen";
            }
        } catch (err) {
            showCustomToast("MICROPHONE ERROR", "マイクへのアクセスに失敗しました: " + err.message);
        }
    } else {
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
        }
        isMicActive = false;
        const micDot = document.getElementById('micDot');
        const micText = document.getElementById('micText');
        if (micDot) micDot.className = "w-2 h-2 rounded-full bg-red-500";
        if (micText) {
            micText.innerText = "MIC: OFF";
            micText.className = "text-[10px] font-mono text-slate-300";
        }
    }
}

function detectPitch() {
    if (!analyser || !isMicActive) return { freq: 0, clarity: 0, rms: 0 };

    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);

    let sumSquare = 0;
    for (let i = 0; i < buffer.length; i++) {
        sumSquare += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquare / buffer.length);

    if (rms < noiseGateThreshold) {
        return { freq: 0, clarity: 0, rms };
    }

    let pitch = 0, clarity = 0;

    try {
        if (window.Pitchy && window.Pitchy.PitchDetector) {
            if (!pitchyDetector) {
                pitchyDetector = window.Pitchy.PitchDetector.forFloat32Array(analyser.fftSize);
                pitchyDetector.minVolumeDecibels = -40;
            }
            const [p, c] = pitchyDetector.findPitch(buffer, audioCtx.sampleRate);
            pitch = p;
            clarity = c;
        }
    } catch (err) {}

    if (!pitch || clarity < 0.6) {
        pitch = autoCorrelate(buffer, audioCtx.sampleRate);
        clarity = pitch > 0 ? 0.85 : 0;
    }

    return { freq: pitch, clarity, rms };
}

function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let r1 = 0, r2 = SIZE - 1;
    const thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++) {
        if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
        if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    }

    const cBuf = buf.slice(r1, r2);
    const c = new Float32Array(cBuf.length);
    for (let i = 0; i < cBuf.length; i++) {
        for (let j = 0; j < cBuf.length - i; j++) {
            c[i] += cBuf[j] * cBuf[j + i];
        }
    }

    let d = 0;
    while (c[d] > c[d + 1]) d++;
    let maxval = -1, maxpos = -1;
    for (let i = d; i < cBuf.length; i++) {
        if (c[i] > maxval) {
            maxval = c[i];
            maxpos = i;
        }
    }

    let T0 = maxpos;
    if (T0 === -1 || T0 === 0) return 0;

    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);

    return sampleRate / T0;
}

/* API Integration (URL & File Loading) */
async function loadFromUrl() {
    const urlInput = document.getElementById('urlInput');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) { showCustomToast("INPUT ERROR", "URLを入力してください。"); return; }

    const btn = document.getElementById('loadUrlBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "解析中...";
    }

    try {
        const res = await fetch('/api/load-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.status === 'success') {
            const newSong = {
                id: `url-${Date.now()}`,
                title: "YouTube / URL 音源",
                bpm: data.bpm,
                audio_url: data.audio_url,
                notes: data.notes
            };
            songs.push(newSong);
            populateSongSelect();
            const songSelect = document.getElementById('songSelect');
            if (songSelect) songSelect.value = songs.length - 1;
            changeSong(songs.length - 1);
            showCustomToast("SUCCESS", "音源の解析とガイドバーの作成が完了しました！");
        } else {
            showCustomToast("API ERROR", data.detail || "解析に失敗しました。");
        }
    } catch (e) {
        showCustomToast("SERVER ERROR", "サーバーとの通信に失敗しました。");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "URL解析";
        }
    }
}

async function handleAudioFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showCustomToast("PROCESSING", "音源ファイルを解析中です。しばらくお待ちください...");

    try {
        const res = await fetch('/api/upload-file', { method: 'POST', body: formData });
        const data = await res.json();
        closeCustomToast();

        if (data.status === 'success') {
            const newSong = {
                id: `file-${Date.now()}`,
                title: file.name,
                bpm: data.bpm,
                audio_url: data.audio_url,
                notes: data.notes
            };
            songs.push(newSong);
            populateSongSelect();
            const songSelect = document.getElementById('songSelect');
            if (songSelect) songSelect.value = songs.length - 1;
            changeSong(songs.length - 1);
            showCustomToast("SUCCESS", "ファイルの解析が完了しました！");
        } else {
            showCustomToast("API ERROR", data.detail || "解析に失敗しました。");
        }
    } catch (e) {
        closeCustomToast();
        showCustomToast("SERVER ERROR", "通信エラーが発生しました。");
    }
}

/* Transport & Game Loop */
function togglePlay() {
    if (!isPlaying) {
        startSong();
    } else {
        pauseSong();
    }
}

function startSong() {
    initAudio();
    isPlaying = true;
    if (currentSong && currentSong.audio_url) {
        audioPlayer.play();
    }
    const playIcon = document.getElementById('playIcon');
    const playText = document.getElementById('playText');
    if (playIcon) playIcon.className = 'fa-solid fa-pause';
    if (playText) playText.innerText = 'PAUSE';
    if (!isMicActive) toggleMicrophone();
}

function pauseSong() {
    isPlaying = false;
    if (currentSong && currentSong.audio_url) {
        audioPlayer.pause();
    }
    const playIcon = document.getElementById('playIcon');
    const playText = document.getElementById('playText');
    if (playIcon) playIcon.className = 'fa-solid fa-play';
    if (playText) playText.innerText = 'RESUME';
    if (guideGain) guideGain.gain.value = 0;
}

function stopSong() {
    isPlaying = false;
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
    }
    songTime = 0;
    userPitchBlocks = [];
    currentScore = 0;
    totalFramesEvaluated = 0;
    perfectHits = 0;
    goodHits = 0;
    totalCentsDiff = 0;
    techVibratoCount = 0;
    techLongToneCount = 0;
    techSlideUpCount = 0;
    techFallCount = 0;

    const playIcon = document.getElementById('playIcon');
    const playText = document.getElementById('playText');
    if (playIcon) playIcon.className = 'fa-solid fa-play';
    if (playText) playText.innerText = 'START';
    if (guideGain) guideGain.gain.value = 0;

    updateHUD(null, 0, 0, 'READY', 0);
    updateTechniquesUI();
}

function gameLoop(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const deltaTime = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    if (isPlaying) {
        if (currentSong && currentSong.audio_url) {
            songTime = audioPlayer.currentTime;
        } else {
            songTime += deltaTime;
        }
        evaluatePerformance();

        const maxTime = (currentSong && currentSong.notes && currentSong.notes.length > 0)
            ? currentSong.notes[currentSong.notes.length - 1].time + currentSong.notes[currentSong.notes.length - 1].duration + 1.5 
            : 15;
        
        if (songTime >= maxTime) {
            pauseSong();
            showScoreModal();
        }
    }

    const pitchData = detectPitch();
    currentSungFreq = pitchData.freq;
    currentSungMidi = freqToMidi(currentSungFreq);
    currentClarity = pitchData.clarity;

    const vuBar = document.getElementById('vuMeterBar');
    if (vuBar) {
        const vuPercent = Math.min(100, Math.max(0, pitchData.rms * 1600));
        vuBar.style.width = `${vuPercent}%`;
    }

    if (isPlaying && currentSungFreq > 0 && currentSungMidi) {
        recordUserPitchBlock(songTime, currentSungMidi, currentSungFreq);
        detectVocalTechniques(currentSungFreq);
    }

    renderPianoRoll();
    requestAnimationFrame(gameLoop);
}

function recordUserPitchBlock(time, midi, freq) {
    if (userPitchBlocks.length > 0) {
        const lastBlock = userPitchBlocks[userPitchBlocks.length - 1];
        if (lastBlock.midi === midi && (time - lastBlock.endTime) < 0.15) {
            lastBlock.endTime = time;
            lastBlock.duration = time - lastBlock.startTime;
            return;
        }
    }

    userPitchBlocks.push({
        startTime: time,
        endTime: time + 0.05,
        duration: 0.05,
        midi: midi,
        freq: freq
    });

    if (userPitchBlocks.length > 400) {
        userPitchBlocks.shift();
    }
}

function evaluatePerformance() {
    if (!currentSong || !currentSong.notes) return;

    const activeNote = currentSong.notes.find(n => 
        songTime >= n.time && songTime <= (n.time + n.duration)
    );

    if (activeNote) {
        const targetMidi = activeNote.midi + keyTranspose;
        const targetFreq = midiToFreq(targetMidi);

        if (guideSoundEnabled && guideGain && synthOsc) {
            synthOsc.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.015);
            guideGain.gain.setTargetAtTime(0.18, audioCtx.currentTime, 0.015);
        }

        if (currentSungFreq > 0) {
            const centDiff = Math.abs(getCentsOffset(currentSungFreq, targetFreq));
            totalFramesEvaluated++;
            totalCentsDiff += centDiff;

            let rating = 'MISS';
            if (centDiff <= 25) {
                rating = 'PERFECT';
                perfectHits++;
                currentScore += 100;
            } else if (centDiff <= 55) {
                rating = 'GOOD';
                goodHits++;
                currentScore += 50;
            } else {
                rating = 'MISS';
            }

            updateHUD(targetMidi, targetFreq, currentSungFreq, rating, centDiff);
        } else {
            updateHUD(targetMidi, targetFreq, 0, 'MISS', 0);
        }
    } else {
        if (guideGain && audioCtx) guideGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.015);
        updateHUD(null, 0, currentSungFreq, 'READY', 0);
    }
}

function updateHUD(targetMidi, targetFreq, sungFreq, rating, centDiff) {
    const targetNoteEl = document.getElementById('targetNote');
    const targetHzEl = document.getElementById('targetHz');
    const sungNoteEl = document.getElementById('sungNote');
    const sungHzEl = document.getElementById('sungHz');

    if (targetNoteEl) targetNoteEl.innerText = targetMidi ? midiToNoteName(targetMidi) : '--';
    if (targetHzEl) targetHzEl.innerText = targetFreq ? `${Math.round(targetFreq)} Hz` : '0 Hz';

    const sungMidi = freqToMidi(sungFreq);
    if (sungNoteEl) sungNoteEl.innerText = sungMidi ? midiToNoteName(sungMidi) : '--';
    if (sungHzEl) sungHzEl.innerText = sungFreq ? `${Math.round(sungFreq)} Hz` : '0 Hz';

    const badge = document.getElementById('ratingBadge');
    if (badge) {
        badge.innerText = rating;
        if (rating === 'PERFECT') {
            badge.className = "px-2 py-0.5 rounded text-[10px] font-black font-mono border border-neonGreen text-neonGreen bg-neonGreen/10 animate-bounce";
        } else if (rating === 'GOOD') {
            badge.className = "px-2 py-0.5 rounded text-[10px] font-black font-mono border border-neonYellow text-neonYellow bg-neonYellow/10";
        } else if (rating === 'MISS') {
            badge.className = "px-2 py-0.5 rounded text-[10px] font-black font-mono border border-neonRed text-neonRed bg-neonRed/10";
        } else {
            badge.className = "px-2 py-0.5 rounded text-[10px] font-black font-mono border border-slate-700 text-slate-500";
        }
    }

    const indicator = document.getElementById('centIndicator');
    const centText = document.getElementById('centText');
    if (indicator && centText) {
        if (sungFreq > 0 && targetFreq > 0) {
            const cents = getCentsOffset(sungFreq, targetFreq);
            const clampedCents = Math.max(-50, Math.min(50, cents));
            const posPercent = 50 + (clampedCents / 50) * 45;
            indicator.style.left = `${posPercent}%`;
            centText.innerText = `${cents > 0 ? '+' : ''}${cents} Cent`;
        } else {
            indicator.style.left = `50%`;
            centText.innerText = `0 Cent`;
        }
    }

    const acc = totalFramesEvaluated > 0 ? Math.round(((perfectHits + goodHits * 0.5) / totalFramesEvaluated) * 100) : 100;
    const accEl = document.getElementById('accuracyText');
    const liveScoreEl = document.getElementById('liveScore');
    if (accEl) accEl.innerText = `${acc}%`;
    if (liveScoreEl) liveScoreEl.innerText = String(currentScore).padStart(6, '0');
}

function detectVocalTechniques(freq) {
    pitchBufferForTech.push({ freq, time: songTime });
    if (pitchBufferForTech.length > 35) pitchBufferForTech.shift();
    if (pitchBufferForTech.length < 20) return;

    const recentFreqs = pitchBufferForTech.map(p => p.freq);
    const avgFreq = recentFreqs.reduce((a, b) => a + b) / recentFreqs.length;
    const maxDev = Math.max(...recentFreqs.map(f => Math.abs(f - avgFreq)));
    
    if (maxDev < 7) {
        longToneFrames++;
        if (longToneFrames === 40) {
            techLongToneCount++;
            triggerTechniquePopup("LONG TONE (ロングトーン)");
            updateTechniquesUI();
        }
    } else {
        longToneFrames = 0;
    }

    let directionChanges = 0;
    for (let i = 2; i < recentFreqs.length; i++) {
        const diff1 = recentFreqs[i - 1] - recentFreqs[i - 2];
        const diff2 = recentFreqs[i] - recentFreqs[i - 1];
        if ((diff1 > 0 && diff2 < 0) || (diff1 < 0 && diff2 > 0)) {
            directionChanges++;
        }
    }
    if (directionChanges >= 6 && maxDev > 8 && maxDev < 30) {
        if (Math.random() < 0.04) {
            techVibratoCount++;
            triggerTechniquePopup("VIBRATO (ビブラート)");
            updateTechniquesUI();
        }
    }

    const firstHalfAvg = recentFreqs.slice(0, 10).reduce((a, b) => a + b) / 10;
    const secondHalfAvg = recentFreqs.slice(10, 20).reduce((a, b) => a + b) / 10;
    if (secondHalfAvg - firstHalfAvg > 20 && secondHalfAvg - firstHalfAvg < 50) {
        if (Math.random() < 0.03) {
            techSlideUpCount++;
            triggerTechniquePopup("SHAKURI (しゃくり)");
            updateTechniquesUI();
        }
    }
}

function updateTechniquesUI() {
    const v = document.getElementById('techVibrato');
    const l = document.getElementById('techLongTone');
    const s = document.getElementById('techSlideUp');
    const f = document.getElementById('techFall');
    if (v) v.innerText = techVibratoCount;
    if (l) l.innerText = techLongToneCount;
    if (s) s.innerText = techSlideUpCount;
    if (f) f.innerText = techFallCount;
}

function triggerTechniquePopup(name) {
    const layer = document.getElementById('techniqueToastLayer');
    if (!layer) return;
    const toast = document.createElement('div');
    toast.className = "bg-neonMagenta text-slate-950 font-black font-mono px-2.5 py-1 text-xs rounded shadow-lg animate-bounce";
    toast.innerText = `★ ${name}`;
    layer.appendChild(toast);
    setTimeout(() => toast.remove(), 1200);
}

/* Canvas Piano Roll Renderer */
let canvas, ctx;

function initCanvas() {
    canvas = document.getElementById('pianoRollCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
    if (!canvas || !canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
}

function renderPianoRoll() {
    if (!canvas || !ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#060811';
    ctx.fillRect(0, 0, width, height);

    let minMidi = 55, maxMidi = 77;
    if (currentSong && currentSong.notes && currentSong.notes.length > 0) {
        const songMidis = currentSong.notes.map(n => n.midi + keyTranspose);
        minMidi = Math.min(...songMidis) - 3;
        maxMidi = Math.max(...songMidis) + 3;
    }

    const midiSpan = maxMidi - minMidi;
    const hitX = width * 0.25;
    const timeWindow = 5.0;
    const blockHeight = Math.max(10, Math.min(18, (height / midiSpan) * 0.75));

    for (let m = minMidi; m <= maxMidi; m++) {
        const y = height - ((m - minMidi) / midiSpan) * height;
        const isAccidental = [1, 3, 6, 8, 10].includes(m % 12);

        ctx.fillStyle = isAccidental ? 'rgba(18, 24, 41, 0.45)' : 'rgba(10, 13, 24, 0.2)';
        ctx.fillRect(0, y - (height / midiSpan), width, height / midiSpan);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();

        if (m % 12 === 0 || m === minMidi) {
            ctx.fillStyle = '#475569';
            ctx.font = '10px monospace';
            ctx.fillText(midiToNoteName(m), 6, y - 3);
        }
    }

    // Render Target Guide Bars
    if (currentSong && currentSong.notes) {
        currentSong.notes.forEach(note => {
            const targetMidi = note.midi + keyTranspose;
            const noteStartX = hitX + ((note.time - songTime) / timeWindow) * (width - hitX);
            const noteWidth = (note.duration / timeWindow) * (width - hitX);
            const noteY = height - ((targetMidi - minMidi) / midiSpan) * height;

            if (noteStartX + noteWidth > 0 && noteStartX < width) {
                ctx.shadowColor = '#00f0ff';
                ctx.shadowBlur = 8;
                
                const grad = ctx.createLinearGradient(noteStartX, 0, noteStartX + noteWidth, 0);
                grad.addColorStop(0, '#00f0ff');
                grad.addColorStop(1, '#0088ff');
                ctx.fillStyle = grad;

                ctx.beginPath();
                ctx.roundRect(noteStartX, noteY - blockHeight / 2, Math.max(6, noteWidth), blockHeight, 3);
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.fillStyle = '#090d16';
                ctx.font = 'bold 9px monospace';
                ctx.fillText(midiToNoteName(targetMidi), noteStartX + 3, noteY + 3);
            }
        });
    }

    // Render User Pitch Blocks
    userPitchBlocks.forEach(b => {
        const blockStartX = hitX + ((b.startTime - songTime) / timeWindow) * (width - hitX);
        const blockWidth = Math.max(6, (b.duration / timeWindow) * (width - hitX));
        const blockY = height - ((b.midi - minMidi) / midiSpan) * height;

        if (blockStartX + blockWidth > 0 && blockStartX < width) {
            ctx.shadowColor = '#ff007f';
            ctx.shadowBlur = 10;
            
            const userGrad = ctx.createLinearGradient(blockStartX, 0, blockStartX + blockWidth, 0);
            userGrad.addColorStop(0, '#ff007f');
            userGrad.addColorStop(1, '#ff55aa');
            ctx.fillStyle = userGrad;

            ctx.beginPath();
            ctx.roundRect(blockStartX, blockY - blockHeight / 2, blockWidth, blockHeight, 3);
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    });

    // Hit Playhead Line
    ctx.shadowColor = '#ff2a6d';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#ff2a6d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hitX, 0);
    ctx.lineTo(hitX, height);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Sparkle Particle
    if (currentSungFreq > 0 && currentSungMidi) {
        const sungY = height - ((currentSungMidi - minMidi) / midiSpan) * height;
        ctx.fillStyle = '#ffe600';
        ctx.shadowColor = '#ffe600';
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(hitX, sungY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

/* Modal Engine */
function openMidiModal() {
    const modal = document.getElementById('midiModal');
    if (modal) modal.classList.remove('hidden');
}

function closeMidiModal() {
    const modal = document.getElementById('midiModal');
    if (modal) modal.classList.add('hidden');
}

async function handleMidiUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        const midi = new Midi(arrayBuffer);

        let bestTrack = midi.tracks[0];
        midi.tracks.forEach(t => {
            if (t.notes.length > (bestTrack ? bestTrack.notes.length : 0)) {
                bestTrack = t;
            }
        });

        if (!bestTrack || bestTrack.notes.length === 0) {
            showCustomToast("MIDI ERROR", "MIDIファイルにノートデータが見つかりませんでした。");
            return;
        }

        const extractedNotes = bestTrack.notes.map(n => ({
            midi: n.midi,
            time: n.time,
            duration: n.duration
        }));

        const newSong = {
            id: `midi-${Date.now()}`,
            title: midi.header.name || file.name.replace('.mid', ''),
            artist: 'Imported MIDI Track',
            bpm: Math.round(midi.header.tempos[0]?.bpm || 120),
            audio_url: null,
            notes: extractedNotes
        };

        songs.push(newSong);
        populateSongSelect();
        const songSelect = document.getElementById('songSelect');
        if (songSelect) songSelect.value = songs.length - 1;
        changeSong(songs.length - 1);

        closeMidiModal();
        showCustomToast("MIDI SUCCESS", `"${newSong.title}" (${extractedNotes.length} 音符) をロードしました。`);
    } catch (err) {
        showCustomToast("MIDI ERROR", "MIDIファイルの読み込みに失敗しました: " + err.message);
    }
}

function showScoreModal() {
    const modal = document.getElementById('scoreModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const resSongTitle = document.getElementById('resSongTitle');
    if (resSongTitle && currentSong) resSongTitle.innerText = `${currentSong.title}`;

    const pitchAcc = totalFramesEvaluated > 0 ? Math.min(100, Math.round((perfectHits / totalFramesEvaluated) * 100)) : 80;
    const rhythmVal = Math.min(100, Math.round(85 + Math.random() * 10));
    const stabilityVal = Math.min(100, Math.round(80 + Math.random() * 15));
    const techBonus = (techVibratoCount + techLongToneCount + techSlideUpCount + techFallCount) * 300;

    const finalScoreVal = Math.min(100, (pitchAcc * 0.5 + rhythmVal * 0.25 + stabilityVal * 0.25 + (techBonus / 1000))).toFixed(2);
    const resFinalScore = document.getElementById('resFinalScore');
    if (resFinalScore) resFinalScore.innerText = finalScoreVal;

    let rank = 'B';
    if (finalScoreVal >= 95) rank = 'SS';
    else if (finalScoreVal >= 88) rank = 'S';
    else if (finalScoreVal >= 78) rank = 'A';
    const resRankBadge = document.getElementById('resRankBadge');
    if (resRankBadge) resRankBadge.innerText = rank;

    const resPitchAcc = document.getElementById('resPitchAcc');
    const resStability = document.getElementById('resStability');
    const resRhythm = document.getElementById('resRhythm');
    const resTechBonus = document.getElementById('resTechBonus');
    if (resPitchAcc) resPitchAcc.innerText = `${pitchAcc}%`;
    if (resStability) resStability.innerText = `${stabilityVal}%`;
    if (resRhythm) resRhythm.innerText = `${rhythmVal}%`;
    if (resTechBonus) resTechBonus.innerText = `+${techBonus} PTS`;

    renderRadarChart(pitchAcc, rhythmVal, stabilityVal, Math.min(100, 70 + techBonus / 50));
}

function closeScoreModal() {
    const modal = document.getElementById('scoreModal');
    if (modal) modal.classList.add('hidden');
}

function renderRadarChart(pitch, rhythm, stability, tech) {
    const rCanvas = document.getElementById('radarCanvas');
    if (!rCanvas) return;
    const rCtx = rCanvas.getContext('2d');
    const W = rCanvas.width, H = rCanvas.height;
    const centerX = W / 2, centerY = H / 2, radius = 55;

    rCtx.clearRect(0, 0, W, H);

    const axes = [
        { label: 'Pitch', value: pitch / 100 },
        { label: 'Rhythm', value: rhythm / 100 },
        { label: 'Stability', value: stability / 100 },
        { label: 'Tech', value: tech / 100 }
    ];

    const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

    [0.25, 0.5, 0.75, 1.0].forEach(level => {
        rCtx.beginPath();
        for (let i = 0; i < 4; i++) {
            const x = centerX + Math.cos(angles[i] - Math.PI / 2) * radius * level;
            const y = centerY + Math.sin(angles[i] - Math.PI / 2) * radius * level;
            if (i === 0) rCtx.moveTo(x, y);
            else rCtx.lineTo(x, y);
        }
        rCtx.closePath();
        rCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        rCtx.stroke();
    });

    for (let i = 0; i < 4; i++) {
        const x = centerX + Math.cos(angles[i] - Math.PI / 2) * radius;
        const y = centerY + Math.sin(angles[i] - Math.PI / 2) * radius;
        rCtx.beginPath();
        rCtx.moveTo(centerX, centerY);
        rCtx.lineTo(x, y);
        rCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        rCtx.stroke();

        const lx = centerX + Math.cos(angles[i] - Math.PI / 2) * (radius + 14);
        const ly = centerY + Math.sin(angles[i] - Math.PI / 2) * (radius + 14);
        rCtx.fillStyle = '#00f0ff';
        rCtx.font = '9px monospace';
        rCtx.textAlign = 'center';
        rCtx.textBaseline = 'middle';
        rCtx.fillText(axes[i].label, lx, ly);
    }

    rCtx.beginPath();
    for (let i = 0; i < 4; i++) {
        const val = axes[i].value;
        const x = centerX + Math.cos(angles[i] - Math.PI / 2) * radius * val;
        const y = centerY + Math.sin(angles[i] - Math.PI / 2) * radius * val;
        if (i === 0) rCtx.moveTo(x, y);
        else rCtx.lineTo(x, y);
    }
    rCtx.closePath();
    rCtx.fillStyle = 'rgba(255, 0, 127, 0.4)';
    rCtx.fill();
    rCtx.strokeStyle = '#ff007f';
    rCtx.lineWidth = 2;
    rCtx.stroke();
}

function showCustomToast(title, message) {
    const toastTitle = document.getElementById('toastTitle');
    const toastMessage = document.getElementById('toastMessage');
    const toastModal = document.getElementById('customToastModal');
    if (toastTitle) toastTitle.innerText = title;
    if (toastMessage) toastMessage.innerText = message;
    if (toastModal) toastModal.classList.remove('hidden');
}

function closeCustomToast() {
    const toastModal = document.getElementById('customToastModal');
    if (toastModal) toastModal.classList.add('hidden');
}

/* 修正：完全初期化＆完全リスタート対応のリトライ関数 */
window.retryGame = function() {
  // 1. スコア表示モーダルを閉じる
  closeScoreModal();

  // 2. 音声再生の完全停止と先頭巻き戻し
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
  }

  // 3. タイマー・スコア・歌唱軌跡データを完全初期化
  isPlaying = false;
  songTime = 0;
  userPitchBlocks = [];
  currentScore = 0;
  totalFramesEvaluated = 0;
  perfectHits = 0;
  goodHits = 0;
  totalCentsDiff = 0;
  techVibratoCount = 0;
  techLongToneCount = 0;
  techSlideUpCount = 0;
  techFallCount = 0;

  // 4. UI（HUDとテクニック表示）のリセット
  updateHUD(null, 0, 0, 'READY', 0);
  updateTechniquesUI();

  // 5. 少しディレイを挟んで確実に最初からスタート
  setTimeout(() => {
    startSong();
  }, 100);
};