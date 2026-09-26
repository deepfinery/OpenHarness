# OpenHarness HTTP client and adapter

Dependency-free JavaScript with TypeScript declarations, for Node.js 22+ and modern browsers. The generic client reads the server's OpenAPI document, so every advertised HTTP operation is accessible without a separate endpoint catalog. The `OpenHarnessAdapter` convenience methods match the upstream TypeScript `HarnessAdapter` interface.

```js
import { OpenHarnessClient, OpenHarnessAdapter } from './index.js';
const client = new OpenHarnessClient({ baseUrl: process.env.OH_URL, apiKey: process.env.OH_KEY });
const harnesses = await client.request('harnesses.list');
const harnessId = harnesses.data[0].id;
const adapter = new OpenHarnessAdapter({
  baseUrl: process.env.OH_URL,
  apiKey: process.env.OH_KEY,
  harnessId,
});
const result = await adapter.execute({ message: 'Hello' });
console.log(result.output);
```

`request(operationId, {path, query, body, headers, signal})` returns JSON, `undefined` for 204, or a streaming `Response` for SSE/binary data. Use `FormData` for multipart operations. Errors expose `status`, `code` and `details`. Inspect `getCapabilityManifest()` for runtime limitations. WebSockets require a WebSocket client at the returned session `connect_url`, with bearer authentication or a same-origin studio cookie; never put API keys into URL query parameters.
