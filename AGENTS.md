# Working in this standalone project

- Keep all source, configuration, dependencies, and deployment assets within
  this repository. Builds must work from a fresh clone without sibling projects.
- All external agent tools use MCP. Do not introduce provider-specific connector
  catalogs, federated UI login, or business/customer/billing features.
- Use Node.js 22 or later. Run type checks, unit tests, and the relevant real-stack
  integration tests when changing execution, authentication or storage behavior.
- Use the isolated test Compose project for fault injection. Never stop, modify,
  or reuse unrelated containers or volumes.
