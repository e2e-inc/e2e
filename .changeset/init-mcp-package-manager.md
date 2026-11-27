---
'e2e': patch
---

`e2e init` now registers the MCP server with the project's own package manager: `pnpm exec e2e mcp` in a pnpm project and `yarn exec e2e mcp` in a Yarn one (`yarn --silent exec -- e2e mcp` on Yarn 1), where it wrote `npx e2e mcp` before. `npx` exits with `EBADDEVENGINES` before the MCP handshake when the project's `devEngines` pins another manager, and the client showed only `Connection closed`. Run `e2e init` again to update an existing entry.
