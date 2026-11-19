const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

test('publish metadata contains MIT brand identity, expected nodes and no runtime dependencies', () => {
  assert.equal(pkg.name, 'n8n-nodes-konexium');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.author, {
    name: 'Konexium',
    email: 'hello@konexiumai.com',
  });
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.ok(
    !pkg.optionalDependencies ||
      Object.keys(pkg.optionalDependencies).length === 0,
  );
  assert.equal(pkg.n8n.strict, true);
  assert.deepEqual(pkg.peerDependencies, { 'n8n-workflow': '*' });
  for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials])
    assert.equal(fs.existsSync(path.join(root, file)), true);
  for (const name of ['Konexium', 'KonexiumTrigger']) {
    assert.equal(fs.existsSync(path.join(root, `dist/nodes/Konexium/${name}.node.json`)), true);
  }
  assert.equal(
    fs.existsSync(path.join(root, 'dist/nodes/Konexium/konexium.svg')),
    true,
  );
  assert.equal(pkg.repository.url, 'git+https://github.com/Konexium/n8n-nodes-konexium.git');
  assert.equal(pkg.author.name, 'Konexium');
  assert.equal(pkg.publishConfig.provenance, true);
});

test('both recipes are inactive, connected, and have placeholder credentials', () => {
  for (const file of ['suppliers-sheet.json', 'watch-to-slack.json']) {
    const workflow = JSON.parse(
      fs.readFileSync(path.join(root, 'examples', file), 'utf8'),
    );
    assert.equal(workflow.active, false);
    const names = new Set(workflow.nodes.map((n) => n.name));
    for (const [from, edges] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from));
      for (const outputs of edges.main)
        for (const edge of outputs) assert.ok(names.has(edge.node));
    }
    for (const node of workflow.nodes)
      for (const credential of Object.values(node.credentials || {}))
        assert.equal(credential.id, 'REPLACE_WITH_CREDENTIAL_ID');
    assert.ok(
      workflow.nodes.some((n) => n.type.startsWith('n8n-nodes-konexium.')),
    );
  }
});

test('strict lint configuration matches the pinned official n8n CLI template', () => {
  const normalize = (text) => text.replace(/\s+/g, ' ').trim();
  const official = fs.readFileSync(path.resolve(path.dirname(require.resolve('@n8n/node-cli/eslint')), '../template/templates/shared/default/eslint.config.mjs'), 'utf8');
  assert.equal(normalize(fs.readFileSync(path.join(root, 'eslint.config.mjs'), 'utf8')), normalize(official));
});

test('sheet recipe writes the original supplier ID and deduplicates source URLs', () => {
  const workflow = require('../examples/suppliers-sheet.json');
  const write = workflow.nodes.find(
    (node) => node.name === 'Write verdict and sources',
  );
  assert.deepEqual(write.parameters.columns.matchingColumns, ['Supplier ID']);
  assert.match(write.parameters.columns.value['Supplier ID'], /Read suppliers/);
  const expression = write.parameters.columns.value.Sources.slice(3, -2);
  const evaluate = new Function('$json', `return (${expression})`);
  assert.equal(
    evaluate({
      rows: [
        {
          verdicts: [
            { url: 'https://example.com/a' },
            { url: 'https://example.com/a' },
          ],
          registry: { source_url: 'https://register.example/1' },
        },
      ],
    }),
    'https://example.com/a\nhttps://register.example/1',
  );
});

test('published runtime has no filesystem, environment, SDK or direct HTTP access', () => {
  function walk(dir) {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : [path.join(dir, entry.name)],
      );
  }
  for (const file of walk(path.join(root, 'dist')).filter((f) =>
    f.endsWith('.js'),
  )) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      text,
      /process\.env|require\(["'](?:node:)?(?:fs|http|https|child_process)|\bfetch\(|@konexium\//,
    );
  }
});

test('action node is usable as an AI agent tool; trigger is not', () => {
  const { Konexium } = require('../dist/nodes/Konexium/Konexium.node.js');
  const { KonexiumTrigger } = require('../dist/nodes/Konexium/KonexiumTrigger.node.js');
  assert.equal(new Konexium().description.usableAsTool, true);
  assert.equal(new KonexiumTrigger().description.usableAsTool, undefined);
});
