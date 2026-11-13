# n8n-nodes-billos

BillOS for [n8n](https://n8n.io): issue Israeli tax invoices and receipts, numbered and digitally signed in a registered ledger (Israel Tax Authority software registry, certificate 269101), and start workflows on what happens in the books.

## Nodes

**BillOS** (action)

- Create Document: a tax invoice, invoice-receipt, receipt or proforma, issued (or left as a draft), with its public PDF link. Optionally emails the customer. A reference field makes a re-run return the same document instead of numbering a second one.
- Get Document, Get PDF Link, Search Documents (by number or customer name).

**BillOS Trigger** (webhook)

Document issued, PDF ready, invoice paid, allocation number assigned, expense recorded, quote sent, accepted or declined, recurring document ran, export completed, business status changed. Deliveries are checked against the endpoint's signing secret.

## Credentials

- **BillOS API**: an API key from the [BillOS console](https://dash.billos.co.il). A `bk_test_` key works against the free sandbox, a `bk_live_` key against the real ledger. A key reaches the businesses it opened, which is the platform shape.
- **BillOS OAuth2 API**: BillOS Connect, for a business owner's own n8n. Register a Connect app in the console (מפתחים → אפליקציות Connect) with this credential's OAuth Redirect URL, then paste its client id and secret. A sandbox app works at once; a live app is approved by BillOS first.

Amounts are entered in shekels. An invoice-receipt with a price before VAT is sent VAT-inclusive at the business's own rate, so its payment always equals the ledger's total.

## Development

```bash
npm install
npm run build
npm run lint      # n8n's community-node linter
npm test          # needs the monorepo's local Postgres and .env
```

The tests run the compiled nodes against the real BillOS ledger and OAuth routers through a small stand-in for n8n's execution context.

## Publishing

The public repository is `github.com/billos-dev/n8n-nodes-billos`, a copy of this folder pushed by `node integrations/publish-n8n-repo.mjs` from the monorepo (never edited there by hand). n8n verifies a community node only from a public repository that matches its npm package, published from GitHub Actions with provenance, so npm is reached through that repository's own workflow, never from a laptop.

1. `node integrations/publish-n8n-repo.mjs "what changed"` pushes this folder to the public repository's `main`.
2. **The first version, by the npm account's owner.** npm's Trusted Publisher is set in the settings of a package that exists, and for a name never published that screen answers Not Found (read on npmjs.com, 2026-11-13). A token cannot publish directly either: the account has 2FA, and the first run answered `EOTP`. So the first version is **staged**: on npmjs.com, Access Tokens, a granular token with "Read and write (publish and stage)" and the shortest expiry offered; in the public repository, Settings, Secrets and variables, Actions, `NPM_TOKEN`. While the secret is there the workflow runs `npm stage publish --provenance`, which asks for no one-time password and creates a package that does not exist yet (npm shows a placeholder `0.0.0-stage` until the approval).
3. `node integrations/publish-n8n-repo.mjs --tag` tags `v<version>` there, and the workflow runs `npm ci`, the build, n8n's linter and the staging. To repeat a run without moving a tag: `gh workflow run publish.yml -R billos-dev/n8n-nodes-billos`. Then the owner approves the version on npmjs.com under **Staged Packages** (it asks for 2FA). A version once published is permanent: raise `version` in `package.json` for every release.
4. **Right after the first version:** check that the package's page shows its provenance (n8n requires it of every version, and npm's documentation does not say what a staged version keeps). Then on npmjs.com, Packages, `n8n-nodes-billos`, Settings, Trusted Publisher, GitHub Actions: organization `billos-dev`, repository `n8n-nodes-billos`, workflow filename `publish.yml`. Delete the `NPM_TOKEN` secret and revoke the token, so no npm token lives anywhere; from then on the workflow publishes directly. `repository.url` in `package.json` must name that repository exactly.
5. Submit for verification at https://creators.n8n.io/nodes. n8n checks: no runtime dependencies (there are none), no environment or file-system access, and `npx @n8n/scan-community-package n8n-nodes-billos` passing, which can only run once the package is on npm.

`package-lock.json` must be in step with `package.json`, or the workflow's `npm ci` stops before anything is built: after changing a dependency run `npm install` here and commit the lock file.

## License

MIT
