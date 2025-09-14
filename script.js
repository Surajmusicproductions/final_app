/* script.js — full ready-to-paste file
   - Wires pitch-processor.js AudioWorklet
   - Attempts to load CREPE ONNX via ort (if present) and falls back to YIN
   - Adds verbose status/debug logging to #status and console
   - Plays sine WebAudio voices for mic-detected notes, builds keyboard UI
   - Sends WebMIDI note on/off and pitchbend (if available)
   - HPS harmonic verification included
   - Tuned for harmonica use (defaults adjustable at top)
*/

/* ===== CONFIG ===== */
const CREPE_MODEL_URL = './crepe.onnx'; // change to location of your model if you have one
const USE_CREPE = true;                  // try to load CREPE; if missing, fallback to YIN
const CREPE_SAMPLE_RATE = 16000;
const CREPE_FRAME_SIZE = 1024;

const DETECT_INTERVAL = 60;      // ms (worklet will post frames; fallback polling uses this)
const MIN_ACCEPT_RMS = 0.015;    // energy gate
const PERCENT_TOLERANCE = 0.02;  // 2% tolerance to nearest ET note
const MIN_FREQ = 80;
const MAX_FREQ = 1500;
const HPS_REQUIRED = 0.25;       // harmonic prominence threshold
const PITCHBEND_RANGE_SEMI = 2;  // semitones

/* ===== SETUP / STATE ===== */
(() => {
  // WebAudio
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Debug/status element
  const statusEl = document.getElementById('status');
  function setStatus(msg, isErr = false) {
    try { if (statusEl) statusEl.textContent = 'Status: ' + msg; } catch (e) {}
    if (isErr) console.error('[STATUS]', msg); else console.log('[STATUS]', msg);
  }
  setStatus('Script loaded (debug enabled)');

  // Elements
  const $ = id => document.getElementById(id);
  const btnMicToggle = $('btnMicToggle');
  const btnPanic = $('btnPanic');
  const keyboardEl = $('keyboard');
  const paramAttack = $('paramAttack');
  const paramRelease = $('paramRelease');
  const paramGain = $('paramGain');
  const detectedNoteEl = $('detectedNote');
  const detectedFreqEl = $('detectedFreq');
  const sustainToggle = $('sustainToggle');
  const monoToggle = $('monoToggle');
  const midiSelect = $('midiSelect'); // optional

  // Voices / state
  const activeVoices = new Map(); // midi -> {osc,gain,master,keyEl,release}
  const pendingReleases = new Set();
  let sustainOn = false;
  let lastAutoMidi = null;

  // Analyzer for HPS
  let analyser = null;
  let freqData = null;

  // Worklet & mic
  let micStream = null;
  let micSource = null;
  let workletNode = null;

  // CREPE (ONNX) session
  let crepeSession = null;
  let crepeInputName = null;
  let crepeOutputName = null;

  // WebMIDI
  let midiAccess = null;
  let midiOut = null;
  let midiEnabled = false;
  const midiChannel = 0;

  /* ===== UTILITIES ===== */
  function computeRMS(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  function freqToMidiFloat(freq) { return 69 + 12 * Math.log2(freq / 440); }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function withinPercent(f, target, pct) { return Math.abs(f - target) / target <= pct; }
  function noteNameFromMidi(m) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[m % 12] + (Math.floor(m / 12) - 1);
  }

  /* ===== YIN fallback (compact) ===== */
  function YIN(buf, sampleRate, opts = {}) {
    const minFreq = opts.minFreq || MIN_FREQ;
    const maxFreq = opts.maxFreq || MAX_FREQ;
    const threshold = opts.threshold ?? 0.15;
    const SIZE = buf.length;
    const maxLag = Math.floor(sampleRate / minFreq);
    const minLag = Math.floor(sampleRate / maxFreq);
    const tauMax = Math.min(maxLag, SIZE - 2);
    const yin = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < SIZE - tau; i++) {
        const d = buf[i] - buf[i + tau];
        sum += d * d;
      }
      yin[tau] = sum;
    }
    let running = 0;
    yin[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += yin[tau];
      yin[tau] = yin[tau] * tau / (running || 1);
    }
    let tauEst = -1;
    for (let tau = minLag; tau <= tauMax; tau++) {
      if (yin[tau] < threshold) {
        while (tau + 1 <= tauMax && yin[tau + 1] < yin[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    const rms = computeRMS(buf);
    if (tauEst === -1) return { freq: null, prob: 0, rms };
    const x0 = Math.max(0, tauEst - 1);
    const x2 = Math.min(yin.length - 1, tauEst + 1);
    const s0 = yin[x0], s1 = yin[tauEst], s2 = yin[x2];
    const denom = (s0 + s2 - 2 * s1);
    const betterTau = (denom === 0) ? tauEst : tauEst + (s2 - s0) / (2 * denom);
    const freq = sampleRate / betterTau;
    const prob = Math.max(0, Math.min(1, 1 - yin[tauEst]));
    return { freq, prob, rms };
  }

  /* ===== HPS harmonic verification ===== */
  function computeHPSScoreFromArray(freqArray, f0) {
    if (!freqArray || freqArray.length === 0) return 0;
    const fftBins = freqArray.length;
    const binWidth = audioCtx.sampleRate / (2 * fftBins);
    const baseBin = Math.round(f0 / binWidth);
    const getMag = (b) => {
      if (b <= 0 || b >= freqArray.length) return 0;
      return Math.pow(10, freqArray[b] / 20);
    };
    const fund = getMag(baseBin);
    if (fund <= 0) return 0;
    let sum = 0, count = 0;
    for (let h = 2; h <= 5; h++) {
      const b = Math.round(baseBin * h);
      if (b >= 0 && b < freqArray.length) { sum += getMag(b); count++; }
    }
    if (count === 0) return 0;
    const ratio = (sum / count) / (fund + 1e-9);
    return Math.tanh(ratio * 3); // heuristic mapping
  }

  /* ===== WebMIDI ===== */
  async function initMIDI() {
    if (!navigator.requestMIDIAccess) { setStatus('WebMIDI not available — MIDI disabled'); return; }
    try {
      midiAccess = await navigator.requestMIDIAccess();
      const outs = Array.from(midiAccess.outputs.values());
      midiOut = outs.length ? outs[0] : null;
      midiEnabled = !!midiOut;
      setStatus('MIDI ' + (midiEnabled ? ('enabled: ' + (midiOut.name || midiOut.id)) : 'no outputs'));
      // populate midiSelect if present
      if (midiSelect) {
        midiSelect.innerHTML = '';
        const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
        midiSelect.appendChild(noneOpt);
        midiAccess.outputs.forEach((o) => {
          const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.name || o.id;
          midiSelect.appendChild(opt);
        });
        if (midiOut) midiSelect.value = midiOut.id;
        midiSelect.addEventListener('change', (e) => {
          const id = e.target.value;
          if (!id) { midiOut = null; midiEnabled = false; return; }
          const out = midiAccess.outputs.get(id);
          midiOut = out || null; midiEnabled = !!midiOut;
        });
      }
    } catch (e) {
      setStatus('MIDI init failed', true);
      console.warn('MIDI init failed', e);
    }
  }
  function sendMIDIOn(note, vel = 100) { if (!midiOut) return; midiOut.send([0x90 | (midiChannel & 0x0f), note & 0x7f, vel & 0x7f]); }
  function sendMIDIOff(note) { if (!midiOut) return; midiOut.send([0x80 | (midiChannel & 0x0f), note & 0x7f, 0]); }
  function sendPitchBend(value14) { if (!midiOut) return; const v = Math.max(-8192, Math.min(8191, Math.round(value14))) + 8192; midiOut.send([0xE0 | (midiChannel & 0x0f), v & 0x7f, (v >> 7) & 0x7f]); }

  /* ===== Synth helpers ===== */
  function createVoice(freq, isAuto = false) {
    const osc = audioCtx.createOscillator();
    if (isAuto) {
      try { osc.type = 'sine'; } catch (e) {}
      osc.frequency.value = freq;
    } else {
      try {
        const real = new Float32Array([0,1]);
        const imag = new Float32Array([0,0]);
        const wave = audioCtx.createPeriodicWave(real, imag);
        osc.setPeriodicWave(wave);
      } catch (e) {}
      osc.frequency.value = freq;
    }
    const g = audioCtx.createGain();
    const master = audioCtx.createGain();
    master.gain.value = paramGain ? parseFloat(paramGain.value) : 0.8;
    osc.connect(g).connect(master).connect(audioCtx.destination);
    return { osc, gain: g, master };
  }

  function noteOnWebAudio(midi, freq, keyEl, isAuto = false) {
    if (activeVoices.has(midi)) forceStop(midi);
    const { osc, gain, master } = createVoice(freq, isAuto);
    const attack = paramAttack ? parseFloat(paramAttack.value) : 0.01;
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + attack);
    osc.start();
    if (keyEl) keyEl.classList.add('active');
    activeVoices.set(midi, { osc, gain, master, keyEl, release: (paramRelease ? parseFloat(paramRelease.value) : 0.4) });
    if (btnPanic) btnPanic.disabled = false;
  }

  function noteOffWebAudio(midi) {
    const v = activeVoices.get(midi);
    if (!v) return;
    const release = v.release || 0.3;
    v.gain.gain.cancelScheduledValues(audioCtx.currentTime);
    v.gain.gain.setTargetAtTime(0.0001, audioCtx.currentTime, Math.max(0.01, release / 3));
    try { v.osc.stop(audioCtx.currentTime + release); } catch (e) {}
    if (v.keyEl) v.keyEl.classList.remove('active');
    activeVoices.delete(midi);
  }

  function forceStop(midi) {
    const v = activeVoices.get(midi);
    if (!v) return;
    try { v.osc.stop(); } catch (e) {}
    if (v.keyEl) v.keyEl.classList.remove('active');
    activeVoices.delete(midi);
  }

  /* ===== Keyboard UI ===== */
  function buildKeyboard() {
    if (!keyboardEl) return;
    keyboardEl.innerHTML = '';
    const startMidi = 48;
    const count = 49;
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for (let i = 0; i < count; i++) {
      const midi = startMidi + i;
      const label = names[midi % 12] + (Math.floor(midi / 12) - 1);
      const key = document.createElement('button');
      key.className = 'key' + (label.includes('#') ? ' black' : '');
      key.textContent = label.replace('#', '♯');
      key.dataset.midi = midi;
      key.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        noteOnWebAudio(midi, midiToFreq(midi), key, false);
        if (midiEnabled && midiOut) sendMIDIOn(midi);
      });
      key.addEventListener('pointerup', () => {
        noteOffWebAudio(midi);
        if (midiEnabled && midiOut) sendMIDIOff(midi);
      });
      keyboardEl.appendChild(key);
    }
    setStatus('Keyboard built');
  }
  buildKeyboard();

  /* ===== CREPE loader (ONNX) ===== */
  async function tryLoadCrepe() {
    if (!USE_CREPE) { setStatus('CREPE disabled (config)'); return false; }
    if (typeof ort === 'undefined') { setStatus('ONNX Runtime (ort) not loaded — CREPE skipped'); return false; }
    setStatus('Loading CREPE model...');
    try {
      crepeSession = await ort.InferenceSession.create(CREPE_MODEL_URL);
      // try to detect input/output names
      if (crepeSession.inputNames && crepeSession.inputNames.length) crepeInputName = crepeSession.inputNames[0];
      else if (crepeSession.inputMetadata) crepeInputName = Object.keys(crepeSession.inputMetadata)[0];
      if (crepeSession.outputNames && crepeSession.outputNames.length) crepeOutputName = crepeSession.outputNames[0];
      else if (crepeSession.outputMetadata) crepeOutputName = Object.keys(crepeSession.outputMetadata)[0];
      setStatus('CREPE model loaded');
      console.log('CREPE input:', crepeInputName, 'output:', crepeOutputName);
      return true;
    } catch (e) {
      setStatus('CREPE load failed — using YIN', true);
      console.warn('CREPE load failed', e);
      crepeSession = null;
      return false;
    }
  }

  /* ===== Worklet wrapper with debug ===== */
  async function debugAddWorklet(modulePath) {
    setStatus('Loading AudioWorklet: ' + modulePath);
    try {
      await audioCtx.audioWorklet.addModule(modulePath);
      setStatus('Worklet module loaded');
      console.log('Worklet addModule succeeded');
      return true;
    } catch (err) {
      setStatus('Worklet failed: ' + (err && err.message ? err.message : err), true);
      console.error('Worklet addModule error', err);
      return false;
    }
  }

  /* ===== Process frame (called by worklet or fallback) ===== */
  async function processFrameFromWorklet(frame) {
    if (!frame || frame.length === 0) return;
    const rms = computeRMS(frame);
    if (rms < MIN_ACCEPT_RMS) { clearDetection(); return; }

    // If CREPE available, run inference
    if (crepeSession) {
      try {
        const inputName = crepeInputName;
        const inputTensor = new ort.Tensor('float32', Float32Array.from(frame), [1, frame.length]);
        const feeds = {}; feeds[inputName] = inputTensor;
        const results = await crepeSession.run(feeds);
        const outName = crepeOutputName || Object.keys(results)[0];
        const out = results[outName];
        const data = out.data;
        // softmax
        let max = -Infinity;
        for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
        let s = 0;
        const probs = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) { probs[i] = Math.exp(data[i] - max); s += probs[i]; }
        for (let i = 0; i < probs.length; i++) probs[i] /= (s || 1);
        // weighted freq
        let sumP = 0, sumFP = 0, maxP = 0, maxIdx = 0;
        for (let i = 0; i < probs.length; i++) {
          const p = probs[i];
          const f = crepeBinToFreq(i);
          sumP += p; sumFP += p * f;
          if (p > maxP) { maxP = p; maxIdx = i; }
        }
        const freq = sumP > 0 ? (sumFP / sumP) : crepeBinToFreq(maxIdx);
        const confidence = maxP;
        // update analyser freqData for HPS
        if (analyser) analyser.getFloatFrequencyData(freqData);
        handleDetectedPitch(freq, confidence, rms);
        return;
      } catch (e) {
        console.warn('CREPE inference error — disabling CREPE', e);
        crepeSession = null;
        // fallback to YIN below
      }
    }

    // Fallback YIN on the frame (frame is 16k sample-rate)
    const yinRes = YIN(frame, CREPE_SAMPLE_RATE, { minFreq: MIN_FREQ, maxFreq: MAX_FREQ, threshold: 0.15 });
    if (!yinRes.freq || yinRes.rms < MIN_ACCEPT_RMS) { clearDetection(); return; }
    if (analyser) analyser.getFloatFrequencyData(freqData);
    const hpsScore = analyser ? computeHPSScoreFromArray(freqData, yinRes.freq) : 0;
    const accepted = (yinRes.prob >= 0.4) || (hpsScore >= HPS_REQUIRED && yinRes.prob >= 0.25);
    if (!accepted) { clearDetection(); return; }
    handleDetectedPitch(yinRes.freq, yinRes.prob, yinRes.rms);
  }

  /* ===== handle detected pitch (common) ===== */
  function handleDetectedPitch(freq, confidence, rms) {
    if (!freq || freq < MIN_FREQ || freq > MAX_FREQ) { clearDetection(); return; }
    const midiFloat = freqToMidiFloat(freq);
    const nearestMidi = Math.round(midiFloat);
    const nearestFreq = midiToFreq(nearestMidi);
    if (!withinPercent(freq, nearestFreq, PERCENT_TOLERANCE)) { clearDetection(); return; }
    const noteName = noteNameFromMidi(nearestMidi);
    if (detectedNoteEl) detectedNoteEl.textContent = noteName;
    if (detectedFreqEl) detectedFreqEl.textContent = `${freq.toFixed(1)} Hz`;

    // continuity and pitchbend
    if (lastAutoMidi === nearestMidi) {
      const v = activeVoices.get(nearestMidi);
      if (v && Math.abs(v.osc.frequency.value - freq) > 0.5) {
        try { v.osc.frequency.setValueAtTime(freq, audioCtx.currentTime); } catch (e) {}
      }
      if (midiEnabled && midiOut) {
        const pb = computePitchBendForFreq(freq, nearestMidi, PITCHBEND_RANGE_SEMI);
        sendPitchBend(pb);
      }
    } else {
      if (lastAutoMidi !== null) {
        if (sustainOn) pendingReleases.add(lastAutoMidi);
        else {
          noteOffWebAudio(lastAutoMidi);
          if (midiEnabled && midiOut) sendMIDIOff(lastAutoMidi);
        }
      }
      const keyEl = keyboardEl ? keyboardEl.querySelector(`.key[data-midi="${nearestMidi}"]`) : null;
      noteOnWebAudio(nearestMidi, freq, keyEl, true);
      if (midiEnabled && midiOut) {
        sendMIDIOn(nearestMidi, 100);
        const pb = computePitchBendForFreq(freq, nearestMidi, PITCHBEND_RANGE_SEMI);
        sendPitchBend(pb);
      }
      lastAutoMidi = nearestMidi;
    }
  }

  function clearDetection() {
    if (detectedNoteEl) detectedNoteEl.textContent = '—';
    if (detectedFreqEl) detectedFreqEl.textContent = '—';
    if (lastAutoMidi !== null) {
      if (sustainOn) pendingReleases.add(lastAutoMidi);
      else {
        noteOffWebAudio(lastAutoMidi);
        if (midiEnabled && midiOut) sendMIDIOff(lastAutoMidi);
      }
      lastAutoMidi = null;
    }
  }

  /* ===== CREPE helpers ===== */
  function crepeBinToFreq(binIndex) {
    // CREPE base mapping: very approximate; many CREPE versions use different mapping.
    // This uses base freq and 20-cent steps as an approximate mapping.
    const base = 32.70319566257483; // C1
    const cents = binIndex * 20;
    return base * Math.pow(2, cents / 1200);
  }

  /* ===== small math helpers ===== */
  function computePitchBendForFreq(freq, midiNote, bendRangeSemis = PITCHBEND_RANGE_SEMI) {
    const base = midiToFreq(midiNote);
    const cents = 1200 * Math.log2(freq / base);
    const semis = cents / 100.0;
    const norm = Math.max(-1, Math.min(1, semis / bendRangeSemis));
    return norm * 8191;
  }

  /* ===== Worklet + mic start/stop ===== */
  async function startWorkletAndMic() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Try to add worklet
    const workletOk = await debugAddWorkletSafe('pitch-processor.js');

    // Create analyser for HPS / fallback
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    freqData = new Float32Array(analyser.frequencyBinCount);

    // get mic stream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      setStatus('Microphone permission granted — streaming');
    } catch (e) {
      setStatus('Microphone permission denied or failed', true);
      console.error('getUserMedia failed', e);
      throw e;
    }

    micSource = audioCtx.createMediaStreamSource(micStream);
    // connect analyser
    micSource.connect(analyser);

    // Load CREPE model (non-blocking)
    tryLoadCrepe().catch(() => {});

    // If worklet available, create node and connect
    if (workletOk && typeof AudioWorkletNode !== 'undefined') {
      try {
        workletNode = new AudioWorkletNode(audioCtx, 'pitch-processor');
        workletNode.port.onmessage = (ev) => {
          // worklet posts raw Float32Array frames at 16k
          const frame = ev.data;
          let f;
          if (frame instanceof Float32Array) f = frame;
          else if (frame && frame.data) f = new Float32Array(frame.data);
          else f = Float32Array.from(frame);
          // Update analyser data for HPS (optional)
          if (analyser) analyser.getFloatFrequencyData(freqData);
          processFrameFromWorklet(f).catch(e => { console.warn('processFrame error', e); });
        };
        // connect mic -> worklet (worklet receives audio in its process())
        micSource.connect(workletNode);
        // if worklet produces audio, you might connect it — ours does not output audio
        setStatus('Worklet running, frames will be processed');
      } catch (e) {
        console.warn('Worklet creation failed, falling back to polling', e);
        setStatus('Worklet node creation failed — using fallback', true);
        fallbackPollingStart();
      }
    } else {
      // fallback
      fallbackPollingStart();
    }
  }

  // safe wrapper for addModule with logging
  async function debugAddWorkletSafe(path) {
    if (!audioCtx.audioWorklet) {
      setStatus('AudioWorklet not supported in this browser', true);
      return false;
    }
    try {
      setStatus('Loading worklet: ' + path);
      await audioCtx.audioWorklet.addModule(path);
      setStatus('Worklet module loaded');
      return true;
    } catch (e) {
      setStatus('Worklet load failed: ' + (e && e.message ? e.message : e), true);
      console.error('addModule failed', e);
      return false;
    }
  }

  // Fallback: poll analyser and downsample to 16k frames
  const fallbackIntervalIdHolder = { id: null };
  function fallbackPollingStart() {
    setStatus('Fallback polling started (no worklet)');
    // We'll read from analyser's time domain and downsample to 16k frames
    const bufSize = 2048;
    const tempBuf = new Float32Array(bufSize);
    fallbackIntervalIdHolder.id = setInterval(async () => {
      try {
        analyser.getFloatTimeDomainData(tempBuf);
        const frame = downsampleTo16k(tempBuf, audioCtx.sampleRate, CREPE_FRAME_SIZE);
        // update freqData for HPS
        if (analyser) analyser.getFloatFrequencyData(freqData);
        await processFrameFromWorklet(frame);
      } catch (e) {
        console.warn('fallback polling error', e);
      }
    }, DETECT_INTERVAL);
  }

  function downsampleTo16k(float32Buffer, fromRate, outLen) {
    if (fromRate === CREPE_SAMPLE_RATE && float32Buffer.length >= outLen) {
      return float32Buffer.slice(0, outLen);
    }
    const ratio = fromRate / CREPE_SAMPLE_RATE;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(float32Buffer.length - 1, i0 + 1);
      const frac = idx - i0;
      out[i] = float32Buffer[i0] + (float32Buffer[i1] - float32Buffer[i0]) * frac;
    }
    return out;
  }

  /* ===== start/stop wiring ===== */
  if (btnMicToggle) {
    btnMicToggle.addEventListener('click', async () => {
      try {
        if (!micStream) {
          initMIDI().catch(() => {});
          tryLoadCrepe().catch(() => {});
          await startWorkletAndMic();
          btnMicToggle.textContent = '🛑 Stop Mic Mode';
        } else {
          stopAll();
          btnMicToggle.textContent = '🎤 Start Mic Mode';
        }
      } catch (err) {
        console.error('start failed', err);
        setStatus('Start failed: ' + (err && err.message ? err.message : err), true);
        alert('Mic start failed: ' + (err && err.message ? err.message : err));
      }
    });
  }

  function stopAll() {
    if (fallbackIntervalIdHolder.id) { clearInterval(fallbackIntervalIdHolder.id); fallbackIntervalIdHolder.id = null; }
    if (workletNode) {
      try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch (e) {}
      workletNode = null;
    }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (micSource) { try { micSource.disconnect(); } catch (e) {} micSource = null; }
    if (analyser) { try { analyser.disconnect(); } catch (e) {} analyser = null; }
    clearDetection();
    setStatus('Stopped');
  }

  /* ===== UI controls ===== */
  if (sustainToggle) {
    sustainToggle.addEventListener('change', (e) => {
      sustainOn = e.target.checked;
      if (!sustainOn) {
        for (const mid of Array.from(pendingReleases)) {
          noteOffWebAudio(mid);
          if (midiEnabled && midiOut) sendMIDIOff(mid);
          pendingReleases.delete(mid);
        }
      }
    });
  }

  if (btnPanic) {
    btnPanic.addEventListener('click', () => {
      for (const [m] of activeVoices) forceStop(m);
      activeVoices.clear();
      pendingReleases.clear();
      document.querySelectorAll('.key.active').forEach(k => k.classList.remove('active'));
      if (midiEnabled && midiOut) midiOut.send([0xB0, 0x7B, 0x00]); // all notes off
      btnPanic.disabled = true;
      setStatus('Panic: all notes off');
    });
  }

  /* ===== pitchbend helper wrapper ===== */
  function sendPitchBend(value14) {
    if (!midiOut) return;
    const v = Math.max(-8192, Math.min(8191, Math.round(value14))) + 8192;
    const l = v & 0x7f; const h = (v >> 7) & 0x7f;
    midiOut.send([0xE0 | (midiChannel & 0x0f), l, h]);
  }

  /* ===== Helpers exposed for debug (console) ===== */
  window._micStart = async () => { if (!micStream) await startWorkletAndMic(); };
  window._micStop = () => { stopAll(); };
  window._status = () => statusEl ? statusEl.textContent : '(no status element)';

  setStatus('Ready');

  /* ===== small helper functions used earlier (redeclared for completeness) ===== */
  function crepeBinToFreq(binIndex) {
    const base = 32.70319566257483; // C1
    const cents = binIndex * 20;
    return base * Math.pow(2, cents / 1200);
  }

  /* ===== Done ===== */
  console.log('script.js loaded — worklet + CREPE integration enabled (with debug).');
})();
