import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { object } from './transport';

/** Standard Webhooks 1.0, using the exact bytes received by n8n. */
export function verifySignature(
  raw: unknown,
  headers: Record<string, unknown>,
  secret: unknown,
): IDataObject | undefined {
  try {
    if (
      !Buffer.isBuffer(raw) ||
      typeof secret !== 'string' ||
      !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
    )
      return;
    const header = (name: string): string | undefined => {
      const value = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === name,
      )?.[1];
      return typeof value === 'string' ? value : undefined;
    };
    const id = header('webhook-id');
    const timestamp = header('webhook-timestamp');
    const signatures = header('webhook-signature');
    if (
      !id ||
      id.length > 256 ||
      !timestamp ||
      !/^\d{1,12}$/.test(timestamp) ||
      !signatures ||
      signatures.length > 4096
    )
      return;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300)
      return;
    const expected = createHmac(
      'sha256',
      Buffer.from(secret.slice(6), 'base64'),
    )
      .update(`${id}.${timestamp}.`)
      .update(raw)
      .digest();
    const valid = signatures.split(/\s+/).some((candidate) => {
      if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(candidate)) return false;
      const actual = Buffer.from(candidate.slice(3), 'base64');
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
    if (!valid) return;
    const event = object(JSON.parse(raw.toString('utf8')));
    const data = object(event.data);
    if (
      typeof event.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(event.timestamp))
    )
      return;
    if (
      event.type === 'monitoring.change_confirmed' &&
      ['watchId', 'companyId', 'kind', 'api'].every(
        (key) => typeof data[key] === 'string' && data[key] !== '',
      )
    ) {
      return { ...event, webhookId: id };
    }
    if (event.type === 'webhook.test' && typeof data.workspaceId === 'string')
      return { ...event, webhookId: id };
    return;
  } catch {
    return;
  }
}
