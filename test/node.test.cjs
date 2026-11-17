const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Konexium } = require('../dist/nodes/Konexium/Konexium.node.js');
const {
  KonexiumApi,
} = require('../dist/credentials/KonexiumApi.credentials.js');

const id = '00000000-0000-4000-8000-000000000001';
const ready = {
  id,
  status: 'done',
  actualCredits: 0,
  sandbox: true,
  rows: [
    {
      outcome: 'ready',
      verdicts: [{ quote: 'Fixture', url: 'https://ready.example/about' }],
      field_trace: { name: { source_type: 'SUBMITTED' } },
    },
  ],
};
function context(params = {}, responses = [ready], count = 1, fail = false) {
  const calls = [];
  const values = {
    resource: 'company',
    operation: 'check',
    companyName: 'Example Supplier',
    country: 'ng',
    sector: 'Logistics',
    idempotencyKey: 'supplier-row-001-v1',
    options: {},
    ...params,
  };
  const ctx = {
    getInputData: () => Array.from({ length: count }, () => ({ json: {} })),
    getNodeParameter: (name, index) =>
      typeof values[name] === 'function' ? values[name](index) : values[name],
    getCredentials: async (name) => {
      assert.equal(name, 'konexiumApi');
      return { baseUrl: 'https://api.example.com/' };
    },
    getNode: () => ({ name: 'Konexium', typeVersion: 1 }),
    continueOnFail: () => fail,
    helpers: {
      httpRequestWithAuthentication: async function (credential, request) {
        assert.equal(this, ctx);
        assert.equal(credential, 'konexiumApi');
        calls.push(request);
        const response = responses.shift();
        if (response instanceof Error || response?.statusCode) throw response;
        if (response === undefined) throw new Error('Unexpected mock request');
        return response;
      },
    },
  };
  return { ctx, calls };
}

test('credential sends Bearer auth and tests the zero-credit authenticated me endpoint', () => {
  const c = new KonexiumApi();
  assert.equal(c.name, 'konexiumApi');
  assert.equal(
    c.authenticate.properties.headers.Authorization,
    '=Bearer {{$credentials.apiKey}}',
  );
  assert.equal(c.test.request.method, 'GET');
  assert.equal(c.test.request.url, '/api/v1/public/me');
  const credentialBase = new Function('$credentials', `return (${c.test.request.baseURL.slice(3, -2)})`);
  assert.equal(credentialBase({ baseUrl: 'https://api.example.com/' }), 'https://api.example.com');
  assert.equal(credentialBase({ baseUrl: 'https://api.example.com' }), 'https://api.example.com');
  assert.equal(
    c.properties.find((p) => p.name === 'baseUrl').default,
    'https://api.konexiumai.com',
  );
  assert.match(c.properties[0].description, /0 credits/);
});

test('Check sends one named row, criteria and matching header/body key; preserves the full result', async () => {
  const { ctx, calls } = context({
    options: { website: 'https://ready.example', registrationNumber: 'RC-123' },
  });
  const result = await new Konexium().execute.call(ctx);
  assert.deepEqual(result, [[{ json: ready, pairedItem: { item: 0 } }]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].url,
    'https://api.example.com/api/v1/public/bulk-verify',
  );
  assert.deepEqual(calls[0].body, {
    rows: [
      {
        name: 'Example Supplier',
        country: 'NG',
        website: 'https://ready.example',
      },
    ],
    criteria: {
      countries: ['NG'],
      industries: ['Logistics'],
      mustHaves: ['The company states its registration number is "RC-123".'],
    },
    idempotencyKey: 'supplier-row-001-v1',
  });
  assert.equal(
    calls[0].headers['Idempotency-Key'],
    calls[0].body.idempotencyKey,
  );
  assert.equal(calls[0].disableFollowRedirect, true);
  assert.equal(calls[0].timeout, 30000);
  assert.equal(calls[0].json, true);
  assert.equal(
    calls[0].headers.Authorization,
    undefined,
    'n8n handles authentication',
  );
});

test('name-only Check omits website and preserves each input pairing', async () => {
  const { ctx, calls } = context(
    { companyName: (i) => `Supplier ${i}` },
    [ready, ready],
    2,
  );
  const [result] = await new Konexium().execute.call(ctx);
  assert.equal(calls[0].body.rows[0].website, undefined);
  assert.equal(calls[1].body.rows[0].name, 'Supplier 1');
  assert.deepEqual(
    result.map((r) => r.pairedItem.item),
    [0, 1],
  );
});

async function settleWithClock(t, promise, count = 110) {
  let done = false;
  let result;
  let failure;
  promise.then(
    (value) => {
      result = value;
      done = true;
    },
    (error) => {
      failure = error;
      done = true;
    },
  );
  for (let i = 0; i < count && !done; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(3000);
  }
  await new Promise(setImmediate);
  assert.equal(done, true, 'bounded operation must settle');
  if (failure) throw failure;
  return result;
}

test('Check polls queued/running runs to completion with finite request timeouts', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { ctx, calls } = context({}, [
    { id, status: 'queued' },
    { id, status: 'running' },
    ready,
  ]);
  const result = await settleWithClock(t, new Konexium().execute.call(ctx));
  assert.deepEqual(result[0][0].json, ready);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST', 'GET', 'GET'],
  );
  assert.equal(
    calls[1].url,
    `https://api.example.com/api/v1/public/bulk-verify/${id}`,
  );
  assert.ok(calls.every((c) => c.timeout > 0 && c.timeout <= 30000));
});

test('Check timeout never restarts or cancels paid work, and reports the recoverable run ID', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { ctx, calls } = context(
    { options: { waitSeconds: 10 } },
    Array.from({ length: 6 }, () => ({ id, status: 'running' })),
  );
  await assert.rejects(
    settleWithClock(t, new Konexium().execute.call(ctx)),
    (e) => e.message.includes(id) && /same idempotency key/.test(e.message),
  );
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(
    calls.some((c) => c.method === 'DELETE'),
    false,
  );
  assert.ok(calls.length <= 4);
});

test('a polling HTTP failure does not resubmit the check', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const failure = Object.assign(new Error('SENSITIVE_PAYLOAD'), {
    statusCode: 429,
  });
  const { ctx, calls } = context({}, [{ id, status: 'running' }, failure]);
  await assert.rejects(
    settleWithClock(t, new Konexium().execute.call(ctx)),
    /rate limit/,
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST', 'GET'],
  );
});

test('Check keeps needs-review and unavailable evidence outcomes as API data', async () => {
  for (const outcome of [
    'needs_you',
    'could_not_check',
    'needs_website',
    'not_matched',
  ]) {
    const run = {
      ...ready,
      rows: [{ outcome, verdicts: [], next_step: 'Review' }],
    };
    const { ctx } = context({}, [run]);
    assert.deepEqual((await new Konexium().execute.call(ctx))[0][0].json, run);
  }
});

test('invalid Check parameters fail before HTTP requests', async () => {
  for (const params of [
    { country: 'Nigeria' },
    { sector: '' },
    { idempotencyKey: 'short' },
    { idempotencyKey: 'bad key with spaces' },
    { options: { waitSeconds: 301 } },
    { options: { registrationNumber: 'x'.repeat(61) } },
  ]) {
    const { ctx, calls } = context(params);
    await assert.rejects(new Konexium().execute.call(ctx));
    assert.equal(calls.length, 0);
  }
});

test('unsafe base URL is rejected without disclosing its contents', async () => {
  for (const baseUrl of [
    'https://user:private@example.com',
    'http://remote.example',
    'https://example.com/path',
    'https://example.com?private=yes',
  ]) {
    const { ctx, calls } = context();
    ctx.getCredentials = async () => ({ baseUrl });
    await assert.rejects(
      new Konexium().execute.call(ctx),
      (error) => !error.message.includes('private'),
    );
    assert.equal(calls.length, 0);
  }
});

test('Watch Add uses the workspace UUID and cadence and accepts idempotent existing watches', async () => {
  for (const status of ['watching', 'already_watching']) {
    const { ctx, calls } = context(
      {
        resource: 'watch',
        operation: 'add',
        workspaceCompanyId: id,
        cadenceDays: 3,
      },
      [{ workspaceCompanyId: id, status, watch: { id } }],
    );
    const [[result]] = await new Konexium().execute.call(ctx);
    assert.equal(result.json.status, status);
    assert.equal(calls[0].url, 'https://api.example.com/api/v1/public/watches');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { workspaceCompanyId: id, cadenceDays: 3 });
  }
});

test('Watch Add rejects invalid UUID/cadence locally and maps unsuccessful semantic outcomes', async () => {
  for (const params of [
    { workspaceCompanyId: '../other' },
    { cadenceDays: 31 },
  ]) {
    const { ctx, calls } = context({
      resource: 'watch',
      operation: 'add',
      workspaceCompanyId: id,
      cadenceDays: 7,
      ...params,
    });
    await assert.rejects(new Konexium().execute.call(ctx));
    assert.equal(calls.length, 0);
  }
  const { ctx } = context(
    {
      resource: 'watch',
      operation: 'add',
      workspaceCompanyId: id,
      cadenceDays: 7,
    },
    [{ status: 'invalid_company' }],
  );
  await assert.rejects(
    new Konexium().execute.call(ctx),
    /could not add the watch/,
  );
});

test('Watch List returns every watch with item pairing in one request; handles empty list', async () => {
  for (const watches of [
    [],
    [{ id }, { id: 'other', field_trace: { source: 'preserved' } }],
  ]) {
    const { ctx, calls } = context({ resource: 'watch', operation: 'list' }, [
      watches,
    ]);
    const [result] = await new Konexium().execute.call(ctx);
    assert.deepEqual(
      result.map((r) => r.json),
      watches,
    );
    assert.ok(result.every((r) => r.pairedItem.item === 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].qs, undefined);
  }
});

test('every action maps HTTP errors without exposing raw request/response details and does not retry', async () => {
  for (const params of [
    {},
    { resource: 'watch', operation: 'list' },
    {
      resource: 'watch',
      operation: 'add',
      workspaceCompanyId: id,
      cadenceDays: 7,
    },
  ]) {
    for (const statusCode of [
      400, 401, 402, 403, 404, 409, 422, 429, 500, 503,
    ]) {
      const sensitiveError = Object.assign(new Error('SENSITIVE_PAYLOAD'), {
        statusCode,
        response: { data: 'SENSITIVE_PAYLOAD' },
        options: { headers: { Authorization: 'SENSITIVE_PAYLOAD' } },
      });
      const { ctx, calls } = context(params, [sensitiveError]);
      await assert.rejects(new Konexium().execute.call(ctx), (error) => {
        assert.doesNotMatch(
          JSON.stringify(error) + error.message + error.stack,
          /SENSITIVE_PAYLOAD/,
        );
        assert.match(error.message, /Konexium/);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('continue-on-fail emits a sanitized error and keeps processing remaining items', async () => {
  const error = Object.assign(new Error('SENSITIVE_PAYLOAD'), {
    statusCode: 401,
  });
  const { ctx } = context({}, [error, ready], 2, true);
  const [result] = await new Konexium().execute.call(ctx);
  assert.match(result[0].json.error, /authentication failed/);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_PAYLOAD/);
  assert.deepEqual(result[1], { json: ready, pairedItem: { item: 1 } });
});

test('network errors are sanitized without exposing the helper error', async () => {
  const { ctx, calls } = context({}, [new Error('SENSITIVE_PAYLOAD')]);
  await assert.rejects(new Konexium().execute.call(ctx), (error) => {
    assert.match(error.message, /connectivity/);
    assert.doesNotMatch(
      JSON.stringify(error) + error.stack,
      /SENSITIVE_PAYLOAD/,
    );
    return true;
  });
  assert.equal(calls.length, 1);
});

test('malformed run and watch list fail clearly', async () => {
  for (const [params, response] of [
    [{}, { id, status: 'done', rows: [] }],
    [{ resource: 'watch', operation: 'list' }, { items: [] }],
  ]) {
    const { ctx } = context(params, [response]);
    await assert.rejects(new Konexium().execute.call(ctx), /unexpected/);
  }
});

test('an empty idempotency key is derived from execution, item and input, and is stable on retry', async () => {
  const keys = [];
  for (const execution of ['exec-1', 'exec-1', 'exec-2']) {
    const { ctx, calls } = context({ idempotencyKey: '' });
    ctx.getExecutionId = () => execution;
    await new Konexium().execute.call(ctx);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[0].body.idempotencyKey);
    keys.push(calls[0].headers['Idempotency-Key']);
  }
  assert.match(keys[0], /^n8n-[a-f0-9]{40}$/);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  const { ctx, calls } = context({ idempotencyKey: '', companyName: 'Other Supplier' });
  ctx.getExecutionId = () => 'exec-1';
  await new Konexium().execute.call(ctx);
  assert.notEqual(calls[0].headers['Idempotency-Key'], keys[0]);
});
