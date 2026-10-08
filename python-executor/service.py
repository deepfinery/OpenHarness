"""HTTP mode of the Python executor, for installations without Kubernetes (Docker Compose).

POST /jobs with a bearer token starts one job: the same runner.py as a Kubernetes Job would run, as a child
process with its own working directory, so several jobs run side by side. The runner reports its outcome to the
OpenHarness API itself; this service only starts processes and answers health checks.

Environment: EXECUTOR_TOKEN (required), EXECUTOR_PORT (default 7000), EXECUTOR_MAX_JOBS (default 8),
EXECUTOR_WORK_ROOT (default /work).
"""

from __future__ import annotations

import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = os.environ.get("EXECUTOR_TOKEN", "")
MAX_JOBS = int(os.environ.get("EXECUTOR_MAX_JOBS", "8"))
WORK_ROOT = Path(os.environ.get("EXECUTOR_WORK_ROOT", "/work"))
RUNNER = Path(__file__).with_name("runner.py")
_lock = threading.Lock()
_active: dict[str, subprocess.Popen] = {}


def _reap(job_id: str, process: subprocess.Popen, work: Path) -> None:
    process.wait()
    with _lock:
        _active.pop(job_id, None)
    shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "openharness-python-executor"

    def log_message(self, format, *args):  # noqa: A002 - BaseHTTPRequestHandler signature
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return bool(TOKEN) and hmac.compare_digest(header, f"Bearer {TOKEN}")

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            with _lock:
                active = len(_active)
            return self._json(200, {"status": "ok", "active": active, "max": MAX_JOBS})
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        try:
            self._start_job()
        except Exception as error:  # noqa: BLE001 - always answer, never drop the connection
            sys.stderr.write(f"job start failed: {error}\n")
            self._json(500, {"error": f"The executor could not start the job: {error}"})

    def _start_job(self):
        if self.path != "/jobs":
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(403, {"error": "forbidden"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            job_id, url, token = str(body["id"]), str(body["jobUrl"]), str(body["jobToken"])
        except (ValueError, KeyError):
            return self._json(400, {"error": "id, jobUrl and jobToken are required"})
        with _lock:
            if len(_active) >= MAX_JOBS:
                return self._json(429, {"error": f"The executor is running {MAX_JOBS} jobs already"})
            if job_id in _active:
                return self._json(409, {"error": "This job is already running"})
            work = Path(tempfile.mkdtemp(prefix=f"job-{job_id[:12]}-", dir=WORK_ROOT))
            env = {
                "PATH": os.environ.get("PATH", ""),
                "OH_JOB_URL": url,
                "OH_JOB_TOKEN": token,
                "OH_WORKDIR": str(work),
                "PYTHONUNBUFFERED": "1",
            }
            for key in ("OH_CA_FILE", "OH_OUTPUT_LIMIT", "OH_RESULT_LIMIT", "LANG", "TZ"):
                if key in os.environ:
                    env[key] = os.environ[key]
            process = subprocess.Popen([sys.executable, str(RUNNER)], env=env, cwd=work)
            _active[job_id] = process
        threading.Thread(target=_reap, args=(job_id, process, work), daemon=True).start()
        self._json(202, {"id": job_id, "pid": process.pid})


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("EXECUTOR_TOKEN is required")
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("EXECUTOR_PORT", "7000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"python executor listening on {port}", flush=True)
    server.serve_forever()
