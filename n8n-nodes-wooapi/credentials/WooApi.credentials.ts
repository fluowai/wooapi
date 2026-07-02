import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class WooApi implements ICredentialType {
  name = 'wooApi';
  displayName = 'WooAPI';
  documentationUrl = 'https://github.com/anomalyco/wasenderbr-1/docs/wooapi-api.md';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.seudominio.com',
      placeholder: 'https://api.seudominio.com',
      description: 'URL base da sua instância WooAPI',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      placeholder: 'woo_sua_api_key',
      description: 'API key da instância WooAPI (formato: woo_xxx)',
    },
  ];
}
