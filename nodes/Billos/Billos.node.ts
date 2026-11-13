import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type JsonObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { billosRequest, DOC_TYPES, flattenDocument, getBusinesses, PUBLIC_ORIGIN } from './GenericFunctions';

const RECEIPT_BEARING = new Set([320, 400]);
const agorot = (shekels: number) => Math.round(shekels * 100);
// The ledger's line arithmetic (quantity to four decimals, total rounded to the agora),
// mirrored for the one number it must equal: an invoice-receipt's payment.
const lineTotal = (unitAgorot: number, quantity: number) => Math.round((unitAgorot * Math.round(quantity * 10000)) / 10000);

export class Billos implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BillOS',
		name: 'billos',
		icon: { light: 'file:billos.svg', dark: 'file:billos.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Issue Israeli tax invoices and receipts, numbered and digitally signed',
		defaults: { name: 'BillOS' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{ name: 'billosApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
			{ name: 'billosOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'API Key', value: 'apiKey' },
					{ name: 'OAuth2 (BillOS Connect)', value: 'oAuth2' },
				],
				default: 'apiKey',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Create Document', value: 'create', action: 'Create a document', description: 'Issue (or draft) an invoice, invoice-receipt, receipt or proforma' },
					{ name: 'Get Document', value: 'get', action: 'Get a document' },
					{ name: 'Get PDF Link', value: 'getPdfLink', action: 'Get a document PDF link', description: 'The public link to an issued document\'s signed PDF' },
					{ name: 'Search Documents', value: 'search', action: 'Search documents', description: 'Issued documents by number or customer name' },
				],
				default: 'create',
			},
			{
				displayName: 'Business Name or ID',
				name: 'businessId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getBusinesses' },
				required: true,
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			// ── create ──
			{ displayName: 'Document Type', name: 'docType', type: 'options', options: DOC_TYPES, default: 320, displayOptions: { show: { operation: ['create'] } } },
			{ displayName: 'Description', name: 'description', type: 'string', default: '', displayOptions: { show: { operation: ['create'] } }, description: 'What was sold. Required on invoices; on a receipt it is printed as the note.' },
			{ displayName: 'Unit Price (₪)', name: 'unitPrice', type: 'number', typeOptions: { numberPrecision: 2, minValue: 0 }, default: 0, required: true, displayOptions: { show: { operation: ['create'] } } },
			{ displayName: 'Quantity', name: 'quantity', type: 'number', default: 1, displayOptions: { show: { operation: ['create'] } } },
			{ displayName: 'Price Includes VAT', name: 'priceIncludesVat', type: 'boolean', default: true, displayOptions: { show: { operation: ['create'] } }, description: 'Whether the customer pays exactly this price (מע"מ כלול), or VAT is added on top' },
			{
				displayName: 'Payment Method',
				name: 'paymentMethod',
				type: 'options',
				options: [
					{ name: 'Bank Transfer', value: 'transfer' },
					{ name: 'Bit', value: 'bit' },
					{ name: 'Cash', value: 'cash' },
					{ name: 'Check', value: 'check' },
					{ name: 'Credit Card', value: 'card' },
					{ name: 'Other', value: 'other' },
					{ name: 'PayBox', value: 'paybox' },
				],
				default: 'transfer',
				displayOptions: { show: { operation: ['create'], docType: [320, 400] } },
			},
			{ displayName: 'Issue Now', name: 'issue', type: 'boolean', default: true, displayOptions: { show: { operation: ['create'] } }, description: 'Whether to issue now (a permanent number and signature) or save a draft to review in the BillOS console' },
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { operation: ['create'] } },
				options: [
					{ displayName: 'Customer Address', name: 'customerAddress', type: 'string', default: '' },
					{ displayName: 'Customer Email', name: 'customerEmail', type: 'string', placeholder: 'name@email.com', default: '' },
					{ displayName: 'Customer Name', name: 'customerName', type: 'string', default: '', description: 'Leave empty for an anonymous cash receipt' },
					{ displayName: 'Customer Phone', name: 'customerPhone', type: 'string', default: '' },
					{ displayName: 'Customer Tax ID', name: 'customerTaxId', type: 'string', default: '', description: 'ח.פ or ע.מ. Needed for an allocation number on a large invoice to a business.' },
					{ displayName: 'Email to Customer', name: 'emailToCustomer', type: 'boolean', default: false, description: 'Whether BillOS emails the customer the document link' },
					{ displayName: 'Language', name: 'lang', type: 'options', options: [{ name: 'Hebrew', value: 'he' }, { name: 'English', value: 'en' }], default: 'he' },
					{ displayName: 'Note', name: 'note', type: 'string', default: '', description: 'Printed under the lines, up to 500 characters' },
					{ displayName: 'Your Reference', name: 'externalRef', type: 'string', default: '', description: 'An order or payment ID. The same reference never creates a second document.' },
				],
			},
			// ── get / getPdfLink ──
			{ displayName: 'Document ID', name: 'documentId', type: 'string', required: true, default: '', displayOptions: { show: { operation: ['get', 'getPdfLink'] } } },
			// ── search ──
			{ displayName: 'Query', name: 'query', type: 'string', required: true, default: '', displayOptions: { show: { operation: ['search'] } }, description: 'A document number or a customer name' },
			{ displayName: 'Document Type', name: 'searchDocType', type: 'options', options: [{ name: 'Any', value: 0 }, ...DOC_TYPES, { name: 'Credit Note (חשבונית זיכוי)', value: 330 }], default: 0, displayOptions: { show: { operation: ['search'] } } },
			{ displayName: 'Limit', name: 'limit', type: 'number', typeOptions: { minValue: 1 }, default: 50, displayOptions: { show: { operation: ['search'] } }, description: 'Max number of results to return' },
		],
	};

	methods = { loadOptions: { getBusinesses } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const bid = encodeURIComponent(this.getNodeParameter('businessId', i) as string);
				if (operation === 'create') {
					out.push({ json: await createDocument.call(this, i, bid), pairedItem: { item: i } });
				} else if (operation === 'get') {
					const id = encodeURIComponent(this.getNodeParameter('documentId', i) as string);
					const r = await billosRequest.call(this, 'GET', `/businesses/${bid}/documents/${id}`);
					out.push({ json: flattenDocument(r.document as IDataObject), pairedItem: { item: i } });
				} else if (operation === 'getPdfLink') {
					const id = this.getNodeParameter('documentId', i) as string;
					const r = await billosRequest.call(this, 'POST', `/businesses/${bid}/documents/${encodeURIComponent(id)}/share`, { kind: 'auto' });
					out.push({ json: { documentId: id, pdfUrl: `${PUBLIC_ORIGIN}${r.path as string}`, variant: r.variant as string }, pairedItem: { item: i } });
				} else if (operation === 'search') {
					const qs: IDataObject = { status: 'issued', q: this.getNodeParameter('query', i) as string, take: this.getNodeParameter('limit', i) as number };
					const docType = this.getNodeParameter('searchDocType', i) as number;
					if (docType) qs.docType = docType;
					const r = await billosRequest.call(this, 'GET', `/businesses/${bid}/documents`, undefined, qs);
					for (const d of (r.documents as IDataObject[] | undefined) || []) out.push({ json: flattenDocument(d), pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error instanceof NodeOperationError ? error : new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}
		return [out];
	}
}

async function createDocument(this: IExecuteFunctions, i: number, bid: string): Promise<IDataObject> {
	const docType = Number(this.getNodeParameter('docType', i));
	const description = this.getNodeParameter('description', i, '') as string;
	const unitPrice = Number(this.getNodeParameter('unitPrice', i));
	const quantity = Number(this.getNodeParameter('quantity', i, 1) || 1);
	const gross = this.getNodeParameter('priceIncludesVat', i, true) as boolean;
	const issue = this.getNodeParameter('issue', i, true) as boolean;
	const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	if (!(unitPrice > 0)) throw new NodeOperationError(this.getNode(), 'Enter a unit price above zero.', { itemIndex: i });
	if (docType !== 400 && !description) throw new NodeOperationError(this.getNode(), 'An invoice needs a description of what was sold.', { itemIndex: i });
	const method = RECEIPT_BEARING.has(docType) ? (this.getNodeParameter('paymentMethod', i) as string) : null;

	// An invoice-receipt's payment must equal its total, and a draft carries no totals until
	// issue. A net price is therefore sent VAT-inclusive at the business's own rate, so the
	// payment is computed by the same rule the ledger uses.
	let unitAgorot = agorot(unitPrice);
	let priceMode = gross ? 'gross' : 'net';
	if (docType === 320 && !gross) {
		const biz = ((await billosRequest.call(this, 'GET', `/businesses/${bid}`)).business || {}) as IDataObject;
		const bp = biz.dealerType === 'exempt' ? 0 : Number(biz.defaultVatRateBp ?? 1800);
		unitAgorot = Math.round((unitAgorot * (10000 + bp)) / 10000);
		priceMode = 'gross';
	}
	const party: IDataObject = {};
	for (const [k, f] of [['name', 'customerName'], ['email', 'customerEmail'], ['phone', 'customerPhone'], ['taxId', 'customerTaxId'], ['address', 'customerAddress']]) {
		if (extra[f]) party[k] = extra[f];
	}
	const note = (extra.note as string) || (docType === 400 ? description : '');
	const body: IDataObject = {
		docType,
		priceMode,
		...(party.name ? { party } : {}),
		...(docType === 400 ? {} : { lines: [{ description, quantity, unitPriceExVat: unitAgorot }] }),
		...(method ? { payments: [{ method, amount: lineTotal(unitAgorot, quantity) }] } : {}),
		...(note ? { note: String(note).slice(0, 500) } : {}),
		...(extra.lang ? { lang: extra.lang } : {}),
	};
	const headers = extra.externalRef ? { 'Idempotency-Key': String(extra.externalRef).slice(0, 100) } : undefined;
	const created = await billosRequest.call(this, 'POST', `/businesses/${bid}/documents`, body, undefined, headers);
	let doc = created.document as IDataObject;
	if (doc.status === 'issued') return flattenDocument(doc, { pdfUrl: await shareLink.call(this, bid, doc.id as string), deduped: true });
	if (!issue) return flattenDocument(doc, { pdfUrl: null });

	const issued = await billosRequest.call(this, 'POST', `/businesses/${bid}/documents/${doc.id}/issue`, {});
	doc = issued.document as IDataObject;
	let emailedTo: string | null = null;
	if (extra.emailToCustomer && extra.customerEmail) {
		await billosRequest.call(this, 'POST', `/businesses/${bid}/documents/${doc.id}/email`, { to: [extra.customerEmail] });
		emailedTo = extra.customerEmail as string;
	}
	return flattenDocument(doc, { pdfUrl: await shareLink.call(this, bid, doc.id as string), emailedTo, warnings: (issued.warnings as string[] | undefined) || [] });
}

async function shareLink(this: IExecuteFunctions, bid: string, id: string): Promise<string | null> {
	try {
		const r = await billosRequest.call(this, 'POST', `/businesses/${bid}/documents/${id}/share`, { kind: 'auto' });
		return `${PUBLIC_ORIGIN}${r.path as string}`;
	} catch {
		// Right after issue the signed PDF may still be rendering; the document is issued.
		return null;
	}
}
