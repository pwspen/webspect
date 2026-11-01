# Audiovis

A live, scrolling spectrogram from computer audio or any input device, written in typed Python.
Uses NumPy, sounddevice, PySide6, and PyQtGraph. Managed with uv.

```sh
uv run audiovis
```

Allow microphone access when macOS asks. If needed, enable your terminal or Codex
under **System Settings → Privacy & Security → Microphone**, then restart it.
Use the **Audio source** dropdown to switch between **Computer audio** and any
available microphone or input device. Switching sources clears the history and
updates the frequency scale. **Reconnect** retries the selected source after a
permission change or device interruption.

Computer audio uses native capture through [pysysaudio](https://pypi.org/project/pysysaudio/)
(macOS 14.2+ or Windows). On macOS, allow **Screen & System Audio Recording** for
your terminal or Codex when prompted. No virtual audio cable is needed. On Linux,
select a configured monitor/loopback input device instead. Devices are listed at
startup; restart the app after attaching a new device.

Close the window to stop capture. Audio stays in memory and is never saved.

Time scrolls left, with newest audio on the right. Frequency increases upward;
brighter colors mean stronger signals. The fixed −90 to 0 dBFS scale measures
digital amplitude, not calibrated sound pressure. The display uses a 2048-sample
Hann window and 512-sample hop, at your input device's native sample rate.

```sh
uv run audiovis --list-devices
uv run audiovis --device 1
uv run audiovis --seconds 20 --max-frequency 8000
```

The app prefers the built-in microphone on a Mac and otherwise uses the system
default input. Override the selection with a device index or name using `--device`.
If capture falls behind or overflows, history resets to avoid joining unrelated samples.
On Linux, install the system PortAudio library and Qt platform dependencies if missing.

## Web version

`web/` is a dependency-free static page with the same analysis, in any modern browser:

```sh
python3 -m http.server --directory web 8000
```

Open <http://localhost:8000>. Browsers only allow audio capture on `localhost` or over
HTTPS, so host it on any static HTTPS server to use it elsewhere.

Microphones and input devices work everywhere. **Computer audio** uses screen sharing with
audio in Chrome and Edge on macOS and Windows. Firefox, Safari, and Linux browsers capture
through a loopback device instead, and the page's setup section shows the steps for each
browser and system. Phones and tablets are limited to the microphone. **Test signal** checks
the display without any permissions. Capture runs at 48 kHz whenever the browser allows it,
so Bluetooth headphones in call mode don't narrow the display.

## Development

```sh
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy audiovis.py tests
QT_QPA_PLATFORM=offscreen uv run pytest
```

API references: [sounddevice](https://python-sounddevice.readthedocs.io/en/latest/)
and [PyQtGraph ImageItem](https://pyqtgraph.readthedocs.io/en/latest/api_reference/graphicsItems/imageitem.html).
