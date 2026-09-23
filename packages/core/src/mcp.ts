import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { collection } from './db.js';
import { config } from './config.js';
import { decrypt, encrypt, hash, HttpError, randomToken, safeFetch, validateRemoteUrl } from './security.js';
import type { McpConnection, Stored } from './schema.js';

export type ConnectionRecord = Stored<McpConnection> & {
  tokenEncrypted?: string;
  clientSecretEncrypted?: string;
  oauthClientEncrypted?: string;
  oauthTokensEncrypted?: string;
  tools?: Tool[];
  lastCheckedAt?: Date;
};
type OAuthState = {
  _id: string;
  ownerId: string;
  connectionId: string;
  sessionHash: string;
  verifier?: string;
  expiresAt: Date;
};
const connections = () => collection<ConnectionRecord>('connections');
const states = () => collection<OAuthState>('oauth_states');

export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  constructor(
    private connection: ConnectionRecord,
    private flow?: { state: string; verifier?: string },
  ) {}
  get redirectUrl() {
    return `${config.PUBLIC_URL.replace(/\/$/, '')}/api/mcp/oauth/callback`;
  }
  get clientMetadata() {
    return {
      client_name: 'Agentic Orchestration',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.connection.clientSecretEncrypted ? 'client_secret_post' : 'none',
      ...(this.connection.oauthScope ? { scope: this.connection.oauthScope } : {}),
    };
  }
  state() {
    if (!this.flow) throw new HttpError(409, 'Reconnect this MCP server in the studio');
    return this.flow.state;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.connection.oauthClientId)
      return {
        client_id: this.connection.oauthClientId,
        ...(this.connection.clientSecretEncrypted
          ? { client_secret: decrypt(this.connection.clientSecretEncrypted) }
          : {}),
      };
    return this.connection.oauthClientEncrypted
      ? JSON.parse(decrypt(this.connection.oauthClientEncrypted))
      : undefined;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    await this.save('oauthClientEncrypted', encrypt(JSON.stringify(info)));
  }
  tokens(): OAuthTokens | undefined {
    return this.connection.oauthTokensEncrypted
      ? JSON.parse(decrypt(this.connection.oauthTokensEncrypted))
      : undefined;
  }
  async saveTokens(tokens: OAuthTokens) {
    const previous = this.tokens();
    await this.save(
      'oauthTokensEncrypted',
      encrypt(JSON.stringify({ ...tokens, refresh_token: tokens.refresh_token ?? previous?.refresh_token })),
    );
  }
  async redirectToAuthorization(url: URL) {
    if (!this.flow)
      throw new HttpError(409, 'MCP authorization expired. Reconnect this server in the studio.');
    await validateRemoteUrl(url.toString());
    this.authorizationUrl = url.toString();
  }
  async saveCodeVerifier(verifier: string) {
    if (!this.flow) throw new Error('No active authorization flow');
    this.flow.verifier = verifier;
    await states().updateOne({ _id: hash(this.flow.state) }, { $set: { verifier: encrypt(verifier) } });
  }
  codeVerifier() {
    if (!this.flow?.verifier) throw new Error('Authorization expired. Start again.');
    return this.flow.verifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') await this.save('oauthTokensEncrypted', '');
    if (scope === 'all' || scope === 'client') await this.save('oauthClientEncrypted', '');
  }
  private async save(field: 'oauthClientEncrypted' | 'oauthTokensEncrypted', value: string) {
    this.connection[field] = value;
    await connections().updateOne(
      { _id: this.connection._id, ownerId: this.connection.ownerId },
      { $set: { [field]: value } },
    );
  }
}

export async function startOAuth(ownerId: string, connectionId: string, sessionHash: string) {
  const connection = await ownedConnection(ownerId, connectionId);
  if (connection.authType !== 'oauth') throw new HttpError(400, 'This connection does not use OAuth');
  const state = randomToken();
  await states().insertOne({
    _id: hash(state),
    ownerId,
    connectionId,
    sessionHash,
    expiresAt: new Date(Date.now() + 600000),
  });
  const provider = new StoredOAuthProvider(connection, { state });
  try {
    const result = await auth(provider, {
      serverUrl: connection.url,
      scope: connection.oauthScope || undefined,
      fetchFn: safeFetch,
    });
    if (result === 'AUTHORIZED') {
      await states().deleteOne({ _id: hash(state) });
      return { authorized: true };
    }
    return { authorizationUrl: provider.authorizationUrl };
  } catch (error) {
    await states().deleteOne({ _id: hash(state) });
    throw error;
  }
}
export async function finishOAuth(state: string, code: string, ownerId: string, sessionHash: string) {
  const flow = await states().findOneAndDelete({
    _id: hash(state),
    ownerId,
    sessionHash,
    expiresAt: { $gt: new Date() },
  });
  if (!flow?.verifier) throw new HttpError(400, 'Authorization state expired or does not match your session');
  const connection = await ownedConnection(ownerId, flow.connectionId);
  const provider = new StoredOAuthProvider(connection, { state, verifier: decrypt(flow.verifier) });
  const result = await auth(provider, {
    serverUrl: connection.url,
    authorizationCode: code,
    fetchFn: safeFetch,
  });
  if (result !== 'AUTHORIZED') throw new HttpError(400, 'MCP authorization was not completed');
}
export async function ownedConnection(ownerId: string, id: string) {
  const connection = await connections().findOne({ _id: id, ownerId });
  if (!connection || !connection.enabled) throw new HttpError(404, 'MCP connection unavailable');
  return connection;
}
export async function connectMcp(connection: ConnectionRecord, signal?: AbortSignal) {
  await validateRemoteUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.authType === 'token') {
    const token = decrypt(connection.tokenEncrypted);
    if (!token) throw new HttpError(400, 'An MCP access token is required');
    headers[connection.tokenHeader] = connection.tokenHeader === 'Authorization' ? `Bearer ${token}` : token;
  }
  const authProvider = connection.authType === 'oauth' ? new StoredOAuthProvider(connection) : undefined;
  const guardedFetch: typeof fetch = (input, init) =>
    safeFetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(60000)]) : init?.signal,
    });
  const options = { authProvider, requestInit: { headers }, fetch: guardedFetch };
  const transport =
    connection.transport === 'sse'
      ? new SSEClientTransport(new URL(connection.url), options)
      : new StreamableHTTPClientTransport(new URL(connection.url), options);
  const client = new Client({ name: 'agentic-orchestration', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30000, signal });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    client,
    async close() {
      // Closing is bounded by the fetch deadline; tool calls are never replayed here.
      await client.close().catch(() => {});
    },
    async tools(): Promise<Tool[]> {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 30000 });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) return tools;
      }
      throw new Error('MCP tool listing exceeded 20 pages');
    },
  };
}
export async function discoverTools(ownerId: string, id: string) {
  const connection = await ownedConnection(ownerId, id);
  const session = await connectMcp(connection);
  try {
    const tools = await session.tools();
    await connections().updateOne({ _id: id, ownerId }, { $set: { tools, lastCheckedAt: new Date() } });
    return tools;
  } finally {
    await session.close();
  }
}
export const toolAlias = (connectionId: string, toolName: string) =>
  `mcp_${hash(`${connectionId}:${toolName}`).slice(0, 24)}`;
