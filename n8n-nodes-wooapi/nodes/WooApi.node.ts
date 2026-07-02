import { IExecuteFunctions } from 'n8n-core';
import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

export class WooApi implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'WooAPI',
    name: 'wooApi',
    icon: 'file:wooapi.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Envia e gerencia mensagens WhatsApp via WooAPI',
    defaults: {
      name: 'WooAPI',
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: 'wooApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Message',
            value: 'message',
          },
          {
            name: 'Instance',
            value: 'instance',
          },
        ],
        default: 'message',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: {
          show: {
            resource: ['message'],
          },
        },
        options: [
          {
            name: 'Send Text',
            value: 'sendText',
            description: 'Send a text message',
            action: 'Send a text message',
          },
          {
            name: 'Send Media',
            value: 'sendMedia',
            description: 'Send media (image, audio, video, document)',
            action: 'Send a media message',
          },
          {
            name: 'Send Location',
            value: 'sendLocation',
            description: 'Send a location',
            action: 'Send a location',
          },
          {
            name: 'Send Contact',
            value: 'sendContact',
            description: 'Send a contact card',
            action: 'Send a contact',
          },
          {
            name: 'Send Reply',
            value: 'sendReply',
            description: 'Reply to a message quoting it',
            action: 'Send a reply',
          },
        ],
        default: 'sendText',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: {
          show: {
            resource: ['instance'],
          },
        },
        options: [
          {
            name: 'Get Instances',
            value: 'getInstances',
            description: 'List all instances',
            action: 'List all instances',
          },
          {
            name: 'Get Status',
            value: 'getStatus',
            description: 'Get instance connection status',
            action: 'Get instance connection status',
          },
          {
            name: 'Get QR Code',
            value: 'getQR',
            description: 'Get QR code for connecting',
            action: 'Get QR code for connecting',
          },
          {
            name: 'Connect',
            value: 'connect',
            description: 'Connect an instance',
            action: 'Connect an instance',
          },
          {
            name: 'Logout',
            value: 'logout',
            description: 'Disconnect an instance',
            action: 'Disconnect an instance',
          },
        ],
        default: 'getInstances',
      },

      // ---- Message: Send Text Fields ----
      {
        displayName: 'Instance ID',
        name: 'instanceId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendText', 'sendMedia', 'sendLocation', 'sendContact', 'sendReply'],
          },
        },
        description: 'ID da instância WooAPI',
      },
      {
        displayName: 'Number',
        name: 'number',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendText', 'sendMedia', 'sendLocation', 'sendContact'],
          },
        },
        description: 'Número de destino com DDD (ex: 5548999999999)',
      },
      {
        displayName: 'JID',
        name: 'jid',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendReply'],
          },
        },
        description: 'JID completo do destino (ex: 5548999999999@s.whatsapp.net)',
      },
      {
        displayName: 'Message ID to Reply',
        name: 'messageId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendReply'],
          },
        },
        description: 'ID da mensagem original para responder citando',
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendText', 'sendReply'],
          },
        },
        description: 'Texto da mensagem',
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '',
        required: false,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendMedia'],
          },
        },
        description: 'Legenda da mídia',
      },

      // ---- Message: Send Media Fields ----
      {
        displayName: 'Media URL',
        name: 'mediaUrl',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendMedia'],
          },
        },
        description: 'URL pública da mídia',
      },
      {
        displayName: 'MIME Type',
        name: 'mimeType',
        type: 'string',
        default: '',
        required: false,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendMedia'],
          },
        },
        placeholder: 'image/jpeg, audio/mpeg, application/pdf',
        description: 'Tipo MIME da mídia (opcional)',
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: '',
        required: false,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendMedia'],
          },
        },
        description: 'Nome do arquivo (opcional)',
      },

      // ---- Message: Send Location Fields ----
      {
        displayName: 'Latitude',
        name: 'latitude',
        type: 'number',
        typeOptions: {
          numberStep: 0.000001,
        },
        default: 0,
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendLocation'],
          },
        },
      },
      {
        displayName: 'Longitude',
        name: 'longitude',
        type: 'number',
        typeOptions: {
          numberStep: 0.000001,
        },
        default: 0,
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendLocation'],
          },
        },
      },
      {
        displayName: 'Name',
        name: 'locationName',
        type: 'string',
        default: '',
        required: false,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendLocation'],
          },
        },
        description: 'Nome do local (opcional)',
      },
      {
        displayName: 'Address',
        name: 'address',
        type: 'string',
        default: '',
        required: false,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendLocation'],
          },
        },
        description: 'Endereço do local (opcional)',
      },

      // ---- Message: Send Contact Fields ----
      {
        displayName: 'Contact Name',
        name: 'contactName',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendContact'],
          },
        },
      },
      {
        displayName: 'Contact Phone',
        name: 'contactPhone',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['message'],
            operation: ['sendContact'],
          },
        },
        description: 'Telefone do contato a ser enviado',
      },

      // ---- Instance Fields ----
      {
        displayName: 'Instance ID',
        name: 'instanceId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['instance'],
            operation: ['getStatus', 'getQR', 'connect', 'logout'],
          },
        },
        description: 'ID da instância WooAPI',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('wooApi');
    const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');
    const apiKey = credentials.apiKey as string;

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;

        if (resource === 'message') {
          const instanceId = this.getNodeParameter('instanceId', i) as string;

          switch (operation) {
            case 'sendText': {
              const number = this.getNodeParameter('number', i) as string;
              const text = this.getNodeParameter('text', i) as string;
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/send-text`, {
                number,
                text,
              });
              returnData.push({ json: result.data || result });
              break;
            }

            case 'sendMedia': {
              const number = this.getNodeParameter('number', i) as string;
              const mediaUrl = this.getNodeParameter('mediaUrl', i) as string;
              const text = this.getNodeParameter('text', i, '') as string;
              const mimeType = this.getNodeParameter('mimeType', i, '') as string;
              const fileName = this.getNodeParameter('fileName', i, '') as string;
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/send-media`, {
                number,
                mediaUrl,
                caption: text || undefined,
                mime_type: mimeType || undefined,
                file_name: fileName || undefined,
              });
              returnData.push({ json: result.data || result });
              break;
            }

            case 'sendLocation': {
              const number = this.getNodeParameter('number', i) as string;
              const latitude = this.getNodeParameter('latitude', i) as number;
              const longitude = this.getNodeParameter('longitude', i) as number;
              const locationName = this.getNodeParameter('locationName', i, '') as string;
              const address = this.getNodeParameter('address', i, '') as string;
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/send-location`, {
                number,
                latitude,
                longitude,
                name: locationName || undefined,
                address: address || undefined,
              });
              returnData.push({ json: result.data || result });
              break;
            }

            case 'sendContact': {
              const number = this.getNodeParameter('number', i) as string;
              const contactName = this.getNodeParameter('contactName', i) as string;
              const contactPhone = this.getNodeParameter('contactPhone', i) as string;
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/send-contact`, {
                number,
                name: contactName,
                phone: contactPhone,
              });
              returnData.push({ json: result.data || result });
              break;
            }

            case 'sendReply': {
              const jid = this.getNodeParameter('jid', i) as string;
              const messageId = this.getNodeParameter('messageId', i) as string;
              const text = this.getNodeParameter('text', i) as string;
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/send-reply`, {
                jid,
                message_id: messageId,
                text,
              });
              returnData.push({ json: result.data || result });
              break;
            }

            default:
              throw new NodeOperationError(this.getNode(), `Operation "${operation}" is not supported`);
          }
        }

        if (resource === 'instance') {
          const instanceId = this.getNodeParameter('instanceId', i, '') as string;

          switch (operation) {
            case 'getInstances': {
              const result = await this.apiRequest(baseUrl, apiKey, 'GET', '/api/v1/instances');
              returnData.push({ json: result.data || result });
              break;
            }

            case 'getStatus': {
              const result = await this.apiRequest(baseUrl, apiKey, 'GET', `/api/v1/instances/${instanceId}/status`);
              returnData.push({ json: result.data || result });
              break;
            }

            case 'getQR': {
              const result = await this.apiRequest(baseUrl, apiKey, 'GET', `/api/v1/instances/${instanceId}/qr`);
              const qrBase64 = (result.data || result)?.base64 || (result.data || result)?.qr;
              returnData.push({ json: { qr: qrBase64, ...(result.data || result) } });
              break;
            }

            case 'connect': {
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/connect`);
              returnData.push({ json: result.data || result });
              break;
            }

            case 'logout': {
              const result = await this.apiRequest(baseUrl, apiKey, 'POST', `/api/v1/instances/${instanceId}/logout`);
              returnData.push({ json: result.data || result });
              break;
            }

            default:
              throw new NodeOperationError(this.getNode(), `Operation "${operation}" is not supported`);
          }
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ json: { error: (error as Error).message } });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }

  private async apiRequest(
    baseUrl: string,
    apiKey: string,
    method: string,
    path: string,
    body?: any,
  ): Promise<any> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.message || data?.error || data?.data || `HTTP ${response.status}`;
      throw new Error(`WooAPI error: ${message}`);
    }

    return data;
  }
}
