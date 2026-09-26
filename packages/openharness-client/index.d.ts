export type RequestOptions = {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};
export declare class OpenHarnessClient {
  constructor(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch });
  contract(): Promise<Record<string, any>>;
  request<T = unknown>(operationId: string, options?: RequestOptions): Promise<T | Response | undefined>;
}
export declare class OpenHarnessAdapter extends OpenHarnessClient {
  constructor(options: { baseUrl: string; apiKey: string; harnessId: string; fetch?: typeof fetch });
  readonly id: string & { readonly __brand: 'HarnessId' };
  readonly name: string;
  readonly version: string;
  readonly capabilities: {
    agents: boolean;
    skills: boolean;
    execution: boolean;
    streaming: boolean;
    sessions: boolean;
    memory: boolean;
    subagents: boolean;
    mcp: boolean;
    files: boolean;
    hooks: boolean;
    planning: boolean;
    websocket: boolean;
    multipart: boolean;
    binaryDownload: boolean;
  };
  getCapabilityManifest(): Promise<any>;
  listAgents(): Promise<any[]>;
  createAgent(request: any): Promise<any>;
  getAgent(agentId: string): Promise<any>;
  updateAgent(agentId: string, updates: any): Promise<any>;
  deleteAgent(agentId: string): Promise<void>;
  listSkills(): Promise<any[]>;
  installSkill(request: any): Promise<any>;
  getSkill(skillId: string): Promise<any>;
  uninstallSkill(skillId: string): Promise<void>;
  listSessions(): Promise<any[]>;
  createSession(request: any): Promise<any>;
  getSession(sessionId: string): Promise<any>;
  endSession(sessionId: string): Promise<void>;
  getMemory(agentId: string): Promise<any>;
  getMemoryBlock(agentId: string, label: string): Promise<any>;
  updateMemoryBlock(agentId: string, label: string, value: string): Promise<any>;
  createMemoryBlock(agentId: string, label: string, value: string): Promise<any>;
  deleteMemoryBlock(agentId: string, label: string): Promise<void>;
  listTools(): Promise<any[]>;
  invokeTool(toolId: string, input: object): Promise<object>;
  listFiles(path?: string): Promise<any[]>;
  readFile(path: string): Promise<string | ArrayBuffer>;
  writeFile(path: string, content: string | ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  execute(request: any): Promise<{
    output: string;
    toolCalls?: { id: string; name: string; input: object; output?: object; error?: string }[];
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number };
  }>;
  executeStream(request: any): AsyncGenerator<any>;
}
