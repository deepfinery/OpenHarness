#!/bin/sh
# Runs the Open Harness conformance suite, pinned to one upstream commit, against a running OpenHarness through
# conformance/adapter. The results go to test-results/conformance.xml. Usage: TEST_BASE_URL=... conformance/run.sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p test-results
# Deselected, with reasons (see docs/conformance.md):
# - register/unregister custom tools: OpenHarness serves external tools over MCP only, and the upstream tests call
#   the async API without awaiting it, so they fail for every adapter in the upstream results as well.
DESELECT='not test_register_custom_tool and not test_unregister_custom_tool'
docker run --rm --network host -v "$PWD":/work -w /work \
  -e TEST_BASE_URL="${TEST_BASE_URL:-http://localhost:8088}" -e SPEC_COMMIT="${SPEC_COMMIT:-}" \
  python:3.12-slim sh -c "
    set -e
    python conformance/prepare.py /tmp/spec --download
    # Installed from a copy, so the build output never lands in the repository.
    cp -r conformance/adapter /tmp/adapter
    pip install -q --disable-pip-version-check --root-user-action=ignore \
      /tmp/spec/packages/python /tmp/adapter pytest==8.3.5 pytest-asyncio==0.24.0 >/dev/null
    python conformance/prepare.py > /tmp/env
    . /tmp/env
    cd /tmp/spec
    SKIP_CONFORMANCE_TESTS=0 python -m pytest tests/conformance -q -rs -p no:cacheprovider \
      -k '$DESELECT' --junitxml /work/test-results/conformance.xml
  "
