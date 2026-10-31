"use strict";

const VIRIDIS = [
  "#440154", "#482878", "#3e4989", "#31688e", "#26828e",
  "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725",
];
const PLOT = { left: 62, right: 86, top: 10, bottom: 36, bar: 14 };
const LOOPBACK = /blackhole|soundflower|loopback|monitor of|stereo mix|what u hear|cable output|vb-audio|computer audio/i;
const SHARED_DEVICE_IDS = new Set(["default", "communications"]);
const CAPTURE_RATE = 48000;
const SILENCE_LEVEL = 1e-5;
const SILENCE_SECONDS = 3;

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
  ["source", "seconds", "top", "start", "stop", "plot", "prompt", "prompt-title", "prompt-detail",
    "status", "setup", "setup-os", "setup-browser", "guide"].map((id) => [id, document.getElementById(id)]),
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

function buildPalette() {
  const stops = VIRIDIS.map((hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)));
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

function niceStep(span, count) {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  return steps.find((step) => span / step <= count) ?? steps[steps.length - 1];
}

function formatFrequency(hertz) {
  return hertz >= 1000 ? `${hertz / 1000} kHz` : `${hertz} Hz`;
}

class SpectrogramView {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.palette = buildPalette();
    this.image = document.createElement("canvas");
    this.imageContext = this.image.getContext("2d");
    this.strip = new ImageData(1, BINS);
    this.drawn = 0;
    this.dirty = true;
    this.colorBar = document.createElement("canvas");
    this.colorBar.width = 1;
    this.colorBar.height = 256;
    const bar = this.colorBar.getContext("2d");
    for (let level = 0; level < 256; level += 1) {
      const [red, green, blue] = this.palette.subarray(level * 3, level * 3 + 3);
      bar.fillStyle = `rgb(${red} ${green} ${blue})`;
      bar.fillRect(0, 255 - level, 1, 1);
    }
    new ResizeObserver(() => this.resize()).observe(canvas);
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
    const [red, green, blue] = this.palette.subarray(0, 3);
    this.imageContext.fillStyle = `rgb(${red} ${green} ${blue})`;
    this.imageContext.fillRect(0, 0, model.columns, BINS);
    this.drawn = 0;
    this.dirty = true;
  }

  writeColumn(model, index) {
    const levels = model.column(index);
    const pixels = this.strip.data;
    for (let bin = 0; bin < BINS; bin += 1) {
      const level = Math.round(Math.min(Math.max((levels[bin] - FLOOR_DB) / -FLOOR_DB, 0), 1) * 255);
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
    context.drawImage(this.image, head, sourceY, older, sourceHeight,
      PLOT.left, PLOT.top, older * scale, plotHeight);
    if (head > 0) {
      context.drawImage(this.image, 0, sourceY, head, sourceHeight,
        PLOT.left + older * scale, PLOT.top, head * scale, plotHeight);
    }

    context.font = "12px ui-monospace, SF Mono, Menlo, Consolas, monospace";
    context.fillStyle = "#dce4ef";
    context.strokeStyle = "#94a2b6";
    context.lineWidth = 1;

    context.textAlign = "right";
    context.textBaseline = "middle";
    const frequencyStep = niceStep(top, Math.max(2, Math.floor(plotHeight / 46)));
    for (let frequency = 0; frequency <= top; frequency += frequencyStep) {
      const y = PLOT.top + plotHeight * (1 - frequency / top);
      this.tick(PLOT.left - 5, y, PLOT.left, y);
      context.fillText(formatFrequency(frequency), PLOT.left - 8, y);
    }

    context.textAlign = "center";
    context.textBaseline = "top";
    const seconds = model.duration;
    const timeStep = niceStep(seconds, Math.max(2, Math.floor(plotWidth / 70)));
    for (let age = 0; age <= seconds; age += timeStep) {
      const x = PLOT.left + plotWidth * (1 - age / seconds);
      const y = PLOT.top + plotHeight;
      this.tick(x, y, x, y + 5);
      context.fillText(age === 0 ? "now" : `−${age} s`, x, y + 8);
    }

    const barX = width - PLOT.right + 12;
    context.imageSmoothingEnabled = true;
    context.drawImage(this.colorBar, barX, PLOT.top, PLOT.bar, plotHeight);
    context.textAlign = "left";
    context.textBaseline = "middle";
    for (let level = 0; level >= FLOOR_DB; level -= 30) {
      const y = PLOT.top + plotHeight * (level / FLOOR_DB);
      this.tick(barX + PLOT.bar, y, barX + PLOT.bar + 4, y);
      context.fillText(level === 0 ? "0 dBFS" : `−${-level}`, barX + PLOT.bar + 7, y);
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
const view = new SpectrogramView(elements.plot);
view.clear(model);

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
    setStatus("Audio gap detected · history restarted");
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
elements.seconds.addEventListener("change", () => {
  model = new Spectrogram(capture?.context ? capture.sampleRate : model.sampleRate, Number(elements.seconds.value));
  expectedFrame = null;
  view.clear(model);
});
elements.top.addEventListener("change", () => { view.dirty = true; });
elements["setup-os"].addEventListener("change", renderGuide);
elements["setup-browser"].addEventListener("change", renderGuide);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

elements["setup-os"].value = platform.os;
elements["setup-browser"].value = platform.browser;
elements["prompt-detail"].textContent = canShareAudio
  ? "Your browser will ask what to share."
  : "See the setup steps below for computer audio.";
rebuildSources();
renderGuide();
refreshDevices();
frame();
