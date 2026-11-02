#!/usr/bin/env python3
"""Build the OpenHarness orchestration harness for the Layer 2 pipeline.

Each stage is a thin Python code node that imports the baked-in `pipeline` package and runs one
transform, reporting its RunResult. Nodes are chained start -> ... -> finish so they run in order
on the harness schedule (the executor injects the workspace MONGODB_URI; Layer 2/3 need no secrets).

Emit the workflow JSON:  python build_pipeline_harness.py > harness.json
"""
import json
import sys

NODE_TEMPLATE = """import oh
import pipeline
try:
    result = pipeline.run({transform!r})
    oh.result(result)
    oh.log({transform!r}, result)
    if result.get("status") != "succeeded" or result.get("dq", {{}}).get("error"):
        raise RuntimeError(f"{transform} failed or had error-severity DQ: {{result}}")
except Exception as e:
    import traceback
    oh.log(traceback.format_exc())
    oh.result({{"transform": {transform!r}, "status": "failed", "error": str(e)}})
    raise
"""

# Ordered Layer 2 chain (dependencies first). trading_calendar is yearly; kept in the chain but cheap.
STAGES = [
    ("securities", "build_securities", "Securities"),
    ("corporate_actions", "build_corporate_actions", "Corporate actions"),
    ("prices_daily", "build_prices_daily", "Prices daily"),
    ("macro_daily", "build_macro_daily", "Macro daily"),
]


def build():
    nodes = [{"id": "start", "type": "start", "name": "Start", "next": STAGES[0][0]}]
    for i, (nid, transform, label) in enumerate(STAGES):
        nxt = STAGES[i + 1][0] if i + 1 < len(STAGES) else "finish"
        nodes.append(
            {
                "id": nid,
                "type": "code",
                "name": label,
                "code": NODE_TEMPLATE.format(transform=transform),
                "timeoutSeconds": 3600,
                "next": nxt,
            }
        )
    nodes.append({"id": "finish", "type": "finish", "name": "Finish", "template": "Layer 2 pipeline complete."})
    return {
        "name": "Pipeline — Layer 2 (daily)",
        "description": "Builds the point-in-time Layer 2 collections from raw data. Runs after the "
        "daily dataset sync; each node calls pipeline.run() in the executor.",
        "enabled": True,
        "startAt": "start",
        "nodes": nodes,
        "maxSteps": 100,
        "schedule": {
            "enabled": True,
            "everyMinutes": 1440,
            "at": "19:00",
            "timezone": "America/New_York",
            "input": "scheduled layer 2 build",
        },
    }


if __name__ == "__main__":
    json.dump(build(), sys.stdout)
