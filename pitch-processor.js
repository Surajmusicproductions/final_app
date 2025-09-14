/**
 * pitch-processor.js
 * This script runs in a separate, high-priority AudioWorklet thread.
 * Its purpose is to:
 * 1. Receive raw audio data from the microphone.
 * 2. Downsample the audio to the required 16kHz for the CREPE model.
 * 3. Buffer and frame the 16kHz audio into 1024-sample chunks.
 * 4. Post the 1024-sample frames back to the main thread for inference.
 */
class PitchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(2048); // Buffer to hold audio data
        this.bufferPosition = 0; // Current position in the buffer
        this.TARGET_SAMPLE_RATE = 16000; // CREPE model requires 16kHz
        this.FRAME_SIZE = 1024; // CREPE model requires 1024 samples per frame
    }

    /**
     * Called by the browser for each block of audio data.
     * @param {Float32Array[][]} inputs - Array of inputs, each with channels of audio data.
     */
    process(inputs) {
        // We only process the first input, and only its first channel (mono).
        const input = inputs[0];
        const channel = input[0];

        if (!channel) {
            return true;
        }

        // Downsample the incoming audio data.
        // This is a simple linear interpolation resampler.
        const resampled = this.resample(channel, sampleRate, this.TARGET_SAMPLE_RATE);

        // Copy the resampled data into our buffer.
        for (let i = 0; i < resampled.length; i++) {
            this.buffer[this.bufferPosition++] = resampled[i];

            // If the buffer is full, we can't add more data.
            // This is unlikely but a good safeguard.
            if (this.bufferPosition >= this.buffer.length) {
                break;
            }
        }

        // Process frames as long as we have enough data in the buffer.
        while (this.bufferPosition >= this.FRAME_SIZE) {
            // Extract a frame of the required size.
            const frame = this.buffer.slice(0, this.FRAME_SIZE);

            // Post the frame back to the main thread for model inference.
            this.port.postMessage(frame);

            // Shift the buffer to remove the processed frame.
            this.buffer.copyWithin(0, this.FRAME_SIZE);
            this.bufferPosition -= this.FRAME_SIZE;
        }

        // Return true to keep the processor alive.
        return true;
    }

    /**
     * Simple linear interpolation for resampling audio.
     * @param {Float32Array} audioData - The input audio buffer.
     * @param {number} fromRate - The original sample rate.
     * @param {number} toRate - The target sample rate.
     * @returns {Float32Array} The resampled audio data.
     */
    resample(audioData, fromRate, toRate) {
        const ratio = fromRate / toRate;
        const newLength = Math.round(audioData.length / ratio);
        const result = new Float32Array(newLength);

        for (let i = 0; i < newLength; i++) {
            const fromIndex = i * ratio;
            const i0 = Math.floor(fromIndex);
            const i1 = Math.min(i0 + 1, audioData.length - 1);
            const frac = fromIndex - i0;
            result[i] = audioData[i0] + (audioData[i1] - audioData[i0]) * frac;
        }
        return result;
    }
}

// Register the processor to be used in the AudioWorklet.
registerProcessor('pitch-processor', PitchProcessor);
