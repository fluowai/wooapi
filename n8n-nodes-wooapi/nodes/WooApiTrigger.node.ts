import {
  ITriggerFunctions,
} from 'n8n-core';
import {
  INodeType,
  INodeTypeDescription,
  ITriggerResponse,
  IWebhookFunctions,
  INodeProperties,
  NodeConnectionType,
} from 'n8n-workflow';

export class WooApiTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'WooAPI Trigger',
    name: 'wooApiTrigger',
    icon: 'file:wooapi.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Recebe eventos do WhatsApp via WooAPI webhook',
    defaults: {
      name: 'WooAPI Trigger',
    },
    inputs: [],
    outputs: ['main'],
    credentials: [
      {
        name: 'wooApi',
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        responseData: 'noData',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Instance ID',
        name: 'instanceId',
        type: 'string',
        default: '',
        required: true,
        description: 'ID da instância WooAPI para escutar eventos',
      },
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        options: [
          {
            name: 'All Events',
            value: 'all',
            description: 'Receive all events',
          },
          {
            name: 'Message Received',
            value: 'message.received',
            description: 'When a message is received',
          },
          {
            name: 'Message Sent',
            value: 'message.sent',
            description: 'When a message is sent',
          },
          {
            name: 'Instance Connected',
            value: 'instance.connected',
            description: 'When instance connects',
          },
          {
            name: 'Instance Disconnected',
            value: 'instance.disconnected',
            description: 'When instance disconnects',
          },
          {
            name: 'QR Code Updated',
            value: 'instance.qr',
            description: 'When QR code is updated',
          },
        ],
        default: 'message.received',
        description: 'Tipo de evento para escutar',
      },
      {
        displayName: 'Events to Listen',
        name: 'events',
        type: 'multiOptions',
        typeOptions: {
          multiSelectFilter: true,
        },
        displayOptions: {
          show: {
            event: ['all'],
          },
        },
        options: [
          { name: 'Message Received', value: 'message.received' },
          { name: 'Message Sent', value: 'message.sent' },
          { name: 'Message Delivered', value: 'message.delivered' },
          { name: 'Message Read', value: 'message.read' },
          { name: 'Message Failed', value: 'message.failed' },
          { name: 'Instance Connected', value: 'instance.connected' },
          { name: 'Instance Disconnected', value: 'instance.disconnected' },
          { name: 'Instance QR', value: 'instance.qr' },
          { name: 'Instance Reconnecting', value: 'instance.reconnecting' },
          { name: 'Media Received', value: 'media.received' },
        ],
        default: ['message.received', 'message.sent'],
        description: 'Eventos específicos para escutar (apenas quando "All Events")',
      },
    ],
  };

  async webhook(this: IWebhookFunctions): Promise<ITriggerResponse> {
    const body = this.getBodyData() as any;
    const query = this.getQueryData() as any;
    const event = body.event || query.event || '';
    const instanceId = this.getNodeParameter('instanceId', '') as string;
    const selectedEvent = this.getNodeParameter('event', '') as string;

    if (selectedEvent !== 'all') {
      if (event !== selectedEvent) {
        return {
          noWebhookResponse: true,
          workflowData: [[]],
        };
      }
    } else {
      const allowedEvents = this.getNodeParameter('events', []) as string[];
      if (allowedEvents.length > 0 && !allowedEvents.includes(event)) {
        return {
          noWebhookResponse: true,
          workflowData: [[]],
        };
      }
    }

    const instanceIdMatch =
      (body.instance_id || '') === instanceId ||
      (query.instance_id || '') === instanceId;
    if (!instanceIdMatch) {
      return {
        noWebhookResponse: true,
        workflowData: [[]],
      };
    }

    const eventData = body.data || body.payload || body;
    return {
      noWebhookResponse: true,
      workflowData: [
        [
          {
            json: {
              event,
              event_id: body.event_id || '',
              instance_id: body.instance_id || query.instance_id || instanceId,
              tenant_id: body.tenant_id || '',
              timestamp: body.timestamp || new Date().toISOString(),
              data: eventData,
              raw: body,
            },
          },
        ],
      ],
    };
  }

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const instanceId = this.getNodeParameter('instanceId', '') as string;
    const webhookUrl = this.getWebhookUrl('default');

    const credentials = await this.getCredentials('wooApi');
    const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');
    const apiKey = credentials.apiKey as string;

    try {
      await this.registerWebhook(baseUrl, apiKey, instanceId, webhookUrl);
    } catch (error) {
      console.error('[WooAPI Trigger] Failed to register webhook:', (error as Error).message);
    }

    const manualTriggerFunction = async () => {
      return [[]];
    };

    return {
      manualTriggerFunction,
    };
  }

  private async registerWebhook(
    baseUrl: string,
    apiKey: string,
    instanceId: string,
    webhookUrl: string,
  ): Promise<void> {
    const selectedEvent = this.getNodeParameter('event', '') as string;
    const events =
      selectedEvent === 'all'
        ? (this.getNodeParameter('events', []) as string[])
        : [selectedEvent];

    const url = `${baseUrl}/api/v1/instances/${instanceId}/webhooks`;
    const body = {
      name: 'n8n Trigger',
      url: webhookUrl,
      events,
      retry_enabled: true,
      max_attempts: 3,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        `Failed to register webhook: ${data?.message || data?.error || response.status}`,
      );
    }
  }
}
