"""The trusted entrypoint of an OpenHarness Python job.

It fetches the job from the OpenHarness API, runs the submitted code in a separate interpreter with the `oh`
helpers beside it, and posts the outcome back. The code never sees the job token: only the workspace-scoped
MongoDB connection string (when the workspace has MongoDB collections) and the parameters it was given.

Environment: OH_JOB_URL (the job's API endpoint), OH_JOB_TOKEN (one-time bearer token), MONGODB_URI (optional),
OH_WORKDIR (default /work), OH_CA_FILE (optional extra CA for OH_JOB_URL).
"""

from __future__ import annotations

import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

OUTPUT_LIMIT = int(os.environ.get("OH_OUTPUT_LIMIT", "200000"))
RESULT_LIMIT = int(os.environ.get("OH_RESULT_LIMIT", "1000000"))


def _context():
    ca = os.environ.get("OH_CA_FILE")
    return ssl.create_default_context(cafile=ca) if ca else None


def _request(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=60, context=_context()) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last = error
            time.sleep(min(2**attempt, 10))
    raise RuntimeError(f"{method} {url} failed: {last}")


def _tail(path: Path, limit: int) -> tuple[str, bool]:
    size = path.stat().st_size if path.exists() else 0
    with open(path, "rb") as handle:
        if size > limit:
            handle.seek(size - limit)
            return handle.read().decode("utf-8", "replace"), True
        return handle.read().decode("utf-8", "replace"), False


def main() -> int:
    url, token = os.environ["OH_JOB_URL"], os.environ["OH_JOB_TOKEN"]
    work = Path(os.environ.get("OH_WORKDIR", "/work"))
    work.mkdir(parents=True, exist_ok=True)
    job = _request("GET", url, token)
    started = time.time()
    _request("POST", url, token, {"status": "running"})
    (work / "main.py").write_text(job["code"], encoding="utf-8")
    shutil.copy(Path(__file__).with_name("oh.py"), work / "oh.py")
    result_path = work / ".oh-result.json"
    stdout_path, stderr_path = work / ".stdout", work / ".stderr"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(work),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "OH_PARAMS": json.dumps(job.get("params") or {}),
        "OH_RESULT_PATH": str(result_path),
        "OH_JOB_ID": str(job.get("id", "")),
    }
    if job.get("mongodbUri"):
        env["MONGODB_URI"] = job["mongodbUri"]
    # Secrets the step or agent was given, as environment variables; reserved names are never overridden.
    for name, value in (job.get("env") or {}).items():
        if name.isupper() and name not in env and not name.startswith(("OH_", "PYTHON")):
            env[name] = str(value)
    for key in ("LANG", "LC_ALL", "TZ", "NUMBA_CACHE_DIR", "MPLCONFIGDIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    env.setdefault("NUMBA_CACHE_DIR", str(work / ".numba"))
    env.setdefault("MPLCONFIGDIR", str(work / ".mpl"))
    timeout = float(job.get("timeoutSeconds") or 600)
    status, exit_code, error = "succeeded", 0, None
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        try:
            completed = subprocess.run(
                # -E -s: no PYTHON* variables, no user site packages; unlike -I it keeps the script's directory on
                # sys.path, so `import oh` finds the helpers next to main.py.
                [sys.executable, "-E", "-s", "main.py"], cwd=work, env=env, stdout=out, stderr=err, timeout=timeout
            )
            exit_code = completed.returncode
            if exit_code != 0:
                status, error = "failed", f"The code exited with status {exit_code}"
        except subprocess.TimeoutExpired:
            status, exit_code, error = "failed", -1, f"The code did not finish within {int(timeout)} seconds"
    stdout, stdout_truncated = _tail(stdout_path, OUTPUT_LIMIT)
    stderr, stderr_truncated = _tail(stderr_path, OUTPUT_LIMIT)
    result = None
    if result_path.exists():
        text = result_path.read_text(encoding="utf-8", errors="replace")
        if len(text) > RESULT_LIMIT:
            result, error = None, (error or f"oh.result() value exceeds {RESULT_LIMIT} bytes")
            status = "failed"
        else:
            try:
                result = json.loads(text)
            except ValueError:
                status, error = "failed", "oh.result() value is not valid JSON"
    _request(
        "POST",
        url,
        token,
        {
            "status": status,
            "exitCode": exit_code,
            "error": error,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": stdout_truncated or stderr_truncated,
            "result": result,
            "durationMs": int((time.time() - started) * 1000),
        },
    )
    return 0 if status == "succeeded" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - last resort: report, then exit non-zero
        url, token = os.environ.get("OH_JOB_URL"), os.environ.get("OH_JOB_TOKEN")
        if url and token:
            try:
                _request("POST", url, token, {"status": "failed", "error": f"Executor error: {error}"[:2000]})
            except Exception:  # noqa: BLE001
                pass
        print(f"executor error: {error}", file=sys.stderr)
        sys.exit(2)
