import express from 'express';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const mutant = process.env.TINYSDD_PROBE_MUTANT ?? 'positive';
const allowedMutants = new Set([
  '',
  'positive',
  'stall-on-reject',
  'return-reference',
  'ttl-from-creation',
  'await-generation',
  'per-request-manager',
  'poll-resubmit',
]);
if (!allowedMutants.has(mutant)) {
  throw new Error(`unsupported TINYSDD_PROBE_MUTANT: ${mutant}`);
}

const jobsReferencePath = process.env.TINYSDD_JOBS_REFERENCE_MODULE ?? '/probes/jobs-reference.mjs';
if (!isAbsolute(jobsReferencePath)) {
  throw new Error('TINYSDD_JOBS_REFERENCE_MODULE must be an absolute path');
}
const { createJobManager } = await import(pathToFileURL(resolve(jobsReferencePath)).href);
if (typeof createJobManager !== 'function') {
  throw new Error('jobs reference must export createJobManager');
}

const baselineDir = process.env.TINYSDD_BASELINE_DIR;
if (typeof baselineDir !== 'string' || !isAbsolute(baselineDir)) {
  throw new Error('TINYSDD_BASELINE_DIR must be an absolute compiled baseline directory');
}

const { GeneratePodcastInput } = await import(
  pathToFileURL(resolve(baselineDir, 'tools/generate-podcast.js')).href,
);
const { PublishPodcastInput } = await import(
  pathToFileURL(resolve(baselineDir, 'tools/publish-podcast.js')).href,
);

const statusInput = z.object({
  jobId: z.string().uuid(),
});

const submittedExecutors = new Map();

function dualJson(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function publishText(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createGenerationExecutor(deps, input) {
  return async () => {
    const result = await deps.generate(input);
    return {
      ...result,
      downloadUrl: `${deps.publicUrl}/output/${input.outputFilename}`,
    };
  };
}

export function createMcpServer(deps) {
  let jobs = deps.jobs;
  if (mutant === 'per-request-manager') {
    jobs = createJobManager();
  }

  const server = new McpServer({
    name: 'podcast-generator-reference',
    version: '1.0.0',
  });

  server.tool(
    'generate_podcast',
    'Submit podcast generation work and poll get_job_status for the result.',
    GeneratePodcastInput.shape,
    async (input) => {
      const validated = GeneratePodcastInput.parse(input);
      const executor = createGenerationExecutor(deps, validated);

      if (mutant === 'await-generation') {
        const result = await executor();
        const accepted = jobs.submit('generate_podcast', async () => result);
        submittedExecutors.set(accepted.jobId, executor);
        return dualJson(accepted);
      }

      const accepted = jobs.submit('generate_podcast', executor);
      submittedExecutors.set(accepted.jobId, executor);
      return dualJson(accepted);
    },
  );

  server.tool(
    'get_job_status',
    'Poll the status of an accepted podcast generation job.',
    statusInput.shape,
    async ({ jobId }) => {
      if (mutant === 'poll-resubmit') {
        const executor = submittedExecutors.get(jobId);
        if (executor) jobs.submit('generate_podcast', executor);
      }

      const status = jobs.get(jobId);
      if (!status) return dualJson({ errorCode: 'job_not_found', message: 'Job not found' }, true);
      return dualJson(status);
    },
  );

  if (deps.publish) {
    server.tool(
      'publish_podcast',
      'Publish a generated podcast MP3 to configured destinations.',
      PublishPodcastInput.shape,
      async (input) => {
        try {
          const validated = PublishPodcastInput.parse(input);
          const result = await deps.publish(validated);
          return publishText(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return publishText({ success: false, error: message }, true);
        }
      },
    );
  }

  return server;
}

export function createApp({ outputDir, createServer }) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large (limit: 10mb)' });
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body', detail: error.message });
      return;
    }
    next(error);
  });

  app.use('/output', express.static(outputDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mcp-podcast-generator', version: '1.0.0' });
  });

  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    } finally {
      await transport.close().catch(() => {});
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'MCP endpoint requires POST with JSON-RPC body. See README for usage.',
    });
  });

  return app;
}
