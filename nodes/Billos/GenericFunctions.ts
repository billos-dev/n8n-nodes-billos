import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

export const API_BASE = 'https://api.billos.co.il/v1';
export const PUBLIC_ORIGIN = 'https://api.billos.co.il';

export const DOC_TYPES: INodePropertyOptions[] = [
	{ name: 'Tax Invoice / Receipt', value: 320 },
	{ name: 'Tax Invoice', value: 305 },
	{ name: 'Receipt', value: 400 },
	{ name: 'Proforma Invoice', value: 300 },
];
const DOC_TYPE_NAME: Record<number, string> = { 300: 'Proforma invoice', 305: 'Tax invoice', 320: 'Tax invoice / receipt', 330: 'Credit note', 400: 'Receipt' };

function credentialType(this: Ctx): string {
	return (this.getNodeParameter('authentication', 0, 'apiKey') as string) === 'oAuth2' ? 'billosOAuth2Api' : 'billosApi';
}

async function baseUrl(this: Ctx, type: string): Promise<string> {
	if (type !== 'billosApi') return API_BASE;
	const creds = await this.getCredentials(type);
	return String(creds.baseUrl || API_BASE).replace(/\/+$/, '');
}

/** One BillOS call with whichever credential the node uses. A refusal surfaces as the
 *  sentence BillOS wrote. */
export async function billosRequest(
	this: Ctx,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	headers?: IDataObject,
): Promise<IDataObject> {
	const type = credentialType.call(this);
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl.call(this, type)}${path}`,
		json: true,
		...(body ? { body } : {}),
		...(qs ? { qs } : {}),
		...(headers ? { headers } : {}),
	};
	return (await this.helpers.httpRequestWithAuthentication.call(this, type, options)) as IDataObject;
}

export async function getBusinesses(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const r = await billosRequest.call(this, 'GET', '/businesses');
	return ((r.businesses as IDataObject[] | undefined) || []).map((b) => ({ name: `${b.name} (${b.taxId})`, value: b.id as string }));
}

const major = (n: unknown) => (typeof n === 'number' ? Math.round(n) / 100 : null);

/** A webhook envelope as one flat item, keyed by the event so a redelivery is the same item. */
export function flattenEvent(env: IDataObject): IDataObject {
	const d = (env.data || {}) as IDataObject;
	const out: IDataObject = {
		id: env.eventId || env.id,
		deliveryId: env.eventId ? env.id : null,
		event: env.event,
		businessId: env.businessId,
		createdAt: env.createdAt,
		mode: env.mode ?? null,
		...d,
	};
	if (d.docType != null) out.documentType = DOC_TYPE_NAME[d.docType as number] || String(d.docType);
	if (d.totalIncVat != null) {
		out.total = major(d.fxTotalIncVat != null ? d.fxTotalIncVat : d.totalIncVat);
		out.totalIls = major(d.totalIncVat);
	}
	if (d.vatAmount != null) out.vat = major(d.vatAmount);
	if (d.amountIncVat != null) out.amount = major(d.amountIncVat);
	return out;
}

export function flattenDocument(doc: IDataObject, extra: IDataObject = {}): IDataObject {
	return {
		id: doc.id,
		status: doc.status,
		docType: doc.docType,
		documentType: DOC_TYPE_NAME[doc.docType as number] || String(doc.docType),
		docNumber: doc.docNumber ?? null,
		documentDate: doc.documentDate ? String(doc.documentDate).slice(0, 10) : null,
		customerName: doc.partyName || null,
		currency: doc.currency || 'ILS',
		total: major(doc.fxTotalIncVat != null ? doc.fxTotalIncVat : doc.totalIncVat),
		totalIls: major(doc.totalIncVat),
		vat: major(doc.vatAmount),
		allocationNumber: doc.allocationNumber || null,
		externalRef: doc.externalRef || null,
		...extra,
	};
}
