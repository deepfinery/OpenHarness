FROM node:22-bookworm-slim AS node
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl passwd util-linux procps libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
WORKDIR /app
COPY connector-core ./connector-core
COPY connector-linux ./connector-linux
RUN npm --prefix connector-core ci && npm --prefix connector-core run build && npm --prefix connector-linux ci && npm --prefix connector-linux run build
# The fixture supervises the real connector process as the real service user, without a host systemd/cgroup mount.
COPY tests/fixtures/installer-systemctl /usr/local/bin/systemctl
COPY tests/fixtures/installer-tls.mjs /app/installer-tls.mjs
RUN chmod 755 /usr/local/bin/systemctl && mkdir -p /etc/systemd/system /test-tls
ENV NODE_EXTRA_CA_CERTS=/test-tls/cert.pem
CMD ["sh", "-c", "openssl req -x509 -newkey rsa:2048 -nodes -keyout /test-tls/key.pem -out /test-tls/cert.pem -days 2 -subj /CN=installer -addext subjectAltName=DNS:installer >/dev/null 2>&1 && exec node /app/installer-tls.mjs"]
