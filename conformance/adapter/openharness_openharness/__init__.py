"""
Open Harness adapter for OpenHarness.

OpenHarness serves the Open Harness API over HTTP, so this adapter is a thin client: it maps the adapter interface
of the Open Harness Python package onto /openharness/v1 routes. Configure it with OPENHARNESS_URL (for example
http://localhost:8088/openharness/v1), OPENHARNESS_API_KEY (a workspace key, oh_sk_...) and optionally
OPENHARNESS_AGENT_ID, the agent (workflow) used when a request names none.
"""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

import httpx
from openharness.adapter import AdapterCapabilities, AdapterExecutionResult, HarnessAdapter
from openharness.types import ExecuteRequest, Tool
from openharness.types.common import UsageStats
from openharness.types.events import (
    DoneEvent,
    ErrorEvent,
    ProgressEvent,
    TextEvent,
    ThinkingEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolResultEvent,
)

__all__ = ["OpenHarnessAdapter", "OpenHarnessError"]


class OpenHarnessError(RuntimeError):
    """An error answered by the harness, with the spec's error code."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


def _error(response: httpx.Response) -> OpenHarnessError:
    try:
        body = response.json().get("error", {})
    except (ValueError, AttributeError):
        body = {}
    return OpenHarnessError(response.status_code, body.get("code", "ERROR"), body.get("message", response.text[:300]))


class OpenHarnessAdapter(HarnessAdapter):
    """Drives an OpenHarness installation through its Open Harness API."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        harness_id: str | None = None,
        default_agent_id: str | None = None,
        timeout: float = 180.0,
    ) -> None:
        base = (base_url or os.environ.get("OPENHARNESS_URL", "http://localhost:8088/openharness/v1")).rstrip("/")
        key = api_key or os.environ.get("OPENHARNESS_API_KEY", "")
        self._harness = harness_id or os.environ.get("OPENHARNESS_HARNESS_ID", "openharness")
        self._default_agent = default_agent_id or os.environ.get("OPENHARNESS_AGENT_ID") or None
        self._client = httpx.AsyncClient(
            base_url=f"{base}/harnesses/{self._harness}",
            headers={"Authorization": f"Bearer {key}"} if key else {},
            timeout=timeout,
        )

    # Identity -----------------------------------------------------------------------------------------------

    @property
    def id(self) -> str:
        return "openharness"

    @property
    def name(self) -> str:
        return "OpenHarness"

    @property
    def version(self) -> str:
        return "0.1.0"

    @property
    def capabilities(self) -> AdapterCapabilities:
        # Only what the harness serves today; the capability manifest has the details.
        return AdapterCapabilities(agents=True, execution=True, streaming=True, mcp=True, hooks=False)

    # Execution ----------------------------------------------------------------------------------------------

    def _body(self, request: ExecuteRequest) -> dict[str, Any]:
        agent = request.agent_id or self._default_agent
        body: dict[str, Any] = {"message": request.message}
        if agent:
            body["agent_id"] = agent
        for field, key in (("system_prompt", "system_prompt"), ("model", "model"), ("session_id", "session_id"),
                           ("max_tokens", "max_tokens"), ("temperature", "temperature")):
            value = getattr(request, field, None)
            if value is not None:
                body[key] = value
        return body

    async def execute_stream(self, request: ExecuteRequest, **options: Any) -> AsyncIterator[Any]:
        """Streams the spec's execution events; request errors are raised before the first event."""
        async with self._client.stream("POST", "/execute/stream", json=self._body(request)) as response:
            if response.status_code != 200:
                await response.aread()
                raise _error(response)
            event_type = "message"
            data: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].strip())
                elif not line.strip() and data:
                    payload = json.loads("\n".join(data))
                    data = []
                    event = _event(event_type, payload)
                    if event is not None:
                        yield event

    async def execute(self, request: ExecuteRequest, **options: Any) -> AdapterExecutionResult:
        if not request.message:
            # The spec requires a non-empty message; answer without calling the harness.
            return AdapterExecutionResult(output="", metadata={"error": "The Open Harness API requires a message"})
        text: list[str] = []
        calls: dict[str, dict[str, Any]] = {}
        usage: UsageStats | None = None
        failure: ErrorEvent | None = None
        async for event in self.execute_stream(request, **options):
            if event.type == "text":
                text.append(event.content)
            elif event.type == "tool_call_start":
                calls[event.id] = {"id": event.id, "name": event.name, "input": event.input}
            elif event.type == "tool_result" and event.id in calls:
                calls[event.id].update(success=event.success, output=event.output, error=event.error)
            elif event.type == "error":
                failure = event
            elif event.type == "done":
                usage = event.usage
        if failure is not None:
            raise OpenHarnessError(500, failure.code, failure.message)
        return AdapterExecutionResult(output="".join(text), tool_calls=list(calls.values()), usage=usage)

    # Agents -------------------------------------------------------------------------------------------------

    async def create_agent(self, config: dict[str, Any]) -> str:
        name = str(config.get("name") or "Agent")
        prompt = str(config.get("system_prompt") or f"You are {name}.")
        response = await self._client.post(
            "/agents",
            json={
                "metadata": {"name": name, "description": str(config.get("description") or "")},
                "files": [{"path": "AGENTS.md", "content": f"---\nname: {json.dumps(name)}\n---\n\n{prompt}\n"}],
            },
        )
        if response.status_code != 201:
            raise _error(response)
        return response.json()["agent"]["id"]

    async def get_agent(self, agent_id: str) -> dict[str, Any]:
        response = await self._client.get(f"/agents/{agent_id}")
        if response.status_code != 200:
            raise _error(response)
        return response.json()["agent"]

    async def list_agents(self) -> list[dict[str, Any]]:
        agents: list[dict[str, Any]] = []
        offset = 0
        while True:
            response = await self._client.get("/agents", params={"limit": 100, "offset": offset})
            if response.status_code != 200:
                raise _error(response)
            page = response.json()
            agents.extend(page["data"])
            if not page["has_more"]:
                return agents
            offset += page["limit"]

    async def delete_agent(self, agent_id: str) -> None:
        response = await self._client.delete(f"/agents/{agent_id}")
        if response.status_code not in (204, 404):
            raise _error(response)

    # Tools --------------------------------------------------------------------------------------------------

    async def list_tools(self) -> list[Tool]:
        response = await self._client.get("/tools", params={"limit": 100})
        if response.status_code != 200:
            raise _error(response)
        return [
            Tool(
                id=t["id"],
                name=t["name"],
                description=t.get("description") or t["name"],
                source=t["source"],
                input_schema=t.get("input_schema") or {"type": "object"},
                mcp_server_id=t.get("source_id"),
            )
            for t in response.json()["data"]
        ]

    async def invoke_tool(self, tool_id: str, input_data: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(f"/tools/{tool_id}/invoke", json={"input": input_data})
        if response.status_code != 200:
            raise _error(response)
        return response.json()

    async def close(self) -> None:
        await self._client.aclose()


def _event(kind: str, data: dict[str, Any]) -> Any:
    """Maps a spec SSE event onto the Python package's event models."""
    if kind == "text":
        return TextEvent(content=data.get("content", ""))
    if kind == "thinking":
        return ThinkingEvent(thinking=data.get("content", ""))
    if kind == "tool_call_start":
        return ToolCallStartEvent(id=data["id"], name=data["name"], input=data.get("input") or {})
    if kind == "tool_call_end":
        return ToolCallEndEvent(id=data["id"])
    if kind == "tool_result":
        output = data.get("output")
        success = bool(data.get("success"))
        error = None if success else str((output or {}).get("content") or "The tool failed")
        return ToolResultEvent(id=data["id"], success=success, output=output, error=error)
    if kind == "progress":
        return ProgressEvent(
            percentage=float(data.get("percentage", 0)),
            step=data.get("step"),
            step_number=data.get("step_number"),
            total_steps=data.get("total_steps"),
        )
    if kind == "error":
        return ErrorEvent(code=data.get("code", "ERROR"), message=data.get("message", ""), recoverable=bool(data.get("recoverable")))
    if kind == "done":
        usage = data.get("usage")
        return DoneEvent(usage=UsageStats(**usage) if usage else None)
    return None
