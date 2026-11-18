import { createHash } from 'node:crypto';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import {
  apiRequest,
  object,
  requireId,
  requireInteger,
  requireText,
  safeNodeError,
} from './transport';

/** Same execution, item and input give the same key, so an n8n retry reuses the run. */
function derivedKey(
  context: IExecuteFunctions,
  index: number,
  parts: string[],
): string {
  const execution =
    typeof context.getExecutionId === 'function' ? context.getExecutionId() : '';
  const digest = createHash('sha256')
    .update(JSON.stringify([execution, index, ...parts]))
    .digest('hex');
  return `n8n-${digest.slice(0, 40)}`;
}

export class Konexium implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Konexium',
    name: 'konexium',
    icon: { light: 'file:konexium.svg', dark: 'file:konexium.svg' },
    group: ['transform'],
    version: 1,
    // AI agents may call Check and Watch. Spend stays bounded: a Check holds at
    // most 16 credits, the API stops at zero credits, and identical calls in one
    // execution share a derived idempotency key.
    usableAsTool: true,
    subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
    description:
      'Check African companies with sourced evidence and manage Watch',
    defaults: { name: 'Konexium' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'konexiumApi', required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'company',
        options: [
          { name: 'Company', value: 'company' },
          { name: 'Watch', value: 'watch' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'check',
        displayOptions: { show: { resource: ['company'] } },
        options: [
          {
            name: 'Check',
            value: 'check',
            description:
              'Check one company and wait for its evidence-backed result',
            action: 'Check a company',
          },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'add',
        displayOptions: { show: { resource: ['watch'] } },
        options: [
          {
            name: 'Add',
            value: 'add',
            description: 'Watch an existing workspace company',
            action: 'Add a watch',
          },
          {
            name: 'List',
            value: 'list',
            description: 'List all workspace watches',
            action: 'List watches',
          },
        ],
      },
      {
        displayName:
          'Live checks hold up to 16 credits: Ready costs 16, not matched or needs review costs 2. Test keys use 0 credits.',
        name: 'costNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { resource: ['company'] } },
      },
      {
        displayName: 'Company Name',
        name: 'companyName',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { resource: ['company'] } },
        description:
          'Submitted company name; Konexium checks the website identity against it',
      },
      {
        displayName: 'Country',
        name: 'country',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'NG',
        displayOptions: { show: { resource: ['company'] } },
        description: 'Two-letter ISO country code',
      },
      {
        displayName: 'Sector',
        name: 'sector',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'Logistics',
        displayOptions: { show: { resource: ['company'] } },
        description:
          'Expected sector. The current Check API requires at least one sector.',
      },
      {
        displayName: 'Idempotency Key',
        name: 'idempotencyKey',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['company'] } },
        description:
          'Optional. Leave empty and the node derives one from this execution, item and company, so retries never charge twice. Set your own 8–100 character key to deduplicate across executions.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['company'] } },
        options: [
          {
            displayName: 'Registration Number',
            name: 'registrationNumber',
            type: 'string',
            default: '',
            description:
              'Optional, up to 60 characters. Checks whether the company website states this number; does not perform an exact registry-number lookup.',
          },
          {
            displayName: 'Wait Timeout (Seconds)',
            name: 'waitSeconds',
            type: 'number',
            default: 120,
            typeOptions: { minValue: 10, maxValue: 300 },
            description:
              'Maximum time for starting and polling. A timeout does not cancel server work.',
          },
          {
            displayName: 'Website',
            name: 'website',
            type: 'string',
            default: '',
            placeholder: 'https://example.com',
            description:
              'Company website. If omitted, Konexium attempts discovery using the name and country.',
          },
        ],
      },
      {
        displayName: 'Workspace Company ID',
        name: 'workspaceCompanyId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { resource: ['watch'], operation: ['add'] } },
        description:
          'Workspace company ID (workspaceCompanyId) from the public companies API. A canonical company ID is not interchangeable.',
      },
      {
        displayName: 'Cadence (Days)',
        name: 'cadenceDays',
        type: 'number',
        default: 7,
        typeOptions: { minValue: 1, maxValue: 30 },
        displayOptions: { show: { resource: ['watch'], operation: ['add'] } },
        description: 'Days between scheduled Watch checks',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < this.getInputData().length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;
        if (resource === 'company' && operation === 'check') {
          const name = requireText(
            this,
            this.getNodeParameter('companyName', i),
            'Company name',
            200,
          );
          const country = requireText(
            this,
            this.getNodeParameter('country', i),
            'Country',
            2,
          ).toUpperCase();
          if (!/^[A-Z]{2}$/.test(country))
            throw new NodeOperationError(
              this.getNode(),
              'Country must be a two-letter ISO code.',
            );
          const sector = requireText(
            this,
            this.getNodeParameter('sector', i),
            'Sector',
            120,
          );
          const given = this.getNodeParameter('idempotencyKey', i, '');
          const options = object(this.getNodeParameter('options', i));
          const key =
            typeof given === 'string' && given.trim()
              ? requireText(this, given, 'Idempotency key', 100)
              : derivedKey(this, i, [
                  name,
                  country,
                  sector,
                  String(options.website ?? ''),
                  String(options.registrationNumber ?? ''),
                ]);
          if (!/^[\x21-\x7e]{8,100}$/.test(key))
            throw new NodeOperationError(
              this.getNode(),
              'Idempotency key must contain 8–100 printable ASCII characters without spaces.',
            );
          const wait = requireInteger(
            this,
            options.waitSeconds ?? 120,
            'Wait timeout',
            10,
            300,
          );
          const row: IDataObject = { name, country };
          if (options.website)
            row.website = requireText(this, options.website, 'Website', 300);
          const criteria: IDataObject = {
            countries: [country],
            industries: [sector],
          };
          if (options.registrationNumber) {
            const number = requireText(
              this,
              options.registrationNumber,
              'Registration number',
              60,
            );
            const requirement = `The company states its registration number is ${JSON.stringify(number)}.`;
            if (requirement.length > 120)
              throw new NodeOperationError(
                this.getNode(),
                'Registration number contains too many escaped characters for the API requirement limit.',
              );
            criteria.mustHaves = [requirement];
          }
          const deadline = Date.now() + wait * 1000;
          let run = await apiRequest<IDataObject>(
            this,
            'POST',
            '/bulk-verify',
            {
              body: { rows: [row], criteria, idempotencyKey: key },
              idempotencyKey: key,
              timeout: Math.min(30_000, wait * 1000),
            },
          );
          const id = requireId(this, run.id);
          while (run.status === 'queued' || run.status === 'running') {
            if (deadline - Date.now() <= 3000) {
              throw new NodeOperationError(
                this.getNode(),
                `Check wait expired. Run ${id} continues on the server. Retry with the same idempotency key or retrieve this run using the public API.`,
              );
            }
            await sleep(3000);
            run = await apiRequest<IDataObject>(
              this,
              'GET',
              `/bulk-verify/${id}`,
              { timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) },
            );
          }
          if (
            !Array.isArray(run.rows) ||
            run.rows.length !== 1 ||
            typeof run.status !== 'string'
          ) {
            throw new NodeOperationError(
              this.getNode(),
              'Konexium returned an unexpected check result. Retrieve the run before retrying.',
            );
          }
          output.push({ json: run, pairedItem: { item: i } });
        } else if (resource === 'watch' && operation === 'add') {
          const workspaceCompanyId = requireId(
            this,
            this.getNodeParameter('workspaceCompanyId', i),
          );
          const cadenceDays = requireInteger(
            this,
            this.getNodeParameter('cadenceDays', i),
            'Cadence',
            1,
            30,
          );
          const result = await apiRequest<IDataObject>(
            this,
            'POST',
            '/watches',
            { body: { workspaceCompanyId, cadenceDays } },
          );
          if (
            !['watching', 'already_watching'].includes(String(result.status))
          ) {
            throw new NodeOperationError(
              this.getNode(),
              'Konexium could not add the watch. Confirm the workspace company has a website and the watch limit has not been reached.',
            );
          }
          output.push({ json: result, pairedItem: { item: i } });
        } else if (resource === 'watch' && operation === 'list') {
          // GET watches returns a complete array, not a paginated envelope.
          const watches = await apiRequest<IDataObject[]>(
            this,
            'GET',
            '/watches',
          );
          if (!Array.isArray(watches))
            throw new NodeOperationError(
              this.getNode(),
              'Konexium returned an unexpected watch list.',
            );
          output.push(
            ...watches.map((json) => ({ json, pairedItem: { item: i } })),
          );
        } else {
          throw new NodeOperationError(
            this.getNode(),
            'Select a supported Konexium operation.',
          );
        }
      } catch (error) {
        const failure = safeNodeError(this, error);
        if (!this.continueOnFail()) throw failure;
        output.push({
          json: {
            error: failure.message,
          },
          pairedItem: { item: i },
        });
      }
    }
    return [output];
  }
}
