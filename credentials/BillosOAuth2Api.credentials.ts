import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// BillOS Connect: the business owner signs in on the BillOS consent screen and picks the
// business n8n may act on. Register a Connect app in the BillOS console with this
// credential's OAuth Redirect URL, and paste its client id and secret here.
export class BillosOAuth2Api implements ICredentialType {
	name = 'billosOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'BillOS OAuth2 API';

	icon = { light: 'file:billos.svg', dark: 'file:billos.dark.svg' } as const;

	documentationUrl = 'https://docs.billos.co.il/connect';

	properties: INodeProperties[] = [
		{ displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'authorizationCode' },
		{ displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: 'https://api.billos.co.il/oauth/authorize' },
		{ displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: 'https://api.billos.co.il/oauth/token' },
		{ displayName: 'Scope', name: 'scope', type: 'hidden', default: 'businesses:read documents:read documents:write expenses:read' },
		{ displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'hidden', default: '' },
		{ displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'body' },
	];
}
