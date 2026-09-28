# Build from the repository root:  docker build -f connector-openshell/Dockerfile -t openharness-connector-openshell .
# Run beside the OpenShell gateway, as the operator whose ~/.config/openshell holds the gateway registration:
#   docker run -d --network host -v ~/.config/openshell:/home/node/.config/openshell:ro \
#     -e GATEWAY_URL=wss://gateway.example.com/connect -e DEVICE_ID=openshell-1 -e DEVICE_TOKEN=dv_... openharness-connector-openshell
FROM node:22-alpine AS build
WORKDIR /src
COPY connector-core/package.json connector-core/package-lock.json connector-core/tsconfig.json connector-core/
COPY connector-core/src connector-core/src
RUN cd connector-core && npm ci --no-audit --no-fund && npm run build
COPY connector-openshell/package.json connector-openshell/package-lock.json connector-openshell/tsconfig.json connector-openshell/
COPY connector-openshell/src connector-openshell/src
RUN cd connector-openshell && npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine AS runtime
# The pinned OpenShell CLI release. OPENSHELL_CLI_SOURCE=none skips the download for images that mount or fake it.
ARG OPENSHELL_CLI_SOURCE=release
ARG OPENSHELL_VERSION=0.1.2
ARG OPENSHELL_SHA256_AMD64=7eb6917285331a09e3300266a0558616481a5e9927cae2612ea07c4045b6dd6f
ARG OPENSHELL_SHA256_ARM64=9880c5776688231d5242deb046cdee361734f94901b9123949a0baf29fdadd9e
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl && if [ "$OPENSHELL_CLI_SOURCE" = "release" ]; then \
      case "$TARGETARCH" in \
        amd64|"") triple=x86_64-unknown-linux-musl; sum="$OPENSHELL_SHA256_AMD64" ;; \
        arm64) triple=aarch64-unknown-linux-musl; sum="$OPENSHELL_SHA256_ARM64" ;; \
        *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
      esac; \
      curl -fsSL -o /tmp/openshell.tar.gz "https://github.com/NVIDIA/OpenShell/releases/download/v${OPENSHELL_VERSION}/openshell-${triple}.tar.gz" && \
      echo "$sum  /tmp/openshell.tar.gz" | sha256sum -c - && \
      tar -xzf /tmp/openshell.tar.gz -C /usr/local/bin openshell && rm /tmp/openshell.tar.gz && \
      /usr/local/bin/openshell --version; \
    fi
ENV NODE_ENV=production DEVICE_PLATFORM=openshell OPENSHELL_BIN=openshell LOG_LEVEL=info HOME=/home/node
WORKDIR /opt/openharness-connector
COPY --from=build /src/connector-openshell/package.json connector-openshell/
COPY --from=build /src/connector-openshell/dist connector-openshell/dist
COPY --from=build /src/connector-openshell/node_modules connector-openshell/node_modules
# The shared library is installed as a real package directory so its own imports resolve from connector-openshell/node_modules.
RUN rm -rf connector-openshell/node_modules/@openharness/connector-core && mkdir -p connector-openshell/node_modules/@openharness/connector-core
COPY --from=build /src/connector-core/package.json connector-openshell/node_modules/@openharness/connector-core/package.json
COPY --from=build /src/connector-core/dist connector-openshell/node_modules/@openharness/connector-core/dist
RUN mkdir -p /home/node/.config /home/node/.local/state && chown -R node:node /home/node /opt/openharness-connector
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/opt/openharness-connector/connector-openshell/dist/main.js"]
