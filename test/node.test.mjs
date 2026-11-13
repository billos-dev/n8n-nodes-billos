// The compiled n8n nodes against the REAL BillOS ledger and OAuth routers on a loopback port.
// n8n's own runtime is not installed (it is the size of n8n); a small stand-in for its
// execution context makes the same authenticated HTTP calls n8n would, so every request the
// nodes send meets the real server. Covers both credentials: an API key, and a Connect token
// on the trigger (the shape a business owner's own n8n uses).
// Needs the local dev Postgres (pnpm db:up) and the repo's .env.
//   run: cd integrations/n8n && npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
process.loadEnvFile(path.join(repo, '.env'))
process.env.BOOKS_API_RATE_PER_MIN = '600'
process.env.BOOKS_AUTH_FAILS_PER_WINDOW = '500'
process.env.BOOKS_WEBHOOKS_ENABLED = '0'
process.env.BILLOS_CONSOLE_URL = 'https://dash.test'

const { default: express } = await import(path.join(repo, 'node_modules/express/index.js'))
const books = await import(path.join(repo, 'packages/books/index.js'))
const { getPrisma } = await import(path.join(repo, 'packages/books/src/db.js'))
const { freshClient, BUSINESS } = await import(path.join(repo, 'packages/books/test/_harness.js'))
books.initBooks({})
const prisma = getPrisma()
const principals = new Map()
const session = async (_req, bearer) => principals.get(bearer) || null
const server = express().use('/v1', books.createBooksRouter({ session })).use('/oauth', books.createOAuthRouter({ session })).listen(0)
await new Promise((resolve) => server.on('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); prisma.$disconnect() })

const require = createRequire(import.meta.url)
const { Billos } = require('../dist/nodes/Billos/Billos.node.js')
const { BillosTrigger } = require('../dist/nodes/Billos/BillosTrigger.node.js')
const GF = require('../dist/nodes/Billos/GenericFunctions.js')

// ── The stand-in for n8n's context ──
const { raw: K } = await freshClient(prisma)
const credentials = { billosApi: { apiKey: K, baseUrl: `${origin}/v1` }, billosOAuth2Api: { accessToken: null } }
async function httpRequestWithAuthentication(type, options) {
  // The OAuth2 credential has no base URL field; the nodes send it to production, which in
  // this test is the loopback server.
  const url = options.url.replace(GF.API_BASE, `${origin}/v1`)
  const auth = type === 'billosApi' ? { 'X-Api-Key': credentials.billosApi.apiKey } : { authorization: `Bearer ${credentials.billosOAuth2Api.accessToken}` }
  const qs = options.qs ? '?' + new URLSearchParams(Object.entries(options.qs).map(([k, v]) => [k, String(v)])).toString() : ''
  const r = await fetch(url + qs, { method: options.method, headers: { 'content-type': 'application/json', ...auth, ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined })
  const body = await r.json().catch(() => ({}))
  if (r.status >= 400) throw Object.assign(new Error(`BillOS ${r.status}: ${body.error || ''}`), { httpCode: String(r.status), body })
  return body
}
function ctx(params, { items = [{ json: {} }], staticData = {}, webhookUrl = 'https://n8n.example/webhook/abc', request = null, responses = [] } = {}) {
  return {
    getInputData: () => items,
    getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
    getCredentials: async (type) => credentials[type],
    getNode: () => ({ name: 'BillOS', type: 'n8n-nodes-billos.billos' }),
    continueOnFail: () => false,
    getNodeWebhookUrl: () => webhookUrl,
    getWorkflowStaticData: () => staticData,
    getRequestObject: () => request,
    getBodyData: () => request?.body,
    getResponseObject: () => ({ status(code) { responses.push(code); return { send: (b) => responses.push(b) } } }),
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    helpers: { httpRequestWithAuthentication, returnJsonArray: (a) => a.map((json) => ({ json })) },
  }
}
const run = async (params) => (await new Billos().execute.call(ctx(params)))[0].map((x) => x.json)

// A business the key opened, as a platform would.
const created = await httpRequestWithAuthentication('billosApi', { method: 'POST', url: `${GF.API_BASE}/businesses`, body: { ...BUSINESS, name: 'n8n test' } })
const BID = created.business.id

test('the business list feeds the Business field', async () => {
  const list = await GF.getBusinesses.call(ctx({ authentication: 'apiKey' }))
  assert.ok(list.some((o) => o.value === BID))
})

let issued
test('Create Document: invoice-receipt, net price with VAT on top, receipt, draft, and a reference that never numbers twice', async () => {
  const base = { authentication: 'apiKey', operation: 'create', businessId: BID, quantity: 1, issue: true }
  ;[issued] = await run({ ...base, docType: 320, description: 'ייעוץ', unitPrice: 354, priceIncludesVat: true, paymentMethod: 'card', additionalFields: { customerName: 'דנה לוי', externalRef: `n8n-${Date.now()}` } })
  assert.equal(issued.status, 'issued')
  assert.equal(issued.total, 354)
  assert.match(issued.pdfUrl, /\/api\/docs\/.+\/d\.pdf$/)
  const [net] = await run({ ...base, docType: 320, description: 'שירות', unitPrice: 100, quantity: 2, priceIncludesVat: false, paymentMethod: 'transfer', additionalFields: { customerName: 'חברה' } })
  assert.equal(net.total, 236)
  const [rcpt] = await run({ ...base, docType: 400, description: 'מקדמה', unitPrice: 500, paymentMethod: 'bit', additionalFields: {} })
  assert.equal(rcpt.total, 500)
  const [draft] = await run({ ...base, docType: 305, description: 'טיוטה', unitPrice: 100, issue: false, additionalFields: { customerName: 'לקוח' } })
  assert.equal(draft.status, 'draft')
  assert.equal(draft.pdfUrl, null)
  const ref = `n8n-dup-${Date.now()}`
  const [a] = await run({ ...base, docType: 320, description: 'x', unitPrice: 50, paymentMethod: 'cash', additionalFields: { externalRef: ref } })
  const [b] = await run({ ...base, docType: 320, description: 'x', unitPrice: 50, paymentMethod: 'cash', additionalFields: { externalRef: ref } })
  assert.equal(b.id, a.id)
  assert.equal(b.deduped, true)
})

test('Get Document, Get PDF Link and Search Documents', async () => {
  const [got] = await run({ authentication: 'apiKey', operation: 'get', businessId: BID, documentId: issued.id })
  assert.equal(got.docNumber, issued.docNumber)
  const [link] = await run({ authentication: 'apiKey', operation: 'getPdfLink', businessId: BID, documentId: issued.id })
  assert.equal(link.variant, 'copy')
  const found = await run({ authentication: 'apiKey', operation: 'search', businessId: BID, query: String(issued.docNumber), searchDocType: 320, limit: 5 })
  assert.ok(found.some((d) => d.id === issued.id))
})

test('the trigger with an API key: activate, find itself again, a signed delivery, a forged one, deactivate', async () => {
  const staticData = {}
  const params = { authentication: 'apiKey', businessId: BID, events: ['document.issued', 'quote.accepted'] }
  const hooks = new BillosTrigger().webhookMethods.default
  assert.equal(await hooks.checkExists.call(ctx(params, { staticData, webhookUrl: 'https://n8n.example/webhook/k1' })), false)
  assert.equal(await hooks.create.call(ctx(params, { staticData, webhookUrl: 'https://n8n.example/webhook/k1' })), true)
  const row = await prisma.bkWebhookEndpoint.findUnique({ where: { id: staticData.webhookId } })
  assert.equal(row.businessId, BID)
  assert.deepEqual(row.events, ['document.issued', 'quote.accepted'])
  const again = {}
  assert.equal(await hooks.checkExists.call(ctx(params, { staticData: again, webhookUrl: 'https://n8n.example/webhook/k1' })), true, 'a restart finds its endpoint by URL')
  assert.equal(again.webhookId, staticData.webhookId)

  const envelope = { id: 'del_1', eventId: 'evt_1', event: 'document.issued', mode: 'live', businessId: BID, createdAt: new Date().toISOString(), data: { documentId: issued.id, docType: 320, docNumber: issued.docNumber, totalIncVat: 35400, vatAmount: 5400, currency: 'ILS' } }
  const raw = Buffer.from(JSON.stringify(envelope))
  const t = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', staticData.secret).update(`${t}.${raw.toString('utf8')}`).digest('hex')
  const ok = await new BillosTrigger().webhook.call(ctx(params, { staticData, request: { rawBody: raw, body: envelope, headers: { 'x-billos-signature': `t=${t},v1=${sig}` } } }))
  const item = ok.workflowData[0][0].json
  assert.equal(item.id, 'evt_1', 'keyed by the event')
  assert.equal(item.total, 354)
  const responses = []
  const forged = await new BillosTrigger().webhook.call(ctx(params, { staticData, responses, request: { rawBody: raw, body: envelope, headers: { 'x-billos-signature': `t=${t},v1=${'0'.repeat(64)}` } } }))
  assert.equal(forged.noWebhookResponse, true)
  assert.equal(responses[0], 401)

  assert.equal(await hooks.delete.call(ctx(params, { staticData })), true)
  assert.equal(await prisma.bkWebhookEndpoint.findUnique({ where: { id: row.id } }), null)
})

test('the trigger with a Connect token: the owner\'s own business, pinned', async () => {
  const reg = await (await fetch(`${origin}/v1/oauth-apps`, { method: 'POST', headers: { 'x-api-key': K, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'n8n', redirectUris: ['https://n8n.example/rest/oauth2-credential/callback'], scopes: ['businesses:read', 'documents:read', 'documents:write', 'expenses:read'] }) })).json()
  await books.setOAuthAppStatus({ id: reg.app.id, status: 'approved', actor: 'admin:test' })
  const owned = (await books.createBusiness({ ...BUSINESS, name: 'העסק של רונית', actor: 'test' })).business
  principals.set('ronit', { subject: 'user:ronit', email: 'ronit@x.co', businessIds: [owned.id] })
  const d = await (await fetch(`${origin}/oauth/authorize/decision`, { method: 'POST', headers: { authorization: 'Bearer ronit', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: reg.app.clientId, redirect_uri: 'https://n8n.example/rest/oauth2-credential/callback', scope: 'businesses:read documents:read documents:write expenses:read', state: 's', business_id: owned.id, approve: true }) })).json()
  const tok = await (await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: new URL(d.redirect).searchParams.get('code'), redirect_uri: 'https://n8n.example/rest/oauth2-credential/callback', client_id: reg.app.clientId, client_secret: reg.clientSecret }) })).json()
  credentials.billosOAuth2Api.accessToken = tok.access_token

  const list = await GF.getBusinesses.call(ctx({ authentication: 'oAuth2' }))
  assert.deepEqual(list.map((o) => o.value), [owned.id], 'a token sees exactly the connected business')
  const staticData = {}
  const params = { authentication: 'oAuth2', businessId: owned.id, events: ['document.issued'] }
  const hooks = new BillosTrigger().webhookMethods.default
  assert.equal(await hooks.create.call(ctx(params, { staticData, webhookUrl: 'https://n8n.example/webhook/o1' })), true)
  const row = await prisma.bkWebhookEndpoint.findUnique({ where: { id: staticData.webhookId } })
  assert.equal(row.businessId, owned.id)
  const [doc] = await run({ authentication: 'oAuth2', operation: 'create', businessId: owned.id, docType: 320, description: 'ייעוץ', unitPrice: 100, quantity: 1, priceIncludesVat: true, paymentMethod: 'card', issue: true, additionalFields: {} })
  assert.equal(doc.status, 'issued', 'the owner\'s own n8n issues in the owner\'s own numbering')
  assert.ok(await prisma.bkWebhookDelivery.findFirst({ where: { endpointId: row.id, event: 'document.issued' } }), 'and hears about it')
  assert.equal(await hooks.delete.call(ctx(params, { staticData })), true)
})
