# Working in this standalone project

- For every feature or issue implementation, create a GitHub issue first, work
  on a dedicated fix/feature branch, open a PR linked with `Closes #<issue>`,
  run the required checks, and merge the completed PR to main. Merge closes the
  PR and its linked issue; do not close an unmerged PR as a substitute.

- Keep all source, configuration, dependencies, and deployment assets within
  this repository. Builds must work from a fresh clone without sibling projects.
- All external agent tools use MCP. Do not introduce provider-specific connector
  catalogs, federated UI login, or business/customer/billing features.
- Use Node.js 22 or later. Run type checks, unit tests, and the relevant real-stack
  integration tests when changing execution, authentication or storage behavior.
- Use the isolated test Compose project for fault injection. Never stop, modify,
  or reuse unrelated containers or volumes.
