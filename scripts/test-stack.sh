#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
./start.sh --configure-only
export TEST_COMPOSE_PROJECT="agentic-test-$$"
export STUDIO_PORT="${TEST_PORT:-18088}"
export PUBLIC_URL="http://localhost:$STUDIO_PORT"
export TEST_BASE_URL="$PUBLIC_URL"
export TEST_FAULT_INJECTION=true
compose() { docker compose -p "$TEST_COMPOSE_PROJECT" -f compose.yaml -f tests/compose.test.yaml "$@"; }
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then compose logs --tail=80 api runner fixtures; fi
  compose down -v --remove-orphans
  exit "$result"
}
trap cleanup EXIT
compose up --build -d --wait --wait-timeout 240
npm test
npm run test:integration
if [ "${BROWSER_TESTS:-0}" = '1' ]; then
  npm run test:browser
elif [ "${BROWSER_TESTS:-0}" = 'container' ]; then
  browser_version="$(node -p 'require("@playwright/test/package.json").version')"
  docker run --rm --network host --ipc=host --user "$(id -u):$(id -g)" \
    -e TEST_BASE_URL -e TEST_FIXTURE_URL -v "$PWD:/work" -w /work \
    "mcr.microsoft.com/playwright:v${browser_version}-noble" \
    node node_modules/@playwright/test/cli.js test
fi
