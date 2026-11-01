"""Serve web/ on localhost. Run with `python3 serve.py`."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8000
WEB = Path(__file__).parent / "web"


def main() -> None:
    handler = partial(SimpleHTTPRequestHandler, directory=WEB)
    with ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        print(f"Serving http://localhost:{PORT}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
