# Python executor

Agents and harnesses can run Python. The code runs in a fresh container of the `python-executor` image (Python 3.12 with numpy, pandas, pyarrow, polars, duckdb, scipy, numba, statsmodels, scikit-learn, lightgbm, TA-Lib, empyrical-reloaded, exchange-calendars and pytz), reads and writes the workspace's MongoDB collections through the `oh` helpers, and hands its result back to the agent or the next harness step. Many jobs run side by side.

## Two ways in

- **Agent tool `run_python`.** Turn on **Can run Python it writes** in the agent's _Safety & human input_ tab. The agent writes a complete script, sends it with optional `params`, and gets back `{status, exit_code, result, stdout, stderr}`. `params_list` runs the same script once per entry, each in its own container in parallel (for example one job per ticker). **Ask a human to approve the code before each run** routes every call through the Inbox like a risky MCP tool.
- **Harness step `Python code`.** Drag it from the toolbox. Its parameters are JSON with templates (`{"ticker": "{{payload.ticker}}", "rows": "{{last}}"}`), rendered before the run. The step's value is what the code set with `oh.result(...)`, otherwise what it printed, so `{{last}}` and `{{steps.<id>}}` carry it on. A failed job fails the run with the code's stderr in the error. The step can require approval through the harness or step approval settings (tool id `builtin.run_python`).

## What the code can use

```python
import oh

prices = oh.read_df("prices", {"ticker": oh.params["ticker"]}, sort=[("date", 1)])
prices["sma20"] = prices["close"].rolling(20).mean()
oh.write_df("signals", prices[["ticker", "date", "sma20"]], mode="append")
oh.result({"ticker": oh.params["ticker"], "rows": len(prices)})
```

| Helper                                                                  | Purpose                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `oh.params`                                                             | The parameters passed to this job (`params`, one entry of `params_list`, or the step's parameters). |
| `oh.collections()`                                                      | Collection names in the workspace database.                                                         |
| `oh.read(name, filter=None, *, limit=None, sort=None, projection=None)` | Documents as dicts (`_id` as a string).                                                             |
| `oh.read_df(name, filter=None, **kwargs)`                               | The same as a pandas DataFrame.                                                                     |
| `oh.write(name, records, *, mode="append")`                             | Insert documents; `mode="replace"` empties the collection first. Returns the inserted count.        |
| `oh.write_df(name, frame, *, mode="append")`                            | One document per row; NaN becomes null, timestamps become ISO strings.                              |
| `oh.result(value)`                                                      | The structured result handed back (JSON, at most 1 MB).                                             |
| `oh.log(...)`                                                           | `print` with flushing.                                                                              |

Nothing persists between jobs except what the code writes to collections. `MONGODB_URI` in the job points at the workspace database with a user that has `readWrite` on that database only; the job cannot see other workspaces, the application database or the broker. The last 200 KB of stdout and stderr come back; the full outcome is on the run's jobs (`GET /api/runs/<id>/jobs`).

## Secrets

API keys and passwords the code needs live under **Settings → Python secrets** (`PUT /api/executor/secrets/<NAME>` with `{"value": ...}`, or `{"connectionId": ..., "queryParam": "apikey"}` to copy the key an MCP connection already holds, server-side). Values are stored encrypted and never returned. A Python step lists the secrets it uses (`secrets: ["FMP_API_KEY"]`), and so does an agent (`codeExecution.secrets`); the job gets exactly those as environment variables (`os.environ["FMP_API_KEY"]`). A listed secret that does not exist fails the job before it starts. Code can print what it is given, so give an agent only the secrets its task needs.

```python
import os, json, urllib.request, oh

url = f"https://financialmodelingprep.com/stable/quote?symbol={oh.params['symbol']}&apikey={os.environ['FMP_API_KEY']}"
quote = json.load(urllib.request.urlopen(url, timeout=30))
oh.write("quotes", quote)
oh.result({"symbol": oh.params["symbol"], "price": quote[0]["price"]})
```

A harness whose Start has a schedule (for example every minute) runs such a step on its own, with no agent involved.

## How a job runs

1. The runner stores the job (code, parameters, timeout, a one-time token) and starts a container.
2. The container's trusted runner fetches the job from the API with the token (`GET /api/executor/jobs/<id>`), writes the code to a private working directory with `oh.py` beside it, and runs it in a separate interpreter (`python -E -s`: no inherited `PYTHON*` settings or user packages), with the timeout.
3. It posts `running` and then the outcome (`POST /api/executor/jobs/<id>`): exit code, stdout, stderr, `oh.result()` value, duration.
4. The runner, which has been polling the job record, returns the outcome. A run that is interrupted and resumed reattaches to the jobs it already started; a cancelled run cancels its jobs.

### Kubernetes

Each job is a `batch/v1` Job in the application namespace, created with the app pod's service account (`openharness-app`, Role `openharness-python-jobs`: jobs, pods, pod logs). Job pods run as non-root with a read-only root filesystem, no service-account token, `EXECUTOR_JOB_CPU`/`EXECUTOR_JOB_MEMORY` requests and limits, an `emptyDir` of `EXECUTOR_JOB_DISK` for `/work`, `activeDeadlineSeconds` of the timeout plus a launch allowance, and are deleted `EXECUTOR_JOB_TTL_SECONDS` after they finish. The `python-jobs` NetworkPolicy lets them reach only the API (8088), MongoDB (27017), cluster DNS and the public internet (data-provider APIs), never other services in the namespace. When a job never reports back, the runner records the Job and pod state (for example `ImagePullBackOff`, `OOMKilled`) and the last log lines.

The image the Jobs run is taken from the app pod's `executor-image` init container, so the overlay's `images:` entry pins it by digest along with the other images (or set `EXECUTOR_IMAGE`).

### Docker Compose

The `python-executor` service runs the same image in HTTP mode: the API posts a job (`EXECUTOR_URL`, `EXECUTOR_TOKEN`), and the service starts the same trusted runner as a child process in its own working directory, up to `EXECUTOR_MAX_JOBS` at a time. There is no container per job here; use Kubernetes for isolation between jobs.

## Settings

| Variable                                                       | Default            | Purpose                                                                                                     |
| -------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `EXECUTOR_BACKEND`                                             | `` (off)           | `kubernetes` or `service`. Unset disables Python everywhere (the tool is not offered; steps fail clearly).  |
| `EXECUTOR_URL`, `EXECUTOR_TOKEN`                               |                    | The HTTP service (Compose). `start.sh` generates the token.                                                 |
| `EXECUTOR_CALLBACK_URL`                                        | `http://api:8088`  | How job containers reach this API.                                                                          |
| `EXECUTOR_IMAGE`, `EXECUTOR_NAMESPACE`                         |                    | Kubernetes: override the image (default: the `executor-image` init container) and namespace (default: own). |
| `EXECUTOR_JOB_CPU`, `EXECUTOR_JOB_MEMORY`, `EXECUTOR_JOB_DISK` | `1`, `2Gi`, `10Gi` | Per-job resources on Kubernetes.                                                                            |
| `EXECUTOR_MAX_PARALLEL`                                        | `16`               | Jobs a workspace may have in flight at once; `0` means no limit. Further jobs wait their turn.              |
| `EXECUTOR_DEFAULT_TIMEOUT_SECONDS`                             | `600`              | Timeout when neither the agent, the step nor the call sets one.                                             |
| `EXECUTOR_MAX_TIMEOUT_SECONDS`                                 | `86400`            | The longest a job may ask to run; `0` means no maximum.                                                     |
| `EXECUTOR_JOB_TTL_SECONDS`                                     | `3600`             | Kubernetes: how long finished Jobs are kept.                                                                |

The image is built from `python-executor/` (`requirements.txt` pins every library). Safety evaluations never run code: the tool is disabled and the step is simulated.
