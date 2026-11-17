import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestOptions,
  IWebhookFunctions,
} from 'n8n-workflow';

export type ApiContext = IExecuteFunctions | IHookFunctions | IWebhookFunctions;

/** Retain only our typed, sanitized messages; never carry a helper request/cause into n8n. */
export function safeNodeError(context: ApiContext, error: unknown): NodeApiError | NodeOperationError {
  if (error instanceof NodeApiError) {
    return new NodeApiError(context.getNode(), { message: error.message }, { message: error.message, httpCode: error.httpCode ?? undefined });
  }
  return new NodeOperationError(context.getNode(), error instanceof NodeOperationError ? error.message : 'Konexium operation failed.');
}

export function object(value: unknown): IDataObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as IDataObject)
    : {};
}

export async function apiRoot(context: ApiContext): Promise<string> {
  const credentials = await context.getCredentials('konexiumApi');
  try {
    const url = new URL(String(credentials.baseUrl));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    ) {
      throw new NodeOperationError(
        context.getNode(),
        'Use an HTTPS server origin without a path, query or embedded credentials.',
      );
    }
    return `${url.origin}/api/v1/public`;
  } catch {
    throw new NodeOperationError(
      context.getNode(),
      'Base URL must be an HTTPS server origin. HTTP loopback is allowed for local tests.',
    );
  }
}

export async function apiRequest<T>(
  context: ApiContext,
  method: IHttpRequestOptions['method'],
  path: string,
  options: {
    body?: IDataObject;
    qs?: IDataObject;
    idempotencyKey?: string;
    timeout?: number;
  } = {},
): Promise<T> {
  const url = `${await apiRoot(context)}${path}`;
  try {
    return (await context.helpers.httpRequestWithAuthentication.call(
      context,
      'konexiumApi',
      {
        method,
        url,
        json: true,
        timeout: options.timeout ?? 30_000,
        disableFollowRedirect: true,
        ...(options.body ? { body: options.body } : {}),
        ...(options.qs ? { qs: options.qs } : {}),
        headers: {
          Accept: 'application/json',
          ...(options.idempotencyKey
            ? { 'Idempotency-Key': options.idempotencyKey }
            : {}),
        },
      },
    )) as T;
  } catch (error) {
    // Never attach the original helper error: it can contain credentials and request bodies.
    const detail = object(error);
    const response = object(detail.response);
    const status = Number(
      detail.statusCode ??
        detail.httpCode ??
        response.status ??
        response.statusCode,
    );
    const messages: Record<number, string> = {
      400: 'Konexium rejected the input. Check the company details and criteria.',
      401: 'Konexium authentication failed. Check the API key.',
      402: 'Konexium has insufficient credits or a spending cap was reached.',
      403: 'Konexium denied this operation. Check the API key scopes and workspace permissions.',
      404: 'Konexium could not find this resource in the key workspace and environment.',
      409: 'Konexium reported a conflict. A watch limit or in-progress idempotent request may apply.',
      422: 'Konexium rejected the idempotency key. Reuse a key only with the same input.',
      429: 'Konexium rate limit reached. Wait for the API Retry-After interval before retrying.',
    };
    const message =
      messages[status] ??
      (status >= 500
        ? 'Konexium is temporarily unavailable. Retry later with the same idempotency key.'
        : 'Konexium could not complete the request. Check connectivity; retain the same idempotency key when retrying.');
    throw new NodeApiError(
      context.getNode(),
      {
        message,
        ...(Number.isInteger(status) && status >= 400 && status <= 599
          ? { statusCode: String(status) }
          : {}),
      },
      { message },
    );
  }
}

export function requireText(
  context: ApiContext,
  value: unknown,
  label: string,
  max: number,
): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new NodeOperationError(
      context.getNode(),
      `${label} must contain 1 to ${max} characters.`,
    );
  }
  return value.trim();
}

export function requireInteger(
  context: ApiContext,
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new NodeOperationError(
      context.getNode(),
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

export function requireId(context: ApiContext, value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  ) {
    throw new NodeOperationError(
      context.getNode(),
      'Konexium requires a valid resource UUID.',
    );
  }
  return value;
}
