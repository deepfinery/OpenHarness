# MongoDB collections

**Knowledge** has two tabs. **Documents** holds knowledge bases: notes and files indexed in the vector store and retrieved by meaning. **Collections** holds MongoDB collections: JSON records that people and agents create, query, edit and delete through the [MongoDB MCP server](https://github.com/mongodb-js/mongodb-mcp-server).

## Connect

Open **Knowledge → Collections → Connect MongoDB**, or add a connection under **MCP connections** with server type **MongoDB**:

- **This installation's MongoDB** (default when available): the stack runs the official MongoDB MCP server (`mongodb-mcp`) on top of its own MongoDB. Each workspace gets its own database (`oh_ws_…`); the address, token and database come from the installation and are never stored with the connection.
- **Another MongoDB MCP server**: any MongoDB MCP server you run over streamable HTTP (for example `mongodb-mcp-server --transport http`), with the database every call should use.

Saving discovers the tools. Add them to an agent like any MCP tools.

## Use the Collections tab

- **New collection…** creates a collection.
- **Insert JSON** takes one object or an array (paste it or load a `.json` file). Values that are not objects are stored as `{ "value": … }`. Extended JSON such as `{ "$date": "2026-01-01T00:00:00Z" }` is understood.
- **Filter** and **Sort** take MongoDB JSON (`{ "status": "open" }`, `{ "createdAt": -1 }`); results page 25 at a time.
- Open a record to **edit** it (saving replaces it: removed fields are deleted, the `_id` stays) or **delete** it.
- **Indexes** adds ascending, descending or text indexes on a field. A text index lets agents search words with `{ "$text": { "$search": "…" } }`.
- The bin on a collection card drops the collection.

Every action is a MongoDB MCP tool call through the connection, so the tab shows exactly what agents see.

## Agents

Agents get the connection's tools: `find`, `aggregate`, `count`, `insert-many`, `update-many`, `delete-many`, `create-collection`, `drop-collection`, `rename-collection`, `create-index`, `drop-index`, `collection-indexes`, `collection-schema`, `collection-storage-size`, `db-stats` and `explain`. They never choose the database: OpenHarness removes `database` and `connectionId` from each tool's schema and sets them on every call, from agents, workflow tool steps and the studio alike. Aggregation stages that name another database (`$out`, `$merge`, `$lookup` with `{ db, coll }`) are refused.

## Isolation and security

- The MongoDB MCP server is internal: no published port or public route, and every request needs a bearer token that only OpenHarness holds (`MONGODB_MCP_TOKEN`).
- It connects as its own MongoDB user (`openharness_mcp`), which the API creates at startup with the administrator connection. The user starts with no roles; connecting a workspace grants `readWrite` (and index statistics) on that workspace's database only. It can never read the application database (`agentic`), the gateway database, or the admin database.
- Tools that reach beyond one database are disabled in the server: listing or dropping databases, server logs, new connections, Atlas, file exports and the hosted knowledge search.
- Workspaces cannot use each other's connections, and each built-in connection is pinned to its own workspace database.

## Operations

| Variable               | Where            | Purpose                                                                                  |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `MONGODB_MCP_URL`      | API, runner      | The internal server (`http://mongodb-mcp:3000/mcp`). Empty disables the built-in option. |
| `MONGODB_MCP_TOKEN`    | API, runner, MCP | Bearer token the server requires (`MDB_MCP_HTTP_HEADERS` on the server).                 |
| `MONGODB_MCP_PASSWORD` | API, runner, MCP | Password of the `openharness_mcp` MongoDB user (in `MDB_MCP_CONNECTION_STRING`).         |

`./start.sh --configure-only` appends the token and password to an existing `.env`; `deploy/k8s/scripts/prepare.sh` adds them to an existing `openharness-secrets` Secret without rotating other keys. The server image is built from `mongodb-mcp/` (`mongodb-mcp-server` pinned by its lockfile). Collections live in the stack MongoDB, so they are included in MongoDB backups; on Nebius the MongoDB volume is 1 TiB (see [deploy/k8s/README.md](../deploy/k8s/README.md#growing-a-volume)).
