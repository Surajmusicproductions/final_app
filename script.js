// Mic → Synth (pure mic-to-synth, no waveform or file logic)
(() => {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Voice state
  const activeVoices = new Map(); // midi -> {osc, gain, release, keyEl, master, autoStopped}
  const pendingReleases = new Set();
  let sustainOn = false;

  // Mic detection
  let micStream = null;
  let micSource = null;
  let micAnalyser = null;
  let micDataArray = null;
  let micRunning = false;
  const DETECT_INTERVAL = 60;
  let micTimer = null;

  // UI bind
  const el = id => document.getElementById(id);
  const btnMicToggle = el('btnMicToggle');
  const btnPanic = el('btnPanic');
  const presetSelect = el('presetSelect');
  const detectedNoteEl = el('detectedNote');
  const detectedFreqEl = el('detectedFreq');
  const keyboardEl = el('keyboard');
  const paramAttack = el('paramAttack');
  const paramRelease = el('paramRelease');
  const paramGain = el('paramGain');
  const sustainToggle = el('sustainToggle');
  const monoToggle = el('monoToggle');

  // Build keyboard notes
  const notes = buildKeyboardNotes();
  buildKeyboardUI(notes);

  function buildKeyboardNotes() {
    const startMidi = 48; // C3
    const count = 49;
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const arr = [];
    for (let i = 0; i < count; i++) {
      const midi = startMidi + i;
      const n = midi - 69;
      const freq = 440 * Math.pow(2, n / 12);
      const name = names[midi % 12] + Math.floor(midi/12 - 1);
      const isBlack = name.includes('#');
      arr.push({ name, midi, freq, isBlack });
    }
    return arr;
  }

  function buildKeyboardUI(notes) {
    notes.forEach((note) => {
      const key = document.createElement('button');
      key.className = 'key' + (note.isBlack ? ' black' : '');
      key.textContent = note.name.replace('#', '♯');
      key.dataset.midi = note.midi;
      key.dataset.freq = note.freq.toFixed(4);

      key.addEventListener('pointerdown', (e) => { e.preventDefault(); noteOn(note, key); });
      key.addEventListener('pointerup', () => noteReleaseRequest(note, key));
      key.addEventListener('pointerleave', (e) => { if (e.pressure === 0) return; noteReleaseRequest(note, key); });

      keyboardEl.appendChild(key);
    });

    // computer keyboard mapping for quick play
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const mapping = 'awsedftgyhujk'; // simple map
      const idx = mapping.indexOf(e.key.toLowerCase());
      if (idx >= 0) {
        const note = notes[idx];
        if (note) {
          const keyEl = keyboardEl.querySelector(`.key[data-midi="${note.midi}"]`);
          noteOn(note, keyEl);
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      const mapping = 'awsedftgyhujk';
      const idx = mapping.indexOf(e.key.toLowerCase());
      if (idx >= 0) {
        const note = notes[idx];
        if (note) {
          const keyEl = keyboardEl.querySelector(`.key[data-midi="${note.midi}"]`);
          noteReleaseRequest(note, keyEl);
        }
      }
    });
  }

  // Preset periodic waves
  function createPresetPeriodicWave(type='guitar') {
    if (type === 'sine') {
      const real = new Float32Array([0,1]);
      const imag = new Float32Array([0,0]);
      return audioCtx.createPeriodicWave(real, imag);
    }
    const maxH = 64;
    const real = new Float32Array(maxH+1);
    const imag = new Float32Array(maxH+1);
    if (type === 'guitar') {
      for (let n=1; n<=maxH; n++) {
        real[n] = 1 / (n * (0.6 + 0.4*Math.sin(n*0.3)));
        real[n] *= 1/Math.sqrt(n);
      }
    } else if (type === 'sax') {
      for (let n=1; n<=maxH; n++) {
        real[n] = (n <= 8 ? (1.2 - n*0.12) : 0.6/(n));
        imag[n] = (Math.random()-0.5)*0.05;
      }
    }
    const max = Math.max(...real);
    if (max>0) for (let i=1;i<real.length;i++) real[i] = real[i]/max;
    return audioCtx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  // Voice management
  function noteOn(note, keyEl, options={autoStopped:false}) {
    const presetMode = presetSelect.value;
    if (monoToggle && monoToggle.checked) {
      // stop all other voices before starting this one
      for (const [midiKey] of activeVoices) {
        if (midiKey !== note.midi) forceStop(midiKey);
      }
    }

    if (activeVoices.has(note.midi)) forceStop(note.midi);

    const osc = audioCtx.createOscillator();
    const wave = createPresetPeriodicWave(presetMode || 'guitar');
    osc.setPeriodicWave(wave);
    osc.frequency.value = note.freq;

    const g = audioCtx.createGain();
    const master = audioCtx.createGain();
    master.gain.value = parseFloat(paramGain.value);

    const now = audioCtx.currentTime;
    const attack = parseFloat(paramAttack.value);
    const release = parseFloat(paramRelease.value);
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + attack);

    osc.connect(g).connect(master).connect(audioCtx.destination);
    osc.start();

    keyEl?.classList.add('active');
    activeVoices.set(note.midi, { osc, gain: g, release, keyEl, master, autoStopped: !!options.autoStopped });

    osc.onended = () => {
      if (activeVoices.get(note.midi)?.osc === osc) {
        activeVoices.delete(note.midi);
        keyEl?.classList.remove('active');
      }
    };

    btnPanic.disabled = false;
  }

  function noteReleaseRequest(note, keyEl) {
    if (!activeVoices.has(note.midi)) return;
    if (sustainOn) { pendingReleases.add(note.midi); return; }
    noteOff(note.midi);
  }

  function noteOff(midi) {
    const v = activeVoices.get(midi);
    if (!v) return;
    const now = audioCtx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.01, v.release / 3));
    try { v.osc.stop(now + v.release); } catch {}
    v.keyEl?.classList.remove('active');
    activeVoices.delete(midi);
    pendingReleases.delete(midi);
  }

  function forceStop(midi) {
    const v = activeVoices.get(midi);
    if (!v) return;
    try { v.osc.stop(); } catch {}
    v.keyEl?.classList.remove('active');
    activeVoices.delete(midi);
    pendingReleases.delete(midi);
  }

  // UI control wiring
  sustainToggle.addEventListener('change', (e) => {
    sustainOn = e.target.checked;
    if (!sustainOn) {
      for (const noteId of [...pendingReleases]) {
        noteOff(noteId);
        pendingReleases.delete(noteId);
      }
    }
  });

  btnPanic.addEventListener('click', () => {
    for (const [noteId] of activeVoices) forceStop(noteId);
    activeVoices.clear();
    pendingReleases.clear();
    document.querySelectorAll('.key.active').forEach(k => k.classList.remove('active'));
    btnPanic.disabled = true;
  });

  paramGain.addEventListener('input', () => {
    activeVoices.forEach(v => v.master.gain.value = parseFloat(paramGain.value));
  });

  // ---- Mic controls ----
  btnMicToggle.addEventListener('click', async () => {
    if (!micRunning) {
      try {
        await startMic();
        btnMicToggle.textContent = '🛑 Stop Mic Mode';
      } catch (err) {
        alert('Mic access failed: ' + (err && err.message ? err.message : err));
      }
    } else {
      stopMic();
      btnMicToggle.textContent = '🎤 Start Mic Mode';
    }
  });

  async function startMic() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video:false });
    micSource = audioCtx.createMediaStreamSource(micStream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 2048;
    micAnalyser.smoothingTimeConstant = 0.1;
    const bufLen = micAnalyser.fftSize;
    micDataArray = new Float32Array(bufLen);
    micSource.connect(micAnalyser);
    micRunning = true;
    micTimer = setInterval(detectAndTrigger, DETECT_INTERVAL);
  }

  function stopMic() {
    micRunning = false;
    if (micTimer) { clearInterval(micTimer); micTimer = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
    if (micAnalyser) { try { micAnalyser.disconnect(); } catch {} micAnalyser = null; }
    detectedNoteEl.textContent = '—';
    detectedFreqEl.textContent = '—';
  }

  // detection loop
  let lastAutoNote = null;
  function detectAndTrigger() {
    if (!micAnalyser) return;
    micAnalyser.getFloatTimeDomainData(micDataArray);
    const f = autoCorrelate(micDataArray, audioCtx.sampleRate);
    if (f && f > 40 && f < 5000) {
      const midi = freqToMidi(f);
      const nearest = findNearestNote(midi);
      const note = notes.find(n => n.midi === nearest);
      detectedNoteEl.textContent = note?.name || '—';
      detectedFreqEl.textContent = `${f.toFixed(1)} Hz`;
      if (!lastAutoNote || lastAutoNote !== nearest) {
        // release previous auto note (respect sustain)
        if (lastAutoNote && lastAutoNote !== nearest) {
          if (sustainOn) pendingReleases.add(lastAutoNote);
          else noteOff(lastAutoNote);
        }
        // if mono toggle is on, stop all others first (handled in noteOn)
        const keyEl = keyboardEl.querySelector(`.key[data-midi="${note.midi}"]`);
        noteOn(note, keyEl, {autoStopped:true});
        lastAutoNote = nearest;
      }
    } else {
      // input too quiet / no pitch
      detectedNoteEl.textContent = '—';
      detectedFreqEl.textContent = '—';
      if (lastAutoNote) {
        if (sustainOn) pendingReleases.add(lastAutoNote);
        else noteOff(lastAutoNote);
        lastAutoNote = null;
      }
    }
  }

  // simple autocorrelation pitch detection
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) { const val = buf[i]; rms += val*val; }
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.002) return null;

    let bestOffset = -1;
    let bestCorr = 0;
    const MIN_FREQ = 50; const MAX_FREQ = 2000;
    const maxLag = Math.floor(sampleRate / MIN_FREQ);
    const minLag = Math.floor(sampleRate / MAX_FREQ);

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < SIZE - lag; i++) corr += Math.abs(buf[i] - buf[i + lag]);
      corr = 1 - (corr / (SIZE - lag));
      if (corr > bestCorr) { bestCorr = corr; bestOffset = lag; }
    }

    if (bestCorr > 0.35 && bestOffset > 0) {
      return sampleRate / bestOffset;
    }
    return null;
  }

  function freqToMidi(freq) { return Math.round(69 + 12*Math.log2(freq/440)); }
  function midiToFreq(midi) { return 440 * Math.pow2 ? 440 * Math.pow2((midi-69)/12) : 440 * Math.pow(2, (midi-69)/12); }
  function findNearestNote(midi) {
    const minMidi = notes[0].midi;
    const maxMidi = notes[notes.length-1].midi;
    return Math.min(maxMidi, Math.max(minMidi, midi));
  }

  // Polyfill-safe Math.pow wrapper (in case of old hosts)
  Math.pow2 = Math.pow2 || Math.pow;

  // End of module
})();
