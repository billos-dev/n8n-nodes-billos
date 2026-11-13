import { createHmac, timingSafeEqual } from 'crypto';
import {
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { billosRequest, flattenEvent, getBusinesses } from './GenericFunctions';

const EVENTS = [
	{ name: 'Document Issued', value: 'document.issued' },
	{ name: 'Document PDF Ready', value: 'document.pdf_ready' },
	{ name: 'Invoice Paid', value: 'document.paid' },
	{ name: 'Allocation Number Assigned', value: 'document.allocation_assigned' },
	{ name: 'Expense Recorded', value: 'expense.recorded' },
	{ name: 'Quote Sent', value: 'quote.sent' },
	{ name: 'Quote Accepted', value: 'quote.accepted' },
	{ name: 'Quote Declined', value: 'quote.declined' },
	{ name: 'Recurring Document Ran', value: 'recurring.ran' },
	{ name: 'Export Completed', value: 'export.completed' },
	{ name: 'Business Status Changed', value: 'business.status_changed' },
	{ name: 'Tax Authority Connected', value: 'ita.connected' },
	{ name: 'Tax Authority Connection Expiring', value: 'ita.expiring' },
	{ name: 'Tax Authority Connection Expired', value: 'ita.expired' },
	{ name: 'Tax Authority Disconnected', value: 'ita.disconnected' },
];

export class BillosTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BillOS Trigger',
		name: 'billosTrigger',
		icon: { light: 'file:billos.svg', dark: 'file:billos.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when something happens in the BillOS books',
		defaults: { name: 'BillOS Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{ name: 'billosApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
			{ name: 'billosOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
		],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
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
				displayName: 'Business Name or ID',
				name: 'businessId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getBusinesses' },
				required: true,
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{ displayName: 'Events', name: 'events', type: 'multiOptions', options: EVENTS, required: true, default: ['document.issued'] },
		],
	};

	methods = { loadOptions: { getBusinesses } };

	// The endpoint is BillOS's record of this workflow: created on activation, deleted on
	// deactivation, found again by its URL if the workflow restarts.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				const data = this.getWorkflowStaticData('node');
				const r = await billosRequest.call(this, 'GET', '/webhooks');
				const found = ((r.webhooks as IDataObject[] | undefined) || []).find((w) => w.url === url);
				if (!found) return false;
				data.webhookId = found.id;
				data.secret = found.secret;
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const r = await billosRequest.call(this, 'POST', '/webhooks', {
					url: this.getNodeWebhookUrl('default'),
					events: this.getNodeParameter('events') as string[],
					businessId: this.getNodeParameter('businessId') as string,
				});
				const data = this.getWorkflowStaticData('node');
				const webhook = r.webhook as IDataObject;
				data.webhookId = webhook.id;
				data.secret = webhook.secret;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.webhookId) {
					try {
						await billosRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(data.webhookId as string)}`);
					} catch (error) {
						// Already gone (deleted in the console, or the connection ended): the workflow
						// is turning off anyway, so it is logged rather than failed.
						this.logger.warn(`BillOS webhook ${String(data.webhookId)} could not be deleted: ${(error as Error).message}`);
					}
				}
				delete data.webhookId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as unknown as { rawBody?: Buffer; headers: Record<string, string> };
		const secret = this.getWorkflowStaticData('node').secret as string | undefined;
		const header = req.headers['x-billos-signature'];
		// X-BillOS-Signature: t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${raw body}`)>
		if (secret && req.rawBody && header) {
			const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
			const expected = createHmac('sha256', secret).update(`${parts.t}.${req.rawBody.toString('utf8')}`).digest('hex');
			const a = Buffer.from(expected);
			const b = Buffer.from(String(parts.v1 || ''));
			if (a.length !== b.length || !timingSafeEqual(a, b)) {
				this.getResponseObject().status(401).send('bad signature');
				return { noWebhookResponse: true };
			}
		}
		const body = this.getBodyData() as IDataObject;
		// webhook.test proves the endpoint; it carries no business event.
		if (body.event === 'webhook.test') return { noWebhookResponse: false };
		return { workflowData: [this.helpers.returnJsonArray([flattenEvent(body)])] };
	}
}
