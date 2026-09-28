# The OpenShell connector with the CLI test double in place of the real OpenShell 0.1.2 binary.
# Build the base first:  docker build -f connector-openshell/Dockerfile --build-arg OPENSHELL_CLI_SOURCE=none -t openharness-connector-openshell-base:local .
FROM openharness-connector-openshell-base:local
USER root
COPY tests/fixtures/openshell-fake /opt/openshell-fake
RUN chmod 755 /opt/openshell-fake/openshell && chown -R node:node /opt/openshell-fake
ENV OPENSHELL_BIN=/opt/openshell-fake/openshell OPENSHELL_FAKE_STATE=/home/node/.local/state/openshell-fake.json
USER node
