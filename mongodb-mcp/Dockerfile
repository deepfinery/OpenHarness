# Build from the repository root:  docker build -f mongodb-mcp/Dockerfile -t openharness-mongodb-mcp .
# The official MongoDB MCP server, pinned by mongodb-mcp/package-lock.json, served over streamable HTTP.
FROM node:22-alpine AS build
WORKDIR /opt/mongodb-mcp
COPY mongodb-mcp/package.json mongodb-mcp/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    HOME=/tmp \
    MDB_MCP_TRANSPORT=http \
    MDB_MCP_HTTP_HOST=0.0.0.0 \
    MDB_MCP_DANGEROUS_HOST_BINDING=true \
    MDB_MCP_HTTP_PORT=3000 \
    MDB_MCP_HTTP_RESPONSE_TYPE=json \
    MDB_MCP_HTTP_BODY_LIMIT=16777216 \
    MDB_MCP_MONITORING_SERVER_HOST=0.0.0.0 \
    MDB_MCP_MONITORING_SERVER_PORT=3001 \
    MDB_MCP_TELEMETRY=disabled \
    MDB_MCP_LOGGERS=stderr \
    MDB_MCP_DISABLED_TOOLS=atlas,atlasLocal,connect,disconnect,list-connections,list-databases,aggregate-db,drop-database,mongodb-logs,export,search-knowledge,list-knowledge-sources
# Tools that reach beyond one database (listing or dropping databases, server logs, Atlas, new connections, file
# exports, the hosted knowledge search) stay disabled: OpenHarness pins every call to a workspace database.
# It listens on all interfaces only so other containers can reach it: deployments never publish its port, and every
# request must carry the bearer token in MDB_MCP_HTTP_HEADERS, which only OpenHarness holds.
# MDB_MCP_CONNECTION_STRING and MDB_MCP_HTTP_HEADERS ({"authorization":"Bearer <token>"}) come from the deployment.
WORKDIR /opt/mongodb-mcp
COPY --from=build /opt/mongodb-mcp/node_modules node_modules
COPY mongodb-mcp/package.json ./
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/mongodb-mcp-server/dist/index.js"]
