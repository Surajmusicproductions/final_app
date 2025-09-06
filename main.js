// === Main Synthesizer Logic ===
document.addEventListener('DOMContentLoaded', async () => {

    // Global variables
    let audioCtx;
    let audioBuffer = null;
    let sampleStart = 0;
    let sampleEnd = 1;
    const activeNotes = new Map();

    // DOM Element references
    const audioFile = document.getElementById('audioFile');
    const waveformCanvas = document.getElementById('waveformCanvas');
    const ctx = waveformCanvas.getContext('2d');
    const piano = document.getElementById('piano');

    // ADSR Sliders and values
    const attackSlider = document.getElementById('attackSlider');
    const decaySlider = document.getElementById('decaySlider');
    const sustainSlider = document.getElementById('sustainSlider');
    const releaseSlider = document.getElementById('releaseSlider');
    const attackValue = document.getElementById('attackValue');
    const decayValue = document.getElementById('decayValue');
    const sustainValue = document.getElementById('sustainValue');
    const releaseValue = document.getElementById('releaseValue');

    // Update ADSR value displays
    attackSlider.oninput = () => attackValue.textContent = `${parseFloat(attackSlider.value).toFixed(2)}s`;
    decaySlider.oninput = () => decayValue.textContent = `${parseFloat(decaySlider.value).toFixed(2)}s`;
    sustainSlider.oninput = () => sustainValue.textContent = `${parseFloat(sustainSlider.value).toFixed(2)}`;
    releaseSlider.oninput = () => releaseValue.textContent = `${parseFloat(releaseSlider.value).toFixed(2)}s`;

    // Note mapping: maps a musical note to its semitone offset from A4 (440Hz)
    const noteSemitoneOffsets = {
      'C4': -9, 'C#4': -8, 'D4': -7, 'D#4': -6, 'E4': -5, 'F4': -4, 'F#4': -3,
      'G4': -2, 'G#4': -1, 'A4': 0, 'A#4': 1, 'B4': 2, 'C5': 3, 'C#5': 4
    };

    // --- Message Box UI ---
    // A simple replacement for alert() and confirm()
    const createMessageBox = (message, type = 'info') => {
      const container = document.createElement('div');
      container.className = `fixed bottom-4 right-4 p-4 rounded-lg shadow-xl text-white z-50 transition-transform transform translate-y-full opacity-0`;

      let bgColor;
      if (type === 'error') bgColor = 'bg-red-500';
      else if (type === 'success') bgColor = 'bg-green-500';
      else bgColor = 'bg-blue-500';

      container.classList.add(bgColor);
      container.textContent = message;
      document.body.appendChild(container);

      // Animate in and out
      setTimeout(() => {
        container.classList.remove('translate-y-full', 'opacity-0');
        container.classList.add('translate-y-0', 'opacity-100');
      }, 10);

      setTimeout(() => {
        container.classList.remove('translate-y-0', 'opacity-100');
        container.classList.add('translate-y-full', 'opacity-0');
        setTimeout(() => container.remove(), 500);
      }, 3000);
    };

    // Initialize the audio context and the phase vocoder bundle
    const initSynth = async () => {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (typeof PhaseVocoderBundle === 'undefined') {
            createMessageBox('PhaseVocoderBundle not found. Ensure phase-vocoder-bundle.js is loaded.', 'error');
            return;
        }
        await PhaseVocoderBundle.init(audioCtx);

        createMessageBox('AudioWorklet and AudioContext initialized.', 'success');

        try {
            await PhaseVocoderBundle.loadWasmFromUrl('./PhaseVocoderModule.wasm');
            createMessageBox('WASM module loaded successfully!', 'success');
        } catch (err) {
            console.error(err);
            createMessageBox('Failed to load WASM module. See console for details.', 'error');
        }
    };
    initSynth();

    // === Waveform Drawing and Selection ===
    const drawWaveform = () => {
      if (!audioBuffer) return;
      const width = waveformCanvas.width;
      const height = waveformCanvas.height;
      const data = audioBuffer.getChannelData(0);
      const step = Math.ceil(data.length / width);
      const amp = height / 2;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#1f2937'; // Background
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#4ade80'; // Waveform color (Tailwind green-400)
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(0, amp);
      for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
          const datum = data[Math.floor((i * step) + j)];
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }
        ctx.lineTo(i, (1 + min) * amp);
      }
      ctx.lineTo(width, amp);
      for (let i = width - 1; i >= 0; i--) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
          const datum = data[Math.floor((i * step) + j)];
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }
        ctx.lineTo(i, (1 + max) * amp);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#10B981';
      ctx.fill();

      // Draw the selection overlay
      const startX = sampleStart * width;
      const endX = sampleEnd * width;
      ctx.fillStyle = 'rgba(191, 219, 254, 0.2)'; // Blue-200 with transparency
      ctx.fillRect(startX, 0, endX - startX, height);

      // Update marker positions
      const startMarker = document.getElementById('startMarker');
      const endMarker = document.getElementById('endMarker');
      if (startMarker) startMarker.style.left = `${startX}px`;
      if (endMarker) endMarker.style.left = `${endX}px`;
    };

    // Draggable marker logic
    let activeMarker = null;
    waveformCanvas.addEventListener('mousedown', (e) => {
        const rect = waveformCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        const startX = sampleStart * width;
        const endX = sampleEnd * width;

        if (Math.abs(x - startX) < 10) {
            activeMarker = 'start';
        } else if (Math.abs(x - endX) < 10) {
            activeMarker = 'end';
        } else {
             // If not dragging a marker, start a new selection
            activeMarker = 'new';
            sampleStart = x / width;
            sampleEnd = x / width;
        }
        e.preventDefault();
    });

    waveformCanvas.addEventListener('mousemove', (e) => {
      if (!activeMarker) return;
      const rect = waveformCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;

      let newPos = x / width;
      if (newPos < 0) newPos = 0;
      if (newPos > 1) newPos = 1;

      if (activeMarker === 'start') {
          if (newPos < sampleEnd) {
              sampleStart = newPos;
          }
      } else if (activeMarker === 'end') {
          if (newPos > sampleStart) {
              sampleEnd = newPos;
          }
      } else if (activeMarker === 'new') {
          const [min, max] = [Math.min(x, e.clientX - rect.left) / width, Math.max(x, e.clientX - rect.left) / width];
          sampleStart = Math.min(min, max);
          sampleEnd = Math.max(min, max);
      }
      drawWaveform();
    });

    waveformCanvas.addEventListener('mouseup', () => {
        activeMarker = null;
    });

    // Audio file upload handler
    audioFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        if (!audioCtx) {
            createMessageBox('AudioContext not initialized.', 'error');
            return;
        }
        audioCtx.decodeAudioData(event.target.result)
          .then(buffer => {
            audioBuffer = buffer;
            sampleStart = 0;
            sampleEnd = 1;
            resizeCanvas();

            // Load the new sample into the WASM module
            const startFrame = Math.floor(audioBuffer.length * sampleStart);
            const endFrame = Math.floor(audioBuffer.length * sampleEnd);
            const selectedLength = endFrame - startFrame;
            const segment = new Float32Array(selectedLength);
            audioBuffer.getChannelData(0).subarray(startFrame, endFrame).forEach((value, index) => {
              segment[index] = value;
            });
            if (PhaseVocoderBundle.isWasmReady()) {
                PhaseVocoderBundle.loadSample(segment, audioBuffer.sampleRate);
            } else {
                createMessageBox('WASM module not ready. Please wait a moment.', 'error');
            }
          })
          .catch(err => {
            console.error('Error decoding audio data:', err);
            createMessageBox('Error decoding audio file.', 'error');
          });
      };
      reader.readAsArrayBuffer(file);
    });

    // === Piano Keyboard Logic ===
    const playNote = (note, keyElement) => {
      if (!audioBuffer) {
        createMessageBox('Please upload an audio file first.', 'error');
        return;
      }
      if (!PhaseVocoderBundle.isWasmReady()) {
        createMessageBox('WASM module not ready. Please wait.', 'error');
        return;
      }

      keyElement.classList.add('active');
      const semitones = noteSemitoneOffsets[note];

      const noteId = PhaseVocoderBundle.startNote('note-' + note, semitones, { gain: 1.0 });
      activeNotes.set(note, { noteId, keyElement });
    };

    const stopNoteAndCleanup = (note) => {
      if (activeNotes.has(note)) {
        const { noteId, keyElement } = activeNotes.get(note);
        PhaseVocoderBundle.stopNote(noteId);
        keyElement.classList.remove('active');
        activeNotes.delete(note);
      }
    };

    // Keyboard event listeners
    piano.addEventListener('mousedown', (e) => {
      const targetKey = e.target.closest('.white-key, .black-key');
      if (targetKey) {
        const note = targetKey.dataset.note;
        if (!activeNotes.has(note)) {
          playNote(note, targetKey);
        }
      }
    });

    piano.addEventListener('mouseup', (e) => {
      const targetKey = e.target.closest('.white-key, .black-key');
      if (targetKey) {
        const note = targetKey.dataset.note;
        stopNoteAndCleanup(note);
      }
    });

    // Handle touch events for mobile
    piano.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetKey = targetElement.closest('.white-key, .black-key');
      if (targetKey) {
        const note = targetKey.dataset.note;
        if (!activeNotes.has(note)) {
          playNote(note, targetKey);
        }
      }
    });

    piano.addEventListener('touchend', (e) => {
      e.preventDefault();
      const changedTouch = e.changedTouches[0];
      const targetElement = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
      const targetKey = targetElement.closest('.white-key, .black-key');
      if (targetKey) {
        const note = targetKey.dataset.note;
        stopNoteAndCleanup(note);
      }
    });

    // === Window and Canvas resizing ===
    const resizeCanvas = () => {
      waveformCanvas.width = waveformCanvas.offsetWidth;
      waveformCanvas.height = waveformCanvas.offsetHeight;
      drawWaveform();
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
});
