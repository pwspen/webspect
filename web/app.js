"use strict";

// Each map runs from silence to full scale. The first color is also the page background.
const COLORMAPS = {
  Magma: ["#000004", "#180f3e", "#451077", "#721f81", "#9e2f7f", "#cd4071", "#f1605d", "#fd9668", "#feca8d", "#fcfdbf"],
  Inferno: ["#000004", "#1b0c42", "#4b0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9a06", "#f7d03c", "#fcffa4"],
  Viridis: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
  Plasma: ["#0d0887", "#47039f", "#7301a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fa9e3b", "#fdc926", "#f0f921"],
  Cividis: ["#00204d", "#00336f", "#39486b", "#575c6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#ffea46"],
  Turbo: ["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c8ef34", "#faba39", "#f66b19", "#cb2a04", "#7a0403"],
  Grayscale: ["#000000", "#ffffff"],
  Paper: ["#ffffff", "#000000"],
};
const DEFAULT_COLORMAP = "Magma";
const COLORMAP_KEY = "audiovis.colormap";
const GAMMA_KEY = "audiovis.gamma";
const RAMP_STOPS = 17;
const SECONDS_KEY = "audiovis.seconds";
const TOP_KEY = "audiovis.top";
const PLOT = { left: 58, right: 0, top: 8, bottom: 24 };
const MIN_LABEL_GAP = 38;
const LOOPBACK = /blackhole|soundflower|loopback|monitor of|stereo mix|what u hear|cable output|vb-audio|computer audio/i;
const SHARED_DEVICE_IDS = new Set(["default", "communications"]);
const CAPTURE_RATE = 48000;
const SILENCE_LEVEL = 1e-5;
const SILENCE_SECONDS = 3;
const GAP_NOTICE_MS = 5000;

// Mixes to mono and batches render quanta. The frame counter exposes gaps in capture.
const TAP_WORKLET = `
class BlockTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(${HOP_SIZE});
    this.filled = 0;
    this.blockFrame = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    const length = channels.length ? channels[0].length : 128;
    for (let n = 0; n < length; n += 1) {
      if (this.filled === 0) this.blockFrame = currentFrame + n;
      let sum = 0;
      for (const channel of channels) sum += channel[n];
      this.block[this.filled] = channels.length ? sum / channels.length : 0;
      this.filled += 1;
      if (this.filled === this.block.length) {
        this.port.postMessage({ frame: this.blockFrame, samples: this.block }, [this.block.buffer]);
        this.block = new Float32Array(${HOP_SIZE});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("block-tap", BlockTap);
`;

const elements = Object.fromEntries(
  ["source", "seconds", "seconds-value", "top", "top-value", "colormap", "gamma", "gamma-value", "start", "stop", "plot", "prompt", "prompt-title",
    "prompt-detail", "status", "ramp", "setup", "setup-os", "setup-browser", "guide"]
    .map((id) => [id, document.getElementById(id)]),
);

// Shown to the user as-is, with the setup guide brought into view.
class SetupNeeded extends Error {}

function detectPlatform() {
  const agent = navigator.userAgent;
  const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const mobile = /Android|iPhone|iPad|iPod/.test(agent) || touchMac;
  const os = mobile ? "mobile" : /Mac/.test(agent) ? "mac" : /Win/.test(agent) ? "windows" : "linux";
  let browser = "chromium";
  if (/Firefox\//.test(agent)) browser = "firefox";
  else if (/Safari\//.test(agent) && !/Chrome\/|Chromium\/|Edg\//.test(agent)) browser = "safari";
  return { os, browser };
}

const platform = detectPlatform();
const canShareAudio = platform.browser === "chromium" && platform.os !== "mobile"
  && Boolean(navigator.mediaDevices?.getDisplayMedia);

// Audio capture

function microphoneConstraints(deviceId) {
  // Voice processing would reshape the spectrum being measured.
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

function stopStream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

async function openDevice(deviceId, name) {
  const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
  return { stream, name: name ?? (stream.getAudioTracks()[0].label || "Microphone") };
}

async function openShare() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include",
  });
  if (stream.getAudioTracks().length === 0) {
    stopStream(stream);
    throw new SetupNeeded("No audio was shared. Start again and turn on the audio switch in the share picker.");
  }
  return { stream, name: "Computer audio" };
}

// Browsers hide device names until a microphone is allowed, so a loopback device can only be
// recognized after the first grant. A stream the user pointed at it in the prompt is kept.
async function openLoopback() {
  const known = inputDevices.find((device) => LOOPBACK.test(device.label));
  if (known) return openDevice(known.deviceId, known.label);
  const opened = await openDevice();
  await refreshDevices();
  const loopback = inputDevices.find((device) => LOOPBACK.test(device.label));
  if (LOOPBACK.test(opened.stream.getAudioTracks()[0].label)) return opened;
  stopStream(opened.stream);
  return loopback ? openDevice(loopback.deviceId, loopback.label) : null;
}

async function openComputerAudio() {
  // Chrome on Linux shares tab audio only, so a loopback device is the better capture there.
  if ((!canShareAudio || platform.os === "linux") && hasMicrophoneApi()) {
    const opened = await openLoopback();
    if (opened) return opened;
  }
  if (canShareAudio) return openShare();
  throw new SetupNeeded("This browser needs a loopback device to hear computer audio. Follow the setup steps below.");
}

function hasMicrophoneApi() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

class AudioCapture {
  constructor(source, onBlock, onEnded) {
    this.source = source;
    this.onBlock = onBlock;
    this.onEnded = onEnded;
    this.context = null;
    this.stream = null;
    this.oscillators = [];
    this.closed = false;
    this.name = source.name;
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  async start() {
    // Safari only lets a context run if it is created during the click. A fixed rate keeps
    // the display at full range when Bluetooth headphones drop to 16 kHz for a call.
    this.context = new AudioContext({ sampleRate: CAPTURE_RATE });
    this.context.resume();
    let nodes;
    if (this.source.kind === "test") {
      nodes = this.testSignal();
    } else {
      const opened = this.source.kind === "system"
        ? await openComputerAudio()
        : await openDevice(this.source.deviceId, this.source.deviceId ? this.source.name : undefined);
      this.stream = opened.stream;
      this.name = opened.name;
      if (this.closed) return;
      this.stream.getAudioTracks()[0].addEventListener("ended", () => this.onEnded());
      nodes = this.streamSource();
    }
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    if (this.closed) return;
    const tap = new AudioWorkletNode(this.context, "block-tap", { numberOfOutputs: 1 });
    tap.port.onmessage = (event) => this.onBlock(event.data);
    // A muted path to the output keeps the graph running without feeding audio back.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    nodes.connect(tap).connect(mute).connect(this.context.destination);
    await this.context.resume();
  }

  streamSource() {
    try {
      return this.context.createMediaStreamSource(this.stream);
    } catch {
      // Some browsers refuse a stream at another rate, so fall back to the system's.
      this.context.close();
      this.context = new AudioContext();
      return this.context.createMediaStreamSource(this.stream);
    }
  }

  // A falling sweep over a pulsing drone, for checking the display without any permissions.
  testSignal() {
    const context = this.context;
    const output = context.createGain();
    output.gain.value = 0.25;
    const drone = context.createOscillator();
    drone.type = "sawtooth";
    drone.frequency.value = 110;
    const pulse = context.createGain();
    pulse.gain.value = 0.5;
    const pulseRate = context.createOscillator();
    pulseRate.frequency.value = 0.5;
    const pulseDepth = context.createGain();
    pulseDepth.gain.value = 0.5;
    pulseRate.connect(pulseDepth).connect(pulse.gain);
    drone.connect(pulse).connect(output);
    const sweep = context.createOscillator();
    sweep.frequency.value = 6000;
    const sweepRate = context.createOscillator();
    sweepRate.frequency.value = 0.2;
    const sweepDepth = context.createGain();
    sweepDepth.gain.value = 5000;
    sweepRate.connect(sweepDepth).connect(sweep.frequency);
    sweep.connect(output);
    this.oscillators = [drone, pulseRate, sweep, sweepRate];
    this.oscillators.forEach((oscillator) => oscillator.start());
    return output;
  }

  close() {
    this.closed = true;
    this.oscillators.forEach((oscillator) => oscillator.stop());
    if (this.stream) stopStream(this.stream);
    if (this.context && this.context.state !== "closed") this.context.close();
  }
}

// Drawing

function parseColor(hex) {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

function cssColor([red, green, blue]) {
  return `rgb(${Math.round(red)} ${Math.round(green)} ${Math.round(blue)})`;
}

function mixColors(from, to, amount) {
  return from.map((channel, index) => channel + (to[index] - channel) * amount);
}

function luminance(color) {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

function strongest(background, candidates) {
  return candidates.reduce((best, color) => (contrast(background, color) > contrast(background, best) ? color : best));
}

function buildPalette(colors) {
  const stops = colors.map(parseColor);
  const palette = new Uint8ClampedArray(256 * 3);
  for (let level = 0; level < 256; level += 1) {
    const position = (level / 255) * (stops.length - 1);
    const lower = Math.min(Math.floor(position), stops.length - 2);
    const blend = position - lower;
    for (let channel = 0; channel < 3; channel += 1) {
      palette[level * 3 + channel] = stops[lower][channel] * (1 - blend) + stops[lower + 1][channel] * blend;
    }
  }
  return palette;
}

function formatFrequency(hertz) {
  if (hertz === 0) return "0 Hz";
  return hertz >= 1000 ? `${Number((hertz / 1000).toFixed(2))} kHz` : `${hertz} Hz`;
}

class SpectrogramView {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.palette = null;
    this.curve = gammaCurve(1);
    this.ink = "#ffffff";
    this.image = document.createElement("canvas");
    this.imageContext = this.image.getContext("2d");
    this.strip = new ImageData(1, BINS);
    this.drawn = 0;
    this.dirty = true;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setColors(palette, ink) {
    this.palette = palette;
    this.ink = ink;
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * ratio);
    this.canvas.height = Math.round(this.canvas.clientHeight * ratio);
    this.dirty = true;
  }

  clear(model) {
    this.image.width = model.columns;
    this.image.height = BINS;
    this.imageContext.fillStyle = cssColor(this.palette.subarray(0, 3));
    this.imageContext.fillRect(0, 0, model.columns, BINS);
    this.drawn = 0;
    this.dirty = true;
  }

  writeColumn(model, index) {
    const levels = model.column(index);
    const pixels = this.strip.data;
    for (let bin = 0; bin < BINS; bin += 1) {
      const position = Math.min(Math.max((levels[bin] - FLOOR_DB) / -FLOOR_DB, 0), 1);
      const level = this.curve[Math.round(position * (CURVE_SIZE - 1))];
      const offset = (BINS - 1 - bin) * 4;
      pixels[offset] = this.palette[level * 3];
      pixels[offset + 1] = this.palette[level * 3 + 1];
      pixels[offset + 2] = this.palette[level * 3 + 2];
      pixels[offset + 3] = 255;
    }
    this.imageContext.putImageData(this.strip, index % model.columns, 0);
  }

  render(model, topFrequency) {
    if (model.total < this.drawn) this.clear(model);
    if (model.total === this.drawn && !this.dirty) return;
    for (let index = Math.max(this.drawn, model.total - model.columns); index < model.total; index += 1) {
      this.writeColumn(model, index);
    }
    this.drawn = model.total;
    this.dirty = false;

    const ratio = this.canvas.width / this.canvas.clientWidth || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const plotWidth = width - PLOT.left - PLOT.right;
    const plotHeight = height - PLOT.top - PLOT.bottom;
    const context = this.context;
    const nyquist = model.sampleRate / 2;
    const top = Math.min(topFrequency, nyquist);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    // The history is a ring: the oldest column sits just right of the write position.
    const head = model.total % model.columns;
    const binWidth = model.sampleRate / FFT_SIZE;
    const sourceHeight = top / binWidth;
    const sourceY = BINS - 0.5 - sourceHeight;
    const scale = plotWidth / model.columns;
    const older = model.columns - head;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(this.image, head, sourceY, older, sourceHeight,
      PLOT.left, PLOT.top, older * scale, plotHeight);
    if (head > 0) {
      context.drawImage(this.image, 0, sourceY, head, sourceHeight,
        PLOT.left + older * scale, PLOT.top, head * scale, plotHeight);
    }

    context.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    context.fillStyle = this.ink;
    context.strokeStyle = this.ink;
    context.lineWidth = 1;

    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const frequency of [top, top / 2, 0]) {
      const y = PLOT.top + plotHeight * (1 - frequency / top);
      this.tick(PLOT.left - 5, y, PLOT.left, y);
      context.fillText(formatFrequency(frequency), PLOT.left - 8, y);
    }

    context.textBaseline = "top";
    const baseline = PLOT.top + plotHeight;
    const seconds = model.seconds;
    const zeroX = width - 1;
    for (const age of new Set([seconds, seconds / 2, 1, 0])) {
      const x = Math.min(PLOT.left + plotWidth * (1 - age / model.duration), zeroX);
      this.tick(x, baseline, x, baseline + 5);
      // On a long history the 1 s tick lands too close to 0 s for two labels to fit.
      if (age !== 0 && zeroX - x < MIN_LABEL_GAP) continue;
      context.textAlign = age === 0 ? "right" : "center";
      const labelX = age === 0 ? x - 4 : x;
      context.fillText(age === 0 ? "0 s" : `−${Number(age.toFixed(1))} s`, labelX, baseline + 8);
    }
  }

  tick(x1, y1, x2, y2) {
    this.context.beginPath();
    this.context.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    this.context.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    this.context.stroke();
  }
}

// App state

let inputDevices = [];
let capture = null;
let model = new Spectrogram(48000, Number(elements.seconds.value));
let expectedFrame = null;
let generation = 0;
let silentSamples = 0;
let showingSilence = false;
let liveMessage = "";
let statusTimer = 0;
const view = new SpectrogramView(elements.plot);

// Silence and the page share one color, so the plot has no visible edge.
function applyColormap(name) {
  const colors = COLORMAPS[name];
  const palette = buildPalette(colors);
  const background = Array.from(palette.subarray(0, 3));
  const dark = luminance(background) < 0.4;
  const foreground = dark ? [244, 246, 250] : [18, 18, 22];
  const levels = Array.from({ length: 256 }, (_, level) => Array.from(palette.subarray(level * 3, level * 3 + 3)));
  const accent = strongest(background, levels);
  const tokens = {
    "--bg": background,
    "--fg": foreground,
    "--muted": mixColors(background, foreground, 0.72),
    "--panel": mixColors(background, foreground, 0.1),
    "--line": mixColors(background, foreground, 0.24),
    "--accent": accent,
    "--accent-ink": strongest(accent, [[0, 0, 0], [255, 255, 255]]),
    "--bad": strongest(background, [[255, 180, 166], [160, 30, 20]]),
  };
  const root = document.documentElement;
  for (const [token, color] of Object.entries(tokens)) {
    root.style.setProperty(token, cssColor(color));
  }
  root.style.colorScheme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = cssColor(background);
  view.setColors(palette, cssColor(tokens["--muted"]));
  renderRamp();
  view.clear(model);
}

// The slider is logarithmic: gamma is 2 to its value, so 0.5 and 2 sit evenly around 1.
function applyGamma() {
  const gamma = 2 ** Number(elements.gamma.value);
  view.curve = gammaCurve(gamma);
  elements["gamma-value"].textContent = gamma.toFixed(2);
  renderRamp();
  view.clear(model);
}

// The legend shows the same mapping as the plot, from -90 to 0 dBFS.
function renderRamp() {
  const stops = Array.from({ length: RAMP_STOPS }, (_, stop) => {
    const level = view.curve[Math.round((stop / (RAMP_STOPS - 1)) * (CURVE_SIZE - 1))];
    return cssColor(view.palette.subarray(level * 3, level * 3 + 3));
  });
  document.documentElement.style.setProperty("--ramp", `linear-gradient(to right, ${stops.join(", ")})`);
}

function showRanges() {
  elements["seconds-value"].textContent = `${elements.seconds.value} s`;
  elements["top-value"].textContent = formatFrequency(Number(elements.top.value));
}

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice just won't survive a reload.
  }
}

function setStatus(message, state = "idle") {
  elements.status.textContent = message;
  elements.status.dataset.state = state;
}

function setRunning(running) {
  elements.stop.disabled = !running;
  elements.start.textContent = running || elements.start.textContent !== "Start" ? "Reconnect" : "Start";
  if (running) elements.prompt.hidden = true;
}

function selectedSource() {
  const option = elements.source.selectedOptions[0];
  const value = elements.source.value;
  if (value === "system" || value === "test") return { kind: value, name: option.textContent };
  if (value === "mic") return { kind: "device", deviceId: null, name: option.textContent };
  return { kind: "device", deviceId: value.slice("device:".length), name: option.textContent };
}

function rebuildSources() {
  const selected = elements.source.value;
  const options = [
    ["system", "Computer audio"],
    ["mic", "Default microphone"],
    ...inputDevices.map((device) => [`device:${device.deviceId}`, device.label]),
    ["test", "Test signal"],
  ];
  elements.source.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  elements.source.value = options.some(([value]) => value === selected) ? selected : "system";
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Names stay blank until the browser has been allowed to use a microphone.
  inputDevices = devices.filter((device) => device.kind === "audioinput" && device.label
    && !SHARED_DEVICE_IDS.has(device.deviceId));
  rebuildSources();
}

function onBlock({ frame, samples }) {
  if (expectedFrame !== null && frame !== expectedFrame) {
    model.reset();
    // The audio clock often jumps once as a context starts, which is not worth a notice.
    if (frame >= model.sampleRate) {
      setStatus("Audio gap detected · history restarted");
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        if (capture && !showingSilence) setStatus(liveMessage, "live");
      }, GAP_NOTICE_MS);
    }
  }
  expectedFrame = frame + samples.length;
  model.push(samples);
  trackSilence(samples);
}

// A loopback device with nothing routed to it stays open and delivers zeros, with no error.
function trackSilence(samples) {
  const silent = samples.every((sample) => Math.abs(sample) < SILENCE_LEVEL);
  silentSamples = silent ? silentSamples + samples.length : 0;
  const quiet = silentSamples >= SILENCE_SECONDS * model.sampleRate;
  if (quiet === showingSilence) return;
  showingSilence = quiet;
  if (quiet) {
    const hint = /blackhole/i.test(capture.name)
      ? "Play something, and set System Settings › Sound › Output to your Multi-Output Device."
      : "Play something, and check that the source isn't muted.";
    setStatus(`${capture.name} is connected, but no sound is reaching it. ${hint}`, "error");
  } else {
    setStatus(liveMessage, "live");
  }
}

function stopCapture(message = "Stopped") {
  generation += 1;
  clearTimeout(statusTimer);
  if (capture) capture.close();
  capture = null;
  setRunning(false);
  setStatus(message);
}

function explain(error, source) {
  if (error instanceof SetupNeeded) return error.message;
  const system = source.kind === "system";
  if (error.name === "NotAllowedError") {
    return system
      ? "Sharing was cancelled or blocked. Start again, or follow the setup steps below."
      : "Microphone access was blocked. Allow it in the address bar and your system's privacy settings, then Reconnect.";
  }
  if (error.name === "NotFoundError") return "No input device was found. Connect one, then Reconnect.";
  if (error.name === "OverconstrainedError") return "That device is no longer available. Choose another source.";
  if (error.name === "NotReadableError") return "Another app or the system is holding that device. Close it, then Reconnect.";
  return error.message || "Capture failed. Reconnect to try again.";
}

async function startCapture() {
  generation += 1;
  clearTimeout(statusTimer);
  const current = generation;
  if (capture) capture.close();
  const source = selectedSource();
  if (source.kind !== "test" && !window.isSecureContext) {
    capture = null;
    setRunning(false);
    setStatus("Browsers only allow audio capture over https or on localhost. Reopen this page from one of those.", "error");
    return;
  }
  const next = new AudioCapture(source, (block) => {
    if (capture === next) onBlock(block);
  }, () => {
    if (capture === next) stopCapture("Stopped: the source ended · select a source or Reconnect");
  });
  capture = next;
  setRunning(false);
  setStatus(`Connecting: ${source.name}`);
  try {
    await next.start();
  } catch (error) {
    next.close();
    if (current !== generation) return;
    capture = null;
    setStatus(`Stopped: ${explain(error, source)}`, "error");
    if (error instanceof SetupNeeded || source.kind === "system") {
      elements.setup.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  if (current !== generation) {
    next.close();
    return;
  }
  model = new Spectrogram(next.sampleRate, Number(elements.seconds.value));
  expectedFrame = null;
  view.clear(model);
  elements.top.max = next.sampleRate / 2;
  showRanges();
  silentSamples = 0;
  showingSilence = false;
  setRunning(true);
  liveMessage = `Listening: ${next.name} · ${next.sampleRate / 1000} kHz · audio is not saved`;
  setStatus(liveMessage, "live");
  refreshDevices();
}

function frame() {
  view.render(model, Number(elements.top.value));
  requestAnimationFrame(frame);
}

// Setup guide. Steps are [text, command] pairs, and links are [label, url] pairs.

const AFTER_LOOPBACK = "Reload this page, choose Computer audio and press Start. When the browser asks for a microphone, pick that device.";

const BLACKHOLE = {
  verdict: "Install BlackHole once. It is a free driver that makes computer audio available as a microphone.",
  links: [
    ["Download BlackHole", "https://existential.audio/blackhole/"],
    ["Source on GitHub", "https://github.com/ExistentialAudio/BlackHole"],
  ],
  steps: [
    ["Install BlackHole 2ch with the download above, or with Homebrew:", "brew install blackhole-2ch"],
    ["Open Audio MIDI Setup from Applications › Utilities. If BlackHole 2ch is missing from the list, restart your Mac."],
    ["Press + at the bottom left and choose Create Multi-Output Device."],
    ["Tick your speakers or headphones, then tick BlackHole 2ch. Keep your speakers or headphones at the top of the list, so they act as the clock, and turn on Drift Correction for BlackHole."],
    ["In System Settings › Sound › Output, choose Multi-Output Device. This step is required: BlackHole stays silent until audio is sent to it. You will keep hearing audio, and BlackHole gets a copy."],
    ["In System Settings › Privacy & Security › Microphone, allow this browser."],
    [AFTER_LOOPBACK.replace("that device", "BlackHole 2ch")],
  ],
  note: "macOS volume keys don't work on a Multi-Output Device. Set the volume in Spotify, or switch Output back to your speakers when you're done. With Bluetooth headphones, never pick their microphone in the browser prompt: that drops them to call quality. Connecting Bluetooth headphones can also reset Output, so check it if the plot goes blank.",
};

const LINUX_LOOPBACK = (firstStep) => ({
  verdict: "No download needed. PulseAudio and PipeWire can present your speakers' output as a microphone.",
  steps: [
    ...firstStep,
    ["Create a named loopback source. It lasts until you log out or restart audio:",
      'pactl load-module module-remap-source master="$(pactl get-default-sink).monitor" source_name=audiovis_loopback source_properties=device.description=Computer-audio'],
    [AFTER_LOOPBACK.replace("that device", "Computer-audio")],
  ],
  note: "If the device isn't offered, open pavucontrol while capture runs, go to the Recording tab and set this browser's stream to Monitor of your output. To remove the source, run pactl unload-module module-remap-source.",
});

const WINDOWS_LOOPBACK = {
  verdict: "Use Stereo Mix if your sound card has it, or install the free VB-CABLE driver.",
  links: [["Download VB-CABLE", "https://vb-audio.com/Cable/"]],
  steps: [
    ["Open Sound settings › More sound settings › Recording. Right-click the list and turn on Show Disabled Devices."],
    ["If Stereo Mix appears, right-click it and choose Enable, then skip to the last step."],
    ["Otherwise install VB-CABLE and restart. Set CABLE Input as your Windows output device."],
    ["To keep hearing audio, open CABLE Output's Properties in the Recording tab, go to Listen, tick Listen to this device and pick your speakers."],
    [AFTER_LOOPBACK.replace("that device", "Stereo Mix or CABLE Output")],
  ],
};

function guideFor(os, browser) {
  if (os === "mobile") {
    return {
      verdict: "Phones and tablets don't let web pages hear other apps.",
      steps: [["Choose Default microphone and press Start."], ["Play your music out loud near the phone."]],
      note: "Expect a room recording, with the speaker and microphone shaping the sound. For a clean signal, run the page on a computer.",
    };
  }
  if (browser === "chromium" && os === "mac") {
    return {
      verdict: "Chrome 141 or newer on macOS 14.2 or newer needs no install.",
      steps: [
        ["Choose Computer audio and press Start."],
        ["In the share picker, open the Entire Screen tab, select your screen and turn on Also share system audio."],
        ["If macOS blocks it, allow this browser in System Settings › Privacy & Security › Screen & System Audio Recording, then restart the browser."],
      ],
      note: "The picker appears on every Start. If the audio switch is missing, update the browser or share a Chrome Tab, which only captures that tab. BlackHole also works here: use the Firefox setup, then select BlackHole 2ch as the Audio source.",
    };
  }
  if (browser === "chromium" && os === "windows") {
    return {
      verdict: "Chrome and Edge need no install on Windows.",
      steps: [
        ["Choose Computer audio and press Start."],
        ["In the share picker, open the Entire Screen tab, select your screen and turn on Also share system audio."],
      ],
      note: "The picker appears on every Start.",
    };
  }
  if (os === "mac") return BLACKHOLE;
  if (os === "windows") return WINDOWS_LOOPBACK;
  if (browser === "firefox") {
    return LINUX_LOOPBACK([
      ["Choose Computer audio and press Start. If the microphone prompt lists Monitor of your output, pick it and you're done."],
    ]);
  }
  return {
    ...LINUX_LOOPBACK([]),
    note: `Without this, Chrome and Edge can only share a single tab's audio on Linux. ${LINUX_LOOPBACK([]).note}`,
  };
}

function renderGuide() {
  const os = elements["setup-os"].value;
  const safari = elements["setup-browser"].querySelector('[value="safari"]');
  safari.disabled = os !== "mac";
  if (safari.disabled && elements["setup-browser"].value === "safari") {
    elements["setup-browser"].value = "chromium";
  }
  elements["setup-browser"].disabled = os === "mobile";
  const guide = guideFor(os, elements["setup-browser"].value);
  const nodes = [];

  const verdict = document.createElement("p");
  verdict.className = "verdict";
  verdict.textContent = guide.verdict;
  nodes.push(verdict);

  if (guide.links) {
    const links = document.createElement("div");
    links.className = "downloads";
    for (const [label, url] of guide.links) {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = label;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    nodes.push(links);
  }

  const steps = document.createElement("ol");
  for (const [text, command] of guide.steps) {
    const step = document.createElement("li");
    step.textContent = text;
    if (command) step.append(commandLine(command));
    steps.append(step);
  }
  nodes.push(steps);

  if (guide.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = guide.note;
    nodes.push(note);
  }
  elements.guide.replaceChildren(...nodes);
}

function commandLine(command) {
  const line = document.createElement("div");
  line.className = "command";
  const code = document.createElement("code");
  code.textContent = command;
  code.tabIndex = 0;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = "Copied";
    } catch {
      getSelection().selectAllChildren(code);
      copy.textContent = "Press copy";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1500);
  });
  line.append(code, copy);
  return line;
}

// Wiring

elements.start.addEventListener("click", startCapture);
elements.stop.addEventListener("click", () => stopCapture());
elements.source.addEventListener("change", () => {
  if (capture) startCapture();
});
elements.seconds.addEventListener("input", () => {
  model = model.resized(Number(elements.seconds.value));
  view.clear(model);
  showRanges();
  saveSetting(SECONDS_KEY, elements.seconds.value);
});
elements.top.addEventListener("input", () => {
  view.dirty = true;
  showRanges();
  saveSetting(TOP_KEY, elements.top.value);
});
elements.colormap.addEventListener("change", () => {
  applyColormap(elements.colormap.value);
  saveSetting(COLORMAP_KEY, elements.colormap.value);
});
elements.gamma.addEventListener("input", () => {
  applyGamma();
  saveSetting(GAMMA_KEY, elements.gamma.value);
});
elements.gamma.addEventListener("dblclick", () => {
  elements.gamma.value = 0;
  applyGamma();
  saveSetting(GAMMA_KEY, elements.gamma.value);
});
elements["setup-os"].addEventListener("change", renderGuide);
elements["setup-browser"].addEventListener("change", renderGuide);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

elements.colormap.replaceChildren(...Object.keys(COLORMAPS).map((name) => new Option(name, name)));
elements.seconds.value = readSetting(SECONDS_KEY) ?? elements.seconds.value;
elements.top.value = readSetting(TOP_KEY) ?? elements.top.value;
model = model.resized(Number(elements.seconds.value));
showRanges();
const savedColormap = readSetting(COLORMAP_KEY);
elements.colormap.value = Object.hasOwn(COLORMAPS, savedColormap) ? savedColormap : DEFAULT_COLORMAP;
applyColormap(elements.colormap.value);
elements.gamma.value = readSetting(GAMMA_KEY) ?? 0;
applyGamma();
elements["setup-os"].value = platform.os;
elements["setup-browser"].value = platform.browser;
elements["prompt-detail"].textContent = canShareAudio
  ? "Your browser will ask what to share."
  : "See the setup steps below for computer audio.";
rebuildSources();
renderGuide();
refreshDevices();
frame();
