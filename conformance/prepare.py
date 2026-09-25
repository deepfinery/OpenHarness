"""
Prepares a conformance run against a running OpenHarness:

1. downloads the Open Harness spec repository at the pinned commit (its Python package and conformance tests);
2. adds the OpenHarness adapter to the suite's adapter list;
3. through the API, creates a conformance agent with the fixture MCP tools and a workspace key;
4. prints the environment the adapter reads.

Standard library only, so it runs before anything is installed.
"""

import io
import json
import os
import sys
import tarfile
import urllib.request
from http.cookiejar import CookieJar

SPEC_COMMIT = os.environ.get("SPEC_COMMIT") or "f727de17dffe5adac4f54c7e87f3aae2afe7b864"
BASE = os.environ.get("TEST_BASE_URL", "http://localhost:8088").rstrip("/")
ADMIN = {
    "email": os.environ.get("CONFORMANCE_ADMIN_EMAIL", "admin@openharness.test"),
    "password": os.environ.get("CONFORMANCE_ADMIN_PASSWORD", "Integration-test-password-42"),
}
MODEL_URL = os.environ.get("CONFORMANCE_MODEL_URL", "http://fixtures:9090/v1")
MCP_URL = os.environ.get("CONFORMANCE_MCP_URL", "http://fixtures:9090/mcp")


def download(target: str) -> None:
    url = f"https://github.com/jeffrschneider/OpenHarness/archive/{SPEC_COMMIT}.tar.gz"
    with urllib.request.urlopen(url, timeout=120) as response:
        archive = tarfile.open(fileobj=io.BytesIO(response.read()), mode="r:gz")
    root = archive.getmembers()[0].name.split("/")[0]
    for member in archive.getmembers():
        if member.name.startswith(f"{root}/") and ".." not in member.name:
            member.name = member.name[len(root) + 1 :]
            if member.name:
                archive.extract(member, target, filter="data")


PATCH = '''
    # OpenHarness, through its HTTP API (added by OpenHarness conformance/prepare.py).
    try:
        from openharness_openharness import OpenHarnessAdapter
        adapters.append({
            "id": "openharness",
            "name": "OpenHarness",
            "factory": lambda: OpenHarnessAdapter(),
            "capabilities": None,
        })
    except ImportError:
        pass
'''


def patch_conftest(tests: str) -> None:
    path = os.path.join(tests, "conftest.py")
    text = open(path).read()
    marker = "    adapters = []\n"
    if marker not in text:
        raise SystemExit("The conformance conftest changed; update conformance/prepare.py")
    open(path, "w").write(text.replace(marker, marker + PATCH, 1))


class Api:
    def __init__(self) -> None:
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, path: str, body: dict | None = None, method: str | None = None):
        request = urllib.request.Request(
            f"{BASE}/api{path}",
            data=None if body is None else json.dumps(body).encode(),
            method=method or ("GET" if body is None else "POST"),
            headers={"Content-Type": "application/json", "Origin": BASE},
        )
        with self.opener.open(request, timeout=60) as response:
            text = response.read().decode()
            return json.loads(text) if text else None


def setup() -> dict[str, str]:
    api = Api()
    api.call("/auth/login", ADMIN)
    providers = api.call("/providers")
    provider = next((p for p in providers if p["name"] == "Conformance model"), None) or api.call(
        "/providers",
        {"name": "Conformance model", "kind": "openai-compatible", "baseUrl": MODEL_URL, "model": "test-chat"},
    )
    connections = api.call("/connections")
    connection = next((c for c in connections if c["name"] == "Conformance tools"), None) or api.call(
        "/connections", {"name": "Conformance tools", "url": MCP_URL}
    )
    api.call(f"/connections/{connection['id']}/discover", {})
    workflows = api.call("/workflows")
    agent = next((w for w in workflows if w["name"] == "Conformance agent"), None) or api.call(
        "/workflows",
        {
            "name": "Conformance agent",
            "description": "Default agent for the Open Harness conformance suite",
            "startAt": "start",
            "nodes": [
                {"id": "start", "name": "Start", "type": "start", "next": "agent"},
                {
                    "id": "agent",
                    "name": "Assistant",
                    "type": "agent",
                    "prompt": "{{input}}",
                    "next": "finish",
                    "config": {
                        "name": "Assistant",
                        "providerId": provider["id"],
                        "systemPrompt": "You are a helpful assistant. Use your tools when asked to.",
                    },
                },
                {"id": "finish", "name": "Finish", "type": "finish", "template": "{{last}}"},
            ],
            "resources": [
                {
                    "id": "tools",
                    "name": "Conformance tools",
                    "type": "mcp",
                    "connectionId": connection["id"],
                    "tools": ["lookup", "calculate", "fail"],
                }
            ],
            "bindings": [{"agentNodeId": "agent", "resourceId": "tools"}],
        },
    )
    key = api.call("/integrations/tokens", {"name": "Conformance", "scopes": ["harness"], "expiresDays": 1})
    return {
        "OPENHARNESS_URL": f"{BASE}/openharness/v1",
        "OPENHARNESS_API_KEY": key["token"],
        "OPENHARNESS_AGENT_ID": agent["id"],
    }


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/tmp/spec"
    if sys.argv[2:3] == ["--download"]:
        download(target)
        patch_conftest(os.path.join(target, "tests", "conformance"))
    else:
        for name, value in setup().items():
            print(f"export {name}='{value}'")
