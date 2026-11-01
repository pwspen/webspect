import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from audiovis import FFT_SIZE, FLOOR_DB, HOP_SIZE, Spectrogram

ENGINE = Path(__file__).parent.parent / "web" / "spectrogram.js"
RUNNER = """
const { Spectrogram } = require(process.argv[1]);
const { sampleRate, seconds, chunks, resetAfter } = JSON.parse(require("fs").readFileSync(0));
const model = new Spectrogram(sampleRate, seconds);
chunks.forEach((chunk, index) => {
  model.push(Float32Array.from(chunk));
  if (index === resetAfter) model.reset();
});
const newest = Array.from({ length: model.columns }, (_, age) => {
  const index = model.total - model.columns + age;
  return index < 0 ? null : Array.from(model.column(index));
});
console.log(JSON.stringify({ newest, pendingSize: model.pendingSize, duration: model.duration }));
"""


def run_engine(
    chunks: list[np.ndarray], seconds: float, reset_after: int = -1
) -> dict[str, object]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to run the web engine")
    payload = {
        "sampleRate": 48000,
        "seconds": seconds,
        "chunks": [chunk.astype(float).tolist() for chunk in chunks],
        "resetAfter": reset_after,
    }
    completed = subprocess.run(
        [node, "-e", RUNNER, str(ENGINE)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    result: dict[str, object] = json.loads(completed.stdout)
    return result


def web_history(result: dict[str, object]) -> np.ndarray:
    columns = result["newest"]
    assert isinstance(columns, list)
    filled = [
        np.full(FFT_SIZE // 2 + 1, FLOOR_DB) if column is None else np.array(column)
        for column in columns
    ]
    return np.stack(filled, axis=1)


def test_engine_matches_numpy_across_chunk_boundaries() -> None:
    samples = np.random.default_rng(0).normal(0, 0.1, FFT_SIZE * 6).astype(np.float32)
    model = Spectrogram(48000, seconds=0.25)
    model.push(samples)
    result = run_engine(list(np.array_split(samples, 29)), 0.25)
    np.testing.assert_allclose(web_history(result), model.history, atol=0.01)
    assert result["pendingSize"] == model.pending.size
    assert result["duration"] == model.duration


def test_engine_matches_numpy_after_the_history_wraps() -> None:
    samples = np.random.default_rng(1).normal(0, 0.1, FFT_SIZE * 8).astype(np.float32)
    model = Spectrogram(48000, seconds=HOP_SIZE * 5 / 48000)
    model.push(samples)
    result = run_engine([samples], HOP_SIZE * 5 / 48000)
    np.testing.assert_allclose(web_history(result), model.history, atol=0.01)


def test_engine_tone_silence_and_reset() -> None:
    tone = 0.5 * np.sin(2 * np.pi * 64 * np.arange(FFT_SIZE) / FFT_SIZE)
    history = web_history(run_engine([tone.astype(np.float32)], 0.05))
    assert np.argmax(history[:, -1]) == 64
    np.testing.assert_allclose(history[64, -1], -6.0206, atol=0.01)

    silence = web_history(run_engine([np.zeros(FFT_SIZE * 3, dtype=np.float32)], 0.05))
    assert np.all(np.isfinite(silence))
    np.testing.assert_allclose(silence, FLOOR_DB)

    cleared = run_engine([tone.astype(np.float32)], 0.05, reset_after=0)
    assert cleared["pendingSize"] == 0
    np.testing.assert_allclose(web_history(cleared), FLOOR_DB)


def sharpness_curve(histogram: np.ndarray, sharpness: float) -> np.ndarray:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to run the web engine")
    script = """
const { sharpnessCurve } = require(process.argv[1]);
const { histogram, sharpness } = JSON.parse(require("fs").readFileSync(0));
console.log(JSON.stringify(Array.from(sharpnessCurve(histogram, sharpness))));
"""
    payload = {"histogram": histogram.tolist(), "sharpness": sharpness}
    completed = subprocess.run(
        [node, "-e", script, str(ENGINE)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    return np.array(json.loads(completed.stdout), dtype=float)


def level_histogram() -> np.ndarray:
    levels = np.random.default_rng(2).normal(0.5, 0.15, 200000).clip(0, 1)
    return np.bincount(np.round(levels * 4095).astype(int), minlength=4096)


@pytest.mark.parametrize("sharpness", [0.125, 0.5, 1.0, 2.0, 8.0])
def test_sharpness_conserves_the_mean_level(sharpness: float) -> None:
    histogram = level_histogram()
    curve = sharpness_curve(histogram, sharpness) / 255
    position = np.linspace(0, 1, curve.size)
    target = np.average(position, weights=histogram)
    np.testing.assert_allclose(np.average(curve, weights=histogram), target, atol=0.003)
    assert curve[0] == 0
    assert np.all(np.diff(curve) >= 0)


def test_sharpness_moves_level_from_flat_to_peaks() -> None:
    histogram = level_histogram()
    position = np.linspace(0, 1, histogram.size)
    spread = [
        np.sqrt(np.cov(sharpness_curve(histogram, sharpness), fweights=histogram))
        for sharpness in (0.125, 1.0, 8.0)
    ]
    assert spread[0] < spread[1] < spread[2]
    np.testing.assert_allclose(sharpness_curve(histogram, 1.0), np.round(position * 255), atol=1)


def test_sharpness_ignores_silence() -> None:
    histogram = level_histogram()
    silent = histogram.copy()
    silent[0] += 5000000
    np.testing.assert_array_equal(sharpness_curve(histogram, 4), sharpness_curve(silent, 4))
    assert np.all(sharpness_curve(np.zeros(4096, dtype=int), 4)[:2] == 0)


def test_resizing_keeps_the_newest_history() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to run the web engine")
    script = """
const { Spectrogram, BINS, FFT_SIZE, HOP_SIZE } = require(process.argv[1]);
const samples = Float32Array.from({ length: FFT_SIZE * 6 }, (_, n) => Math.sin(n * n * 1e-5) / 2);
const model = new Spectrogram(48000, (HOP_SIZE * 8) / 48000);
model.push(samples);
const rows = (source) => {
  const count = Math.min(source.total, source.columns);
  return Array.from({ length: count }, (_, age) => (
    Array.from(source.column(source.total - count + age))
  ));
};
const shrunk = model.resized((HOP_SIZE * 3) / 48000);
const grown = model.resized((HOP_SIZE * 20) / 48000);
console.log(JSON.stringify({
  original: rows(model), shrunk: rows(shrunk), grown: rows(grown),
  pending: [model.pendingSize, shrunk.pendingSize, grown.pendingSize],
}));
"""
    completed = subprocess.run(
        [node, "-e", script, str(ENGINE)], capture_output=True, text=True, check=True
    )
    result = json.loads(completed.stdout)
    original = np.array(result["original"])
    assert original.shape[0] == 8
    np.testing.assert_array_equal(np.array(result["shrunk"]), original[-3:])
    np.testing.assert_array_equal(np.array(result["grown"]), original)
    assert len(set(result["pending"])) == 1


def run_warp(script: str) -> dict[str, list[int] | list[float] | float]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to run the web engine")
    prelude = "const { warpPosition, warpFrequency, rowBins, BINS } = require(process.argv[1]);"
    completed = subprocess.run(
        [node, "-e", prelude + script, str(ENGINE)], capture_output=True, text=True, check=True
    )
    result: dict[str, list[int] | list[float] | float] = json.loads(completed.stdout)
    return result


def test_warp_inverts_and_matches_mel() -> None:
    result = run_warp(
        """
const frequencies = [0, 50, 700, 1000, 8000, 20000];
console.log(JSON.stringify({
  linear: frequencies.map((f) => warpPosition(f, 20000, Infinity)),
  mel: frequencies.map((f) => warpPosition(f, 20000, 700)),
  back: frequencies.map((f) => warpFrequency(warpPosition(f, 20000, 700), 20000, 700)),
  wide: frequencies.map((f) => warpPosition(f, 20000, 2e9)),
}));
"""
    )
    frequencies = np.array([0, 50, 700, 1000, 8000, 20000], dtype=float)
    np.testing.assert_allclose(result["linear"], frequencies / 20000)
    mel = 2595 * np.log10(1 + frequencies / 700)
    np.testing.assert_allclose(result["mel"], mel / mel[-1])
    np.testing.assert_allclose(result["back"], frequencies, atol=1e-9)
    np.testing.assert_allclose(result["wide"], frequencies / 20000, atol=1e-4)


@pytest.mark.parametrize("corner", ["Infinity", "700", "40"])
@pytest.mark.parametrize("rows", [80, 400, 3000])
def test_rows_cover_every_visible_bin_in_order(corner: str, rows: int) -> None:
    result = run_warp(
        f"""
const {{ first, last }} = rowBins({rows}, 20000, {corner}, 48000 / 2048);
console.log(JSON.stringify({{ first: Array.from(first), last: Array.from(last) }}));
"""
    )
    first = np.array(result["first"])[::-1]
    last = np.array(result["last"])[::-1]
    top_bin = round(20000 / (48000 / 2048))
    assert first[0] == 0
    assert last[-1] == top_bin
    assert np.all(last >= first)
    assert np.all(first[1:] <= last[:-1] + 1)
    assert np.all(np.diff(first) >= 0)
