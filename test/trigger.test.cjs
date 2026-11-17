const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
const {
  KonexiumTrigger,
} = require('../dist/nodes/Konexium/KonexiumTrigger.node.js');
const { verifySignature } = require('../dist/nodes/Konexium/signature.js');
const id = '00000000-0000-4000-8000-000000000001';
// Public fixture, not a usable credential or endpoint secret.
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const url = 'https://n8n.example/webhook/example';
const root = 'https://api.example.com/api/v1/public';
const state = () => ({ konexiumWebhook: { id, secret, url, root } });
function hook(responses = [], store = state()) {
  const calls = [];
  const ctx = {
    getNode: () => ({ name: 'Konexium Trigger', typeVersion: 1 }),
    getWorkflowStaticData: () => store,
    getNodeWebhookUrl: () => url,
    getCredentials: async () => ({ baseUrl: 'https://api.example.com' }),
    helpers: {
      httpRequestWithAuthentication: async function (credential, options) {
        assert.equal(this, ctx);
        assert.equal(credential, 'konexiumApi');
        calls.push(options);
        const next = responses.shift();
        if (next instanceof Error || next?.statusCode) throw next;
        if (next === undefined && options.method !== 'DELETE')
          throw new Error('Unexpected request');
        return next;
      },
    },
  };
  return { ctx, store, calls };
}
const methods = new KonexiumTrigger().webhookMethods.default;

test('activation creates only a signed Watch endpoint and retains its secret privately', async () => {
  const { ctx, store, calls } = hook([{ id, secret }], {});
  assert.equal(await methods.create.call(ctx), true);
  assert.deepEqual(calls[0].body, {
    url,
    events: ['monitoring.change_confirmed'],
    description: 'Konexium Watch alerts for n8n',
    enabled: true,
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${root}/webhooks`);
  assert.match(calls[0].headers['Idempotency-Key'], /^n8n-/);
  assert.deepEqual(store.konexiumWebhook, { id, secret, root, url });
  assert.equal(store.konexiumRegistration, undefined);
});

test('activation validates HTTPS and fails closed when no signing secret is returned', async () => {
  const bad = hook([], {});
  bad.ctx.getNodeWebhookUrl = () => 'http://example.com';
  await assert.rejects(methods.create.call(bad.ctx), /HTTPS/);
  assert.equal(bad.calls.length, 0);
  const missing = hook([{ id }], {});
  await assert.rejects(methods.create.call(missing.ctx), /signing secret/);
  assert.equal(missing.store.konexiumWebhook.id, id, 'retain cleanup ID');
  assert.equal(missing.store.konexiumWebhook.secret, undefined);
});

test('checkExists follows every endpoint page and matches ID, URL, enabled status and event', async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}` }));
  const { ctx, calls } = hook([
    page,
    [{ id, url, enabled: true, events: ['monitoring.change_confirmed'] }],
  ]);
  assert.equal(await methods.checkExists.call(ctx), true);
  assert.deepEqual(
    calls.map((c) => c.qs),
    [
      { page: 1, pageSize: 100 },
      { page: 2, pageSize: 100 },
    ],
  );
  for (const endpoint of [
    { id, url, enabled: false, events: ['monitoring.change_confirmed'] },
    { id, url, enabled: true, events: ['webhook.test'] },
    {
      id,
      url: 'https://other.example',
      enabled: true,
      events: ['monitoring.change_confirmed'],
    },
  ]) {
    const other = hook([[endpoint]]);
    assert.equal(await methods.checkExists.call(other.ctx), false);
  }
  const absent = hook([[]]);
  assert.equal(await methods.checkExists.call(absent.ctx), false);
});

test('checkExists refuses to register duplicates when pagination is exhausted or fails', async () => {
  const page = Array.from({ length: 100 }, () => ({ id: 'other' }));
  const full = hook(Array.from({ length: 100 }, () => page));
  await assert.rejects(methods.checkExists.call(full.ctx), /pagination limit/);
  assert.equal(full.calls.length, 100);
  const failed = hook([
    Object.assign(new Error('SENSITIVE_PAYLOAD'), { statusCode: 403 }),
  ]);
  await assert.rejects(methods.checkExists.call(failed.ctx), /permissions/);
  assert.equal(failed.calls.length, 1);
});

test('checkExists needs a local signing secret and the same callback and API server', async () => {
  for (const patch of [
    { secret: undefined },
    { url: 'https://old.example/hook' },
    { root: 'https://old.example/api/v1/public' },
  ]) {
    const store = state();
    Object.assign(store.konexiumWebhook, patch);
    const { ctx, calls } = hook([], store);
    assert.equal(await methods.checkExists.call(ctx), false);
    assert.equal(calls.length, 0);
  }
});

test('deactivation deletes endpoint, clears private state; missing remote endpoint is harmless', async () => {
  for (const response of [
    null,
    Object.assign(new Error('missing'), { statusCode: 404 }),
  ]) {
    const { ctx, calls, store } = hook([response]);
    assert.equal(await methods.delete.call(ctx), true);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, `${root}/webhooks/${id}`);
    assert.deepEqual(store, {});
    await methods.delete.call(ctx);
    assert.equal(calls.length, 1);
  }
});

test('deactivation failure retains secret and ID for cleanup; server changes cannot orphan silently', async () => {
  const failed = hook([
    Object.assign(new Error('SENSITIVE_PAYLOAD'), { statusCode: 503 }),
  ]);
  await assert.rejects(methods.delete.call(failed.ctx), /unavailable/);
  assert.equal(failed.store.konexiumWebhook.id, id);
  const changed = hook();
  changed.ctx.getCredentials = async () => ({
    baseUrl: 'https://other.example',
  });
  await assert.rejects(methods.delete.call(changed.ctx), /previous API server/);
  await assert.rejects(methods.create.call(changed.ctx), /previous API server/);
  assert.equal(changed.calls.length, 0);
});

test('activation replaces a stale endpoint and retrying an uncertain registration retains its key', async () => {
  const stale = hook([null, { id, secret }]);
  await methods.create.call(stale.ctx);
  assert.deepEqual(
    stale.calls.map((c) => c.method),
    ['DELETE', 'POST'],
  );
  const retry = hook(
    [
      Object.assign(new Error('SENSITIVE_PAYLOAD'), { statusCode: 503 }),
      { id, secret },
    ],
    {},
  );
  await assert.rejects(methods.create.call(retry.ctx));
  await methods.create.call(retry.ctx);
  assert.equal(
    retry.calls[0].headers['Idempotency-Key'],
    retry.calls[1].headers['Idempotency-Key'],
  );
});

function signed(
  event = {
    type: 'monitoring.change_confirmed',
    timestamp: new Date().toISOString(),
    data: {
      watchId: id,
      companyId: id,
      kind: 'place_added',
      api: '/api/v1/public/changes',
    },
  },
  raw,
) {
  const body = raw ?? Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`msg_fixture.${timestamp}.`)
    .update(body)
    .digest('base64');
  return {
    body,
    headers: {
      'webhook-id': 'msg_fixture',
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
  };
}

test('signature validates exact bytes, headers case and multiple rotation signatures', () => {
  const { body, headers } = signed(
    undefined,
    Buffer.from(
      '{ "type": "monitoring.change_confirmed", "timestamp": "2026-11-17T00:00:00Z", "data": {"watchId":"w", "companyId":"c", "kind":"site_changed", "api":"/changes"} }',
    ),
  );
  assert.equal(verifySignature(body, headers, secret).webhookId, 'msg_fixture');
  assert.ok(
    verifySignature(
      body,
      {
        ...headers,
        'webhook-signature': `v1,${Buffer.alloc(32).toString('base64')} ${headers['webhook-signature']}`,
      },
      secret,
    ),
  );
  const upper = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toUpperCase(), value]),
  );
  assert.ok(verifySignature(body, upper, secret));
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(body)));
  assert.equal(verifySignature(reformatted, headers, secret), undefined);
});

test('signature rejects tampering, missing/raw parsed body, wrong secret, stale and future timestamps', () => {
  const { body, headers } = signed();
  for (const bad of [
    { ...headers, 'webhook-timestamp': '1' },
    {
      ...headers,
      'webhook-timestamp': String(Math.floor(Date.now() / 1000) + 301),
    },
    { ...headers, 'webhook-signature': 'v1,short' },
    { ...headers, 'webhook-id': '' },
    { ...headers, 'webhook-signature': undefined },
  ])
    assert.equal(verifySignature(body, bad, secret), undefined);
  assert.equal(
    verifySignature(Buffer.concat([body, Buffer.from(' ')]), headers, secret),
    undefined,
  );
  assert.equal(verifySignature(JSON.parse(body), headers, secret), undefined);
  assert.equal(verifySignature(undefined, headers, secret), undefined);
  assert.equal(
    verifySignature(
      body,
      headers,
      `whsec_${Buffer.alloc(32).toString('base64')}`,
    ),
    undefined,
  );
  assert.equal(verifySignature(body, headers, undefined), undefined);
  for (const payload of [
    { type: 'unknown', timestamp: new Date().toISOString(), data: {} },
    { type: 'monitoring.change_confirmed', timestamp: 'invalid', data: {} },
  ]) {
    const s = signed(payload);
    assert.equal(verifySignature(s.body, s.headers, secret), undefined);
  }
});

test('webhook rejects unsigned calls with 401, emits signed Watch data only, acknowledges webhook.test', async () => {
  const node = new KonexiumTrigger();
  for (const isTest of [false, true]) {
    const s = signed(
      isTest
        ? {
            type: 'webhook.test',
            timestamp: new Date().toISOString(),
            data: { workspaceId: id },
          }
        : undefined,
    );
    const { ctx } = hook();
    let status;
    ctx.getRequestObject = () => ({ rawBody: s.body });
    ctx.getHeaderData = () => s.headers;
    ctx.getResponseObject = () => ({
      status: (code) => {
        status = code;
        return { json: () => undefined };
      },
    });
    const result = await node.webhook.call(ctx);
    assert.equal(status, undefined);
    if (isTest) assert.equal(result.workflowData, undefined);
    else {
      assert.equal(result.workflowData[0][0].json.webhookId, 'msg_fixture');
      assert.doesNotMatch(JSON.stringify(result), /whsec_/);
    }
    ctx.getHeaderData = () => ({});
    assert.deepEqual(await node.webhook.call(ctx), { noWebhookResponse: true });
    assert.equal(status, 401);
  }
});
