# Build from the repository root:  docker build -f gateway/Dockerfile -t agentic-gateway .
FROM node:22-alpine AS build
WORKDIR /src
COPY connector-core/package.json connector-core/package-lock.json connector-core/tsconfig.json connector-core/
COPY connector-core/src connector-core/src
RUN cd connector-core && npm ci --no-audit --no-fund && npm run build
COPY gateway/package.json gateway/package-lock.json gateway/tsconfig.json gateway/
COPY gateway/src gateway/src
RUN cd gateway && npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8090
WORKDIR /opt/agentic-gateway
COPY --from=build /src/gateway/package.json gateway/
COPY --from=build /src/gateway/dist gateway/dist
COPY --from=build /src/gateway/node_modules gateway/node_modules
# The shared library is installed as a real package directory so its own imports resolve from gateway/node_modules.
RUN rm -rf gateway/node_modules/@agentic/connector-core && mkdir -p gateway/node_modules/@agentic/connector-core
COPY --from=build /src/connector-core/package.json gateway/node_modules/@agentic/connector-core/package.json
COPY --from=build /src/connector-core/dist gateway/node_modules/@agentic/connector-core/dist
RUN chown -R node:node /opt/agentic-gateway
USER node
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "gateway/dist/main.js"]
