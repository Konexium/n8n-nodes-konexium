import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class KonexiumApi implements ICredentialType {
  name = 'konexiumApi';
  displayName = 'Konexium API';
  documentationUrl = 'https://konexiumai.com';
  icon = 'file:../nodes/Konexium/konexium.svg' as const;
  httpRequestNode = { name: 'Konexium', docsUrl: 'https://konexiumai.com', apiBaseUrl: 'https://api.konexiumai.com/api/v1/public' };
  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      description:
        'Use a workspace API key. Test keys (kxm_test_...) are free deterministic fixtures and use 0 credits.',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.konexiumai.com',
      required: true,
      description:
        'API server origin, without /api/v1. Use HTTPS; HTTP loopback is supported for local tests.',
    },
  ];
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
    },
  };
  test: ICredentialTestRequest = {
    request: {
      method: 'GET',
      baseURL: '={{$credentials.baseUrl.endsWith("/") ? $credentials.baseUrl.slice(0, -1) : $credentials.baseUrl}}',
      url: '/api/v1/public/me',
    },
  };
}
