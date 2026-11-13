import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

// An API key from the BillOS console (dash.billos.co.il → מפתחים). A bk_test_ key answers
// from the sandbox and a bk_live_ key from the real ledger, at the same address.
export class BillosApi implements ICredentialType {
	name = 'billosApi';

	displayName = 'BillOS API';

	icon = { light: 'file:billos.svg', dark: 'file:billos.dark.svg' } as const;

	documentationUrl = 'https://docs.billos.co.il/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'A bk_live_ key for the real ledger, or a bk_test_ key for the sandbox',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.billos.co.il/v1',
			description: 'Leave as is. The same address serves live and sandbox keys.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } },
	};

	test: ICredentialTestRequest = {
		request: { baseURL: '={{$credentials.baseUrl}}', url: '/businesses' },
	};
}
