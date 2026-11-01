import numpy as np
import pytest
from PySide6 import QtCore, QtWidgets

from audiovis import (
    FFT_SIZE,
    FLOOR_DB,
    HOP_SIZE,
    AudioCapture,
    AudioSource,
    Microphone,
    Spectrogram,
    SpectrogramWindow,
    input_sources,
)


def test_tone_frequency_and_amplitude() -> None:
    model = Spectrogram(48000)
    frequency_bin = 64
    samples = (0.5 * np.sin(2 * np.pi * frequency_bin * np.arange(FFT_SIZE) / FFT_SIZE)).astype(
        np.float32
    )
    assert model.push(samples)
    column = model.history[:, -1]
    assert np.argmax(column) == frequency_bin
    np.testing.assert_allclose(column[frequency_bin], -6.0206, atol=0.01)
    assert np.all(model.history[:, :-1] == FLOOR_DB)


def test_chunk_boundaries_do_not_change_analysis() -> None:
    samples = np.random.default_rng(0).normal(0, 0.1, FFT_SIZE * 4).astype(np.float32)
    whole = Spectrogram(48000)
    chunked = Spectrogram(48000)
    whole.push(samples)
    for chunk in np.array_split(samples, 29):
        chunked.push(chunk)
    np.testing.assert_allclose(whole.history, chunked.history)
    np.testing.assert_array_equal(whole.pending, chunked.pending)


def test_silence_short_history_and_reset() -> None:
    model = Spectrogram(48000, seconds=HOP_SIZE / 48000)
    model.push(np.zeros(FFT_SIZE * 3, dtype=np.float32))
    assert model.history.shape == (FFT_SIZE // 2 + 1, 1)
    assert np.all(np.isfinite(model.history))
    np.testing.assert_allclose(model.history, FLOOR_DB)
    model.reset()
    assert model.pending.size == 0
    assert np.all(model.history == FLOOR_DB)


def test_window_consumes_audio_and_handles_gaps() -> None:
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    microphone = Microphone()
    model = Spectrogram(48000)
    window = SpectrogramWindow(microphone, model, 12000)
    microphone.blocks.append((0, np.ones(FFT_SIZE, dtype=np.float32), False))
    window.refresh()
    assert model.history[0, -1] > -0.01
    microphone.blocks.append((2, np.zeros(FFT_SIZE, dtype=np.float32), False))
    window.refresh()
    np.testing.assert_allclose(model.history, FLOOR_DB)
    window.show()
    app.processEvents()
    assert not window.grab().isNull()
    window.close()
    window.deleteLater()
    app.sendPostedEvents(None, QtCore.QEvent.Type.DeferredDelete)


def test_source_switching_and_failed_capture(monkeypatch: pytest.MonkeyPatch) -> None:
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    started: list[AudioCapture] = []
    closed: list[AudioCapture] = []

    def start(capture: AudioCapture) -> None:
        started.append(capture)
        if capture.source.name == "Unavailable":
            raise RuntimeError("Device disconnected")

    monkeypatch.setattr(AudioCapture, "start", start)
    monkeypatch.setattr(AudioCapture, "close", lambda capture: closed.append(capture))
    sources = [
        AudioSource("Computer audio", None, 48000),
        AudioSource("Microphone", 1, 16000),
        AudioSource("Unavailable", 2, 44100),
    ]
    window = SpectrogramWindow(Microphone(), Spectrogram(48000), 12000, sources)
    window.source_picker.setCurrentIndex(0)
    first = started[-1]
    first.audio.blocks.append((0, np.ones(FFT_SIZE, dtype=np.float32), False))
    window.refresh()
    assert window.model.history[0, -1] > -0.01
    window.source_picker.setCurrentIndex(1)
    assert closed == [first]
    assert window.model.sample_rate == 16000
    assert window.microphone is started[-1].audio
    assert window.expected_sequence == 0
    assert np.all(window.model.history == FLOOR_DB)
    assert window.plot.viewRange()[1][1] == 8000
    window.source_picker.setCurrentIndex(2)
    assert window.capture is None
    assert "Device disconnected" in window.statusBar().currentMessage()
    window.source_picker.setCurrentIndex(0)
    assert window.capture is started[-1]
    window.close()
    assert closed[-1] is started[-1]
    window.deleteLater()
    app.sendPostedEvents(None, QtCore.QEvent.Type.DeferredDelete)


def test_source_list_excludes_output_only_devices(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "audiovis.sd.query_devices",
        lambda: [
            {"name": "Speakers", "max_input_channels": 0, "default_samplerate": 48000},
            {"name": "USB microphone", "max_input_channels": 1, "default_samplerate": 44100},
        ],
    )
    assert input_sources() == [
        AudioSource("Computer audio", None, 48000),
        AudioSource("USB microphone", 1, 44100),
    ]
