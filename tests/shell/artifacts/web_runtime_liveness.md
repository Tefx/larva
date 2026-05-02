## Web Runtime Liveness Proof

This artifact preserves the runnable liveness proof for the web surface tests.
Reviewer-facing test artifacts should link here instead of relying on phase-local
gate notes.

### Packaged runtime: `larva serve`

Runnable equivalent used for artifact capture:

```bash
uv run python -m larva.shell.web --port 7411 --no-open
```

Probe:

```text
GET http://127.0.0.1:7411/
status=200
content-type=text/html; charset=utf-8
body-prefix='<!DOCTYPE html>\n<html lang="en">\n<head>...'
```

Captured startup/shutdown log:

```text
INFO:     Started server process [14926]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:7411 (Press CTRL+C to quit)
INFO:     127.0.0.1:59510 - "GET / HTTP/1.1" 200 OK
INFO:     Shutting down
INFO:     Waiting for application shutdown.
INFO:     Application shutdown complete.
INFO:     Finished server process [14926]
```

### Contrib runtime: `python contrib/web/server.py`

Runnable equivalent used for artifact capture:

```bash
uv run python contrib/web/server.py --port 7412 --no-open
```

Probe:

```text
GET http://127.0.0.1:7412/
status=200
content-type=text/html; charset=utf-8
body-prefix='<!DOCTYPE html>\n<html lang="en">\n<head>...'
```

Captured startup/shutdown log:

```text
INFO:     Started server process [14927]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:7412 (Press CTRL+C to quit)
INFO:     127.0.0.1:59511 - "GET / HTTP/1.1" 200 OK
INFO:     Shutting down
INFO:     Waiting for application shutdown.
INFO:     Application shutdown complete.
INFO:     Finished server process [14927]
```

### Traceability map

- `tests/shell/test_web.py` -> authoritative packaged runtime proof in this file
- `tests/shell/test_contrib_web.py` -> contrib convenience runtime proof in this file
- `README.md` and `docs/guides/USER_GUIDE.md` -> reviewer-facing docs that point back to this preserved test artifact
- `docs/reference/INTERFACES.md` -> normative contract doc that points readers to this runnable proof artifact without changing the contract itself
