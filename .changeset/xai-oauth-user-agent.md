---
'e2e': patch
---

`e2e login` and the token refresh of a subscription login now send `User-Agent: e2e/<version> (<platform>; <arch>)` to the provider's sign-in server, as model requests already do. They used to send the runtime's default, `node`.
