# @limitry/sdk

The official TypeScript client for the Limitry API.

```bash
npm install @limitry/sdk
```

```ts
import { createClient } from "@limitry/sdk";

// The key from LIMITRY_API_KEY, or pass { token }.
const limitry = createClient();
```

- Guide: https://limitry.com/docs/sdk/
- API reference: https://api.limitry.com/v1/docs

## Building from this repository

```bash
npm ci && npm test && npm run build
```

This repository is generated from Limitry's own repository on
each release; see CONTRIBUTING.md. Licensed under the Apache License 2.0.
