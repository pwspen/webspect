# Audiovis

A live, scrolling spectrogram from computer audio or any input device, in any modern browser.
`web/` is a dependency-free static page, and `serve.py` hosts it on localhost using only
the Python standard library:

```sh
python3 serve.py
```

Open <http://localhost:8000>. Browsers only allow audio capture on `localhost` or over
HTTPS, so host it on any static HTTPS server to use it elsewhere.

Microphones and input devices work everywhere. **Computer audio** uses screen sharing with
audio in Chrome and Edge on macOS and Windows. Firefox, Safari, and Linux browsers capture
through a loopback device instead, and the page's setup section shows the steps for each
browser and system. Phones and tablets are limited to the microphone. **Test signal** checks
the display without any permissions. Capture runs at 48 kHz whenever the browser allows it,
so Bluetooth headphones in call mode don't narrow the display.

Time scrolls left, with newest audio on the right. Frequency increases upward;
brighter colors mean stronger signals. The fixed −90 to 0 dBFS scale measures
digital amplitude, not calibrated sound pressure. The display uses a 2048-sample
Hann window and 512-sample hop.
