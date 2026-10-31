// Browser port of audiovis.Spectrogram. tests/test_web_spectrogram.py checks it against NumPy.
"use strict";

const FLOOR_DB = -90;
const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const BINS = FFT_SIZE / 2 + 1;
const FLOOR_AMPLITUDE = 10 ** (FLOOR_DB / 20);
const CURVE_SIZE = 4096;

// The histogram and curve index levels in fine steps from the floor to full scale.
function curveStep(level) {
  return Math.round(Math.min(Math.max((level - FLOOR_DB) / -FLOOR_DB, 0), 1) * (CURVE_SIZE - 1));
}

// Maps levels onto palette indexes, like softmax temperature: sharpness moves the same total
// between an even spread (below 1) and the peaks (above 1). A power curve alone would dim or
// brighten everything, so a gain restores the histogram's mean. Silence is unaffected.
function sharpnessCurve(histogram, sharpness) {
  const shaped = new Float64Array(CURVE_SIZE);
  let target = 0;
  for (let step = 0; step < CURVE_SIZE; step += 1) {
    const position = step / (CURVE_SIZE - 1);
    shaped[step] = position ** sharpness;
    target += histogram[step] * position;
  }
  const total = (gain) => {
    let sum = 0;
    for (let step = 0; step < CURVE_SIZE; step += 1) {
      sum += histogram[step] * Math.min(1, gain * shaped[step]);
    }
    return sum;
  };
  let low = -20;
  let high = 40;
  for (let round = 0; round < 40; round += 1) {
    const middle = (low + high) / 2;
    if (total(2 ** middle) < target) low = middle;
    else high = middle;
  }
  const gain = target > 0 ? 2 ** ((low + high) / 2) : 1;
  return Uint8Array.from(shaped, (value) => Math.round(Math.min(1, gain * value) * 255));
}

// Overlapping Hann-window FFTs, normalized to peak amplitude in dBFS.
class Spectrogram {
  constructor(sampleRate, seconds = 10) {
    this.sampleRate = sampleRate;
    this.seconds = seconds;
    this.columns = Math.max(1, Math.ceil((seconds * sampleRate) / HOP_SIZE));
    this.history = new Float32Array(BINS * this.columns).fill(FLOOR_DB);
    this.total = 0; // Columns analyzed so far; total % columns is the ring's write position.
    this.pending = new Float32Array(FFT_SIZE);
    this.pendingSize = 0;
    this.window = new Float64Array(FFT_SIZE);
    let windowSum = 0;
    for (let n = 0; n < FFT_SIZE; n += 1) {
      this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1));
      windowSum += this.window[n];
    }
    this.scale = 2 / windowSum;
    this.real = new Float64Array(FFT_SIZE);
    this.imaginary = new Float64Array(FFT_SIZE);
    this.cosines = new Float64Array(FFT_SIZE / 2);
    this.sines = new Float64Array(FFT_SIZE / 2);
    for (let k = 0; k < FFT_SIZE / 2; k += 1) {
      this.cosines[k] = Math.cos((2 * Math.PI * k) / FFT_SIZE);
      this.sines[k] = -Math.sin((2 * Math.PI * k) / FFT_SIZE);
    }
    this.reversed = new Uint32Array(FFT_SIZE);
    const bits = Math.log2(FFT_SIZE);
    for (let n = 0; n < FFT_SIZE; n += 1) {
      this.reversed[n] = reverseBits(n, bits);
    }
  }

  get duration() {
    return (this.columns * HOP_SIZE) / this.sampleRate;
  }

  // Returns true when at least one new column was added.
  push(samples) {
    let changed = false;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(FFT_SIZE - this.pendingSize, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + count), this.pendingSize);
      this.pendingSize += count;
      offset += count;
      if (this.pendingSize === FFT_SIZE) {
        this.analyze();
        this.pending.copyWithin(0, HOP_SIZE);
        this.pendingSize -= HOP_SIZE;
        changed = true;
      }
    }
    return changed;
  }

  analyze() {
    const { real, imaginary, reversed } = this;
    for (let n = 0; n < FFT_SIZE; n += 1) {
      real[reversed[n]] = this.pending[n] * this.window[n];
      imaginary[n] = 0;
    }
    this.transform();
    const start = (this.total % this.columns) * BINS;
    for (let bin = 0; bin < BINS; bin += 1) {
      let amplitude = Math.hypot(real[bin], imaginary[bin]) * this.scale;
      // DC and Nyquist have no negative-frequency partner.
      if (bin === 0 || bin === BINS - 1) amplitude *= 0.5;
      this.history[start + bin] = 20 * Math.log10(Math.max(amplitude, FLOOR_AMPLITUDE));
    }
    this.total += 1;
  }

  // In-place radix-2 FFT over bit-reversed input.
  transform() {
    const { real, imaginary, cosines, sines } = this;
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const half = size / 2;
      const step = FFT_SIZE / size;
      for (let start = 0; start < FFT_SIZE; start += size) {
        for (let k = 0; k < half; k += 1) {
          const a = start + k;
          const b = a + half;
          const cosine = cosines[k * step];
          const sine = sines[k * step];
          const oddReal = real[b] * cosine - imaginary[b] * sine;
          const oddImaginary = real[b] * sine + imaginary[b] * cosine;
          real[b] = real[a] - oddReal;
          imaginary[b] = imaginary[a] - oddImaginary;
          real[a] += oddReal;
          imaginary[a] += oddImaginary;
        }
      }
    }
  }

  // The levels of analyzed column `index`, counted from the start of capture.
  column(index) {
    const start = (index % this.columns) * BINS;
    return this.history.subarray(start, start + BINS);
  }

  // A copy with a different history length, keeping the newest columns and unfinished audio.
  resized(seconds) {
    const next = new Spectrogram(this.sampleRate, seconds);
    const count = Math.min(this.total, this.columns, next.columns);
    for (let age = 0; age < count; age += 1) {
      next.history.set(this.column(this.total - count + age), age * BINS);
    }
    next.total = count;
    next.pending.set(this.pending);
    next.pendingSize = this.pendingSize;
    return next;
  }

  // Discard history when capture skips samples; never splice across a gap.
  reset() {
    this.pendingSize = 0;
    this.history.fill(FLOOR_DB);
    this.total = 0;
  }
}

function reverseBits(value, bits) {
  let result = 0;
  for (let bit = 0; bit < bits; bit += 1) {
    result = (result << 1) | ((value >> bit) & 1);
  }
  return result;
}

if (typeof module !== "undefined") {
  module.exports = {
    Spectrogram, curveStep, sharpnessCurve, FLOOR_DB, FFT_SIZE, HOP_SIZE, BINS, CURVE_SIZE,
  };
}
