import { randomUUID } from 'node:crypto';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
  IDataObject,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { apiRequest, apiRoot, object, requireId, safeNodeError } from './transport';
import { verifySignature } from './signature';

const eventType = 'monitoring.change_confirmed';

export class KonexiumTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Konexium Trigger',
    name: 'konexiumTrigger',
    icon: { light: 'file:konexium.svg', dark: 'file:konexium.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: 'Watch Change Confirmed',
    description: 'Start a workflow when Konexium confirms a Watch change',
    defaults: { name: 'Konexium Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'konexiumApi', required: true }],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
        isFullPath: false,
        rawBody: true,
      },
    ],
    properties: [
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        default: eventType,
        options: [{ name: 'Watch Change Confirmed', value: eventType }],
        description:
          'Confirmed company changes only. The API key needs read and webhooks:write scopes.',
      },
      {
        displayName:
          'Activation registers a signed webhook; deactivation deletes it. Use a publicly reachable HTTPS n8n webhook URL. Downstream actions should deduplicate webhookId.',
        name: 'webhookNotice',
        type: 'notice',
        default: '',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const state = object(
          this.getWorkflowStaticData('node').konexiumWebhook,
        );
        if (
          !state.id ||
          !state.secret ||
          state.url !== this.getNodeWebhookUrl('default') ||
          state.root !== (await apiRoot(this))
        )
          return false;
        const id = requireId(this, state.id);
        // The API returns a paginated ARRAY, not {items,total}. Never infer absence after a partial scan.
        for (let page = 1; page <= 100; page++) {
          const endpoints = await apiRequest<IDataObject[]>(
            this,
            'GET',
            '/webhooks',
            { qs: { page, pageSize: 100 } },
          );
          if (!Array.isArray(endpoints))
            throw new NodeOperationError(
              this.getNode(),
              'Konexium returned an unexpected webhook list.',
            );
          const endpoint = endpoints.find((entry) => entry.id === id);
          if (endpoint)
            return (
              endpoint.enabled === true &&
              endpoint.url === state.url &&
              Array.isArray(endpoint.events) &&
              endpoint.events.length === 1 &&
              endpoint.events[0] === eventType
            );
          if (endpoints.length < 100) return false;
        }
        throw new NodeOperationError(
          this.getNode(),
          'Webhook pagination limit reached. Deactivate the old endpoint before retrying.',
        );
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const store = this.getWorkflowStaticData('node');
        const old = object(store.konexiumWebhook);
        const root = await apiRoot(this);
        const url = this.getNodeWebhookUrl('default');
        if (!url || !url.startsWith('https://'))
          throw new NodeOperationError(
            this.getNode(),
            'Konexium requires a publicly reachable HTTPS webhook URL.',
          );
        if (old.root && old.root !== root)
          throw new NodeOperationError(
            this.getNode(),
            'Deactivate this trigger using its previous API server before changing the server.',
          );
        if (old.id) {
          try {
            await apiRequest(
              this,
              'DELETE',
              `/webhooks/${requireId(this, old.id)}`,
            );
          } catch (error) {
            if (object(error).httpCode !== '404') throw safeNodeError(this, error);
          }
          delete store.konexiumWebhook;
          delete store.konexiumRegistration;
        }
        const pending = object(store.konexiumRegistration);
        const key =
          pending.url === url &&
          pending.root === root &&
          typeof pending.key === 'string'
            ? pending.key
            : `n8n-${randomUUID()}`;
        store.konexiumRegistration = { key, url, root };
        const endpoint = await apiRequest<IDataObject>(
          this,
          'POST',
          '/webhooks',
          {
            body: {
              url,
              events: [eventType],
              description: 'Konexium Watch alerts for n8n',
              enabled: true,
            },
            idempotencyKey: key,
          },
        );
        const id = requireId(this, endpoint.id);
        if (
          typeof endpoint.secret !== 'string' ||
          !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(endpoint.secret)
        ) {
          // Keep the ID for cleanup, but fail closed without a valid signing secret.
          store.konexiumWebhook = { id, root, url };
          throw new NodeOperationError(
            this.getNode(),
            'Konexium did not return a signing secret. Deactivate and reactivate the trigger.',
          );
        }
        store.konexiumWebhook = { id, secret: endpoint.secret, url, root };
        delete store.konexiumRegistration;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const store = this.getWorkflowStaticData('node');
        const state = object(store.konexiumWebhook);
        if (state.id) {
          if (state.root !== (await apiRoot(this)))
            throw new NodeOperationError(
              this.getNode(),
              'Restore the previous API server to remove this webhook.',
            );
          try {
            await apiRequest(
              this,
              'DELETE',
              `/webhooks/${requireId(this, state.id)}`,
            );
          } catch (error) {
            if (object(error).httpCode !== '404') throw safeNodeError(this, error);
          }
        }
        delete store.konexiumWebhook;
        delete store.konexiumRegistration;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const state = object(this.getWorkflowStaticData('node').konexiumWebhook);
    const request = this.getRequestObject();
    const event = verifySignature(
      request.rawBody,
      this.getHeaderData(),
      state.secret,
    );
    if (!event) {
      this.getResponseObject()
        .status(401)
        .json({ message: 'Invalid Konexium webhook signature or payload.' });
      return { noWebhookResponse: true };
    }
    if (event.type === 'webhook.test')
      return { webhookResponse: { received: true } };
    return { workflowData: [[{ json: event }]] };
  }
}
