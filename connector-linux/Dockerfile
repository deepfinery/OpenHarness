# Build from the repository root:  docker build -f connector-linux/Dockerfile -t agentic-connector-linux .
# Run:  docker run -d -e GATEWAY_URL=wss://gateway.example.com/connect -e DEVICE_ID=box-1 -e DEVICE_TOKEN=dv_... agentic-connector-linux
FROM node:22-alpine AS build
WORKDIR /src
COPY connector-core/package.json connector-core/package-lock.json connector-core/tsconfig.json connector-core/
COPY connector-core/src connector-core/src
RUN cd connector-core && npm ci --no-audit --no-fund && npm run build
COPY connector-linux/package.json connector-linux/package-lock.json connector-linux/tsconfig.json connector-linux/
COPY connector-linux/src connector-linux/src
RUN cd connector-linux && npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
RUN apk add --no-cache coreutils findutils grep procps
ENV NODE_ENV=production DEVICE_PLATFORM=linux WORK_DIR=/work ALLOW_COMMANDS="ls,cat,grep,find,head,tail,wc,df,du,uname,uptime,ps,env,echo,date,sh" LOG_LEVEL=info
WORKDIR /opt/agentic-connector
COPY --from=build /src/connector-linux/package.json connector-linux/
COPY --from=build /src/connector-linux/dist connector-linux/dist
COPY --from=build /src/connector-linux/node_modules connector-linux/node_modules
# The shared library is installed as a real package directory so its own imports resolve from connector-linux/node_modules.
RUN rm -rf connector-linux/node_modules/@agentic/connector-core && mkdir -p connector-linux/node_modules/@agentic/connector-core
COPY --from=build /src/connector-core/package.json connector-linux/node_modules/@agentic/connector-core/package.json
COPY --from=build /src/connector-core/dist connector-linux/node_modules/@agentic/connector-core/dist
RUN mkdir -p /work && chown -R node:node /work /opt/agentic-connector
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/agentic-connector/connector-linux/dist/main.js"]
