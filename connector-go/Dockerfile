# Build from the repository root:
#   docker build -f connector-go/Dockerfile -t openharness-connector .              # the Linux connector / executor
#   docker build -f connector-go/Dockerfile --target edge -t openharness-edge .     # the OpenShell edge
# Run a Linux machine connector (no inbound ports; it dials out to the harness gateway):
#   docker run -d --name openharness-box-1 --restart unless-stopped \
#     -e GATEWAY_URL=wss://gateway.example.com/connect -e DEVICE_ID=box-1 -e DEVICE_TOKEN=dv_... \
#     -v "$PWD/machine-work:/work" openharness-connector
FROM golang:1.25-alpine AS build
ARG VERSION=0.2.0
WORKDIR /src
COPY connector-go/go.mod connector-go/go.sum ./
RUN go mod download
COPY connector-go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/openharness-connector ./cmd/openharness-connector \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/openharness-edge ./cmd/openharness-edge

# The edge: talks to the OpenShell gateway over gRPC and to the harness over an outbound WebSocket.
FROM alpine:3.22 AS edge
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 openharness
COPY --from=build /out/openharness-edge /usr/local/bin/openharness-edge
USER openharness
ENTRYPOINT ["/usr/local/bin/openharness-edge"]

# The connector / executor: a small Linux userland the tools can drive, a non-root user, and the two work roots
# (/work for a machine bind mount, /sandbox as the OpenShell workspace).
FROM alpine:3.22 AS connector
RUN apk add --no-cache ca-certificates coreutils findutils grep procps util-linux iproute2 curl \
 && adduser -D -u 1000 sandbox && install -d -o sandbox -g sandbox /work /sandbox
COPY --from=build /out/openharness-connector /usr/local/bin/openharness-connector
ENV WORK_DIR=/work ALLOW_COMMANDS="ls,cat,grep,find,head,tail,wc,df,du,uname,uptime,ps,env,echo,date,sh,curl" LOG_LEVEL=info
USER sandbox
WORKDIR /sandbox
ENTRYPOINT ["/usr/local/bin/openharness-connector"]
