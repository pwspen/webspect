"""Live, scrolling audio spectrogram. Run with `uv run audiovis`."""

from __future__ import annotations

import argparse
import math
import sys
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from threading import Thread
from typing import Protocol, cast

import numpy as np
import pyqtgraph as pg
import sounddevice as sd
from numpy.typing import NDArray
from PySide6 import QtCore, QtGui, QtWidgets

Samples = NDArray[np.float32]
FLOOR_DB = -90.0
FFT_SIZE = 2048
HOP_SIZE = 512


@dataclass
class Spectrogram:
    """Overlapping Hann-window FFTs, normalized to peak amplitude in dBFS."""

    sample_rate: float
    seconds: float = 10.0
    history: Samples = field(init=False)
    pending: Samples = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    window: Samples = field(default_factory=lambda: np.hanning(FFT_SIZE).astype(np.float32))

    def __post_init__(self) -> None:
        columns = max(1, math.ceil(self.seconds * self.sample_rate / HOP_SIZE))
        self.history = np.full((FFT_SIZE // 2 + 1, columns), FLOOR_DB, dtype=np.float32)

    @property
    def duration(self) -> float:
        return float(self.history.shape[1] * HOP_SIZE / self.sample_rate)

    def push(self, samples: Samples) -> bool:
        self.pending = np.concatenate((self.pending, samples))
        columns: list[Samples] = []
        while self.pending.size >= FFT_SIZE:
            spectrum = np.abs(np.fft.rfft(self.pending[:FFT_SIZE] * self.window))
            spectrum *= 2.0 / self.window.sum()
            spectrum[[0, -1]] *= 0.5  # DC and Nyquist have no negative-frequency partner.
            levels = 20.0 * np.log10(np.maximum(spectrum, 10.0 ** (FLOOR_DB / 20.0)))
            columns.append(levels.astype(np.float32))
            self.pending = self.pending[HOP_SIZE:]
        if not columns:
            return False
        count = min(len(columns), self.history.shape[1])
        self.history[:, :-count] = self.history[:, count:]
        self.history[:, -count:] = np.stack(columns[-count:], axis=1)
        return True

    def reset(self) -> None:
        """Discard history when capture skips samples; never splice across a gap."""
        self.pending = np.empty(0, dtype=np.float32)
        self.history.fill(FLOOR_DB)


class Microphone:
    """Keep the audio callback short; perform analysis on the GUI thread."""

    def __init__(self) -> None:
        self.blocks: deque[tuple[int, Samples, bool]] = deque(maxlen=64)
        self.sequence = 0

    def callback(self, data: Samples, frames: int, time: object, status: sd.CallbackFlags) -> None:
        self.blocks.append((self.sequence, data[:, 0].copy(), bool(status)))
        self.sequence += 1


@dataclass(frozen=True)
class AudioSource:
    name: str
    device: int | None  # None selects native computer-audio capture.
    sample_rate: float


def input_sources() -> list[AudioSource]:
    sources = [AudioSource("Computer audio", None, 48000)]
    sources.extend(
        AudioSource(str(info["name"]), index, float(info["default_samplerate"]))
        for index, info in enumerate(sd.query_devices())
        if info["max_input_channels"] > 0
    )
    return sources


class InputStream(Protocol):
    def start(self) -> None: ...
    def close(self) -> None: ...
    @property
    def active(self) -> bool: ...


class SystemRecorder(Protocol):
    def start_recording(self) -> None: ...
    def stop_recording(self) -> str | None: ...
    def stream(self, timeout: float = 0.1) -> Iterator[Samples]: ...


class AudioCapture:
    """Own one capture source, with a fresh queue for every source change."""

    def __init__(self, source: AudioSource) -> None:
        self.source = source
        self.audio = Microphone()
        self.input: InputStream | None = None
        self.recorder: SystemRecorder | None = None
        self.worker: Thread | None = None
        self.error: str | None = None

    def start(self) -> None:
        if self.source.device is not None:
            self.input = sd.InputStream(
                device=self.source.device,
                samplerate=self.source.sample_rate,
                channels=1,
                dtype="float32",
                blocksize=HOP_SIZE,
                callback=self.audio.callback,
            )
            self.input.start()
            return
        if sys.platform not in {"darwin", "win32"}:
            raise RuntimeError(
                "Select a loopback/monitor input device for computer audio on Linux."
            )
        from pysysaudio import SystemAudioRecorder

        self.recorder = SystemAudioRecorder(
            sample_rate=int(self.source.sample_rate), channels=1, format="numpy", dtype="float32"
        )
        self.recorder.start_recording()
        self.worker = Thread(target=self.read_system_audio, name="computer-audio", daemon=True)
        self.worker.start()

    def read_system_audio(self) -> None:
        assert self.recorder is not None
        try:
            for chunk in self.recorder.stream():
                samples = np.asarray(chunk, dtype=np.float32).reshape(-1)
                self.audio.blocks.append((self.audio.sequence, samples.copy(), False))
                self.audio.sequence += 1
        except Exception as error:
            self.error = str(error)

    def close(self) -> None:
        if self.input is not None:
            self.input.close()
            self.input = None
        if self.recorder is not None:
            # start_recording can fail before a native stream exists.
            try:
                self.recorder.stop_recording()
            except RuntimeError:
                pass
            if self.worker is not None:
                self.worker.join(timeout=1)
            self.recorder = None


class SpectrogramWindow(QtWidgets.QMainWindow):
    def __init__(
        self,
        microphone: Microphone,
        model: Spectrogram,
        max_frequency: float,
        sources: list[AudioSource] | None = None,
    ) -> None:
        super().__init__()
        self.microphone = microphone
        self.model = model
        self.expected_sequence = 0
        self.max_frequency = max_frequency
        self.capture: AudioCapture | None = None
        self.sources = sources or []
        self.setWindowTitle("Audiovis · Audio spectrogram")
        self.resize(1100, 650)

        canvas = pg.GraphicsLayoutWidget()
        container = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(container)
        controls = QtWidgets.QHBoxLayout()
        controls.addWidget(QtWidgets.QLabel("Audio source"))
        self.source_picker = QtWidgets.QComboBox()
        self.source_picker.setMinimumWidth(300)
        for source in self.sources:
            self.source_picker.addItem(source.name)
        self.source_picker.setCurrentIndex(-1)
        controls.addWidget(self.source_picker, 1)
        retry = QtWidgets.QPushButton("Reconnect")
        retry.clicked.connect(lambda: self.select_source(self.source_picker.currentIndex()))
        controls.addWidget(retry)
        layout.addLayout(controls)
        layout.addWidget(canvas, 1)
        self.setCentralWidget(container)
        plot = canvas.addPlot(title="LIVE AUDIO · newest audio at the right")
        self.plot = plot
        plot.setLabel("bottom", "Time", units="s")
        plot.setLabel("left", "Frequency", units="Hz")
        plot.setMouseEnabled(x=False, y=False)
        plot.setMenuEnabled(False)
        plot.hideButtons()
        plot.setRange(xRange=(-model.duration, 0), yRange=(0, max_frequency), padding=0)

        self.image = pg.ImageItem(axisOrder="row-major")
        plot.addItem(self.image)
        self.image.setImage(model.history, autoLevels=False, levels=(FLOOR_DB, 0))
        bin_width = model.sample_rate / FFT_SIZE
        self.image.setRect(
            QtCore.QRectF(
                -model.duration,
                -bin_width / 2,
                model.duration,
                model.sample_rate / 2 + bin_width,
            )
        )
        color_bar = pg.ColorBarItem(
            values=(FLOOR_DB, 0),
            colorMap=pg.colormap.get("viridis"),
            label="Peak amplitude (dBFS)",
            interactive=False,
        )
        canvas.addItem(color_bar, row=0, col=1)
        color_bar.setImageItem(self.image)
        self.statusBar().showMessage("Listening · close the window to stop · audio is not saved")
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(33)
        self.source_picker.currentIndexChanged.connect(self.select_source)

    def select_source(self, index: int) -> None:
        if not 0 <= index < len(self.sources):
            return
        if self.capture is not None:
            self.capture.close()
        source = self.sources[index]
        self.capture = AudioCapture(source)
        self.microphone = self.capture.audio
        self.model = Spectrogram(source.sample_rate, self.model.seconds)
        self.expected_sequence = 0
        bin_width = source.sample_rate / FFT_SIZE
        self.image.setImage(self.model.history, autoLevels=False)
        self.image.setRect(
            QtCore.QRectF(
                -self.model.duration,
                -bin_width / 2,
                self.model.duration,
                source.sample_rate / 2 + bin_width,
            )
        )
        self.plot.setRange(
            xRange=(-self.model.duration, 0),
            yRange=(0, min(self.max_frequency, source.sample_rate / 2)),
            padding=0,
        )
        try:
            self.capture.start()
        except Exception as error:
            self.capture.close()
            self.capture = None
            hint = (
                "Allow Screen & System Audio Recording in System Settings, then Reconnect."
                if source.device is None and sys.platform == "darwin"
                else "Check device availability and recording permission, then Reconnect."
            )
            self.statusBar().showMessage(f"Stopped: {error} · {hint}")
            return
        self.statusBar().showMessage(f"Listening: {source.name} · audio is not saved")

    def closeEvent(self, event: QtGui.QCloseEvent) -> None:
        self.timer.stop()
        if self.capture is not None:
            self.capture.close()
        super().closeEvent(event)

    def refresh(self) -> None:
        if self.capture is not None:
            error = self.capture.error
            if self.capture.input is not None and not self.capture.input.active:
                error = "Input disconnected or stopped"
            if error is not None:
                self.capture.close()
                self.capture = None
                self.statusBar().showMessage(f"Stopped: {error} · select a source or Reconnect")
                return
        changed = False
        # Bound each refresh so the GUI remains responsive under heavy load.
        for _ in range(64):
            try:
                sequence, samples, overflow = self.microphone.blocks.popleft()
            except IndexError:
                break
            if sequence != self.expected_sequence or overflow:
                self.model.reset()
                changed = True
                self.statusBar().showMessage("Audio gap detected · history restarted", 5000)
            self.expected_sequence = sequence + 1
            changed |= self.model.push(samples)
        if changed:
            self.image.setImage(self.model.history, autoLevels=False)


def positive_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-devices", action="store_true", help="list audio devices and exit")
    parser.add_argument(
        "--device", help="input device index or name (default: built-in Mac mic or system input)"
    )
    parser.add_argument("--seconds", type=positive_float, default=10.0, help="visible history (10)")
    parser.add_argument(
        "--max-frequency", type=positive_float, default=30000.0, help="top Hz (12000)"
    )
    args = parser.parse_args()
    device_text = cast(str | None, args.device)
    device: int | str | None = device_text
    if device_text is not None and device_text.isdecimal():
        device = int(device_text)

    try:
        if args.list_devices:
            print(sd.query_devices())
            return 0
        sources = input_sources()
        selected = 0
        if device is not None:
            info = sd.query_devices(device, "input")
            selected = next(
                index
                for index, source in enumerate(sources)
                if source.device is not None
                and source.name == info["name"]
                and (not isinstance(device, int) or source.device == device)
            )
        else:
            default_input = int(sd.default.device[0])
            selected = next(
                (index for index, source in enumerate(sources) if source.device == default_input), 0
            )
            if sys.platform == "darwin":
                selected = next(
                    (
                        index
                        for index, source in enumerate(sources)
                        if any(
                            name in source.name.lower()
                            for name in ("macbook", "built-in microphone", "imac")
                        )
                    ),
                    selected,
                )
        app = QtWidgets.QApplication(sys.argv[:1])
        pg.setConfigOptions(antialias=False, background="#10151e", foreground="#dce4ef")
        model = Spectrogram(sources[selected].sample_rate, args.seconds)
        window = SpectrogramWindow(Microphone(), model, args.max_frequency, sources)
        window.show()
        window.source_picker.setCurrentIndex(selected)
        return app.exec()
    except (sd.PortAudioError, ValueError) as error:
        print(f"Could not open microphone: {error}", file=sys.stderr)
        print(
            "Check microphone permission for your terminal or Codex in System Settings, "
            "or use --list-devices and --device INDEX.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
