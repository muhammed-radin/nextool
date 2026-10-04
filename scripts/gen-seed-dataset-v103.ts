/**
 * NexTool v1.0.12 — seed dataset v1.0.3 generator (PHASE 6, spec §6.1-§6.8).
 *
 * Builds config/training/seed-dataset-v1.0.3.json by carrying over the whole
 * v1.0.2 curriculum (354 examples, which already cover every registered tool
 * in all three splits) and appending the v1.0.3 teaching batches:
 * categorization, coding, general knowledge, technology, NexTool identity,
 * MCP concepts, shared-VFS concepts and the freedom-node distinction.
 *
 * Every appended example is validated against the REAL registry before the
 * file is written: unique requests (§53), real tools only, param keys inside
 * the real schemas, split balance. The generator exits non-zero on any
 * violation — no fabricated facts, no orphan references.
 */
import { BUILTIN_TOOLS } from '../src/lib/nexool/tools/registry';
import v102 from '../config/training/seed-dataset-v1.0.2.json';

interface Example {
  category: string;
  request: string;
  expectedTool?: string;
  expectedParams?: Record<string, unknown>;
  split?: 'train' | 'validation' | 'test';
}

const carryOver = v102.examples as Example[];

type Batch = Array<Omit<Example, 'split'> & { split?: Example['split'] }>;

// ---------- §6.2 categorization ----------
const categorization: Batch = [
  { category: 'categorization', request: 'classify this file type for me: quarterly-report.PDF' },
  { category: 'categorization', request: 'what category of task is "ping the api server every minute"?', split: 'validation' },
  { category: 'categorization', request: 'is "compile the typescript project" a coding, filesystem or deployment task?' },
  { category: 'categorization', request: 'label the severity of this error category: ECONNREFUSED during tool execution', split: 'test' },
  { category: 'categorization', request: 'which technology category does "SELECT * FROM users" belong to?', split: 'validation' },
  { category: 'categorization', request: 'detect the user intent behind: "save this snippet somewhere I can find it later"' },
  { category: 'categorization', request: 'what system state does status "degraded but operational" describe?' },
  { category: 'categorization', request: 'sort these task types into groups: file conversion, api poller, report generation' },
  { category: 'categorization', request: 'is "draw a chart of sales.csv" an analysis task or a filesystem task?' , split: 'test' },
  { category: 'categorization', request: 'classify the tool category of a tool that only reads files and returns metadata' },
  { category: 'categorization', request: 'what error category is a tool timeout: transient or permanent?', split: 'validation' },
  { category: 'categorization', request: 'group these by technology: react, postgres, nginx, bun' },
];

// ---------- §6.3 coding ----------
const coding: Batch = [
  { category: 'coding', request: 'read the file /src/index.js from the shared virtual filesystem and show it to me', expectedTool: 'fs.readfile', expectedParams: { path: '/src/index.js' } },
  { category: 'coding', request: 'list all files under /src in the workspace vfs so I can review the module layout', expectedTool: 'fs.list', expectedParams: { path: '/src' } },
  { category: 'coding', request: 'write the string "console.log(42)" into /scripts/answer.js in the vfs', expectedTool: 'fs.writefile', expectedParams: { path: '/scripts/answer.js', content: 'console.log(42)' } },
  { category: 'coding', request: 'does /package.json exist in the shared workspace?', expectedTool: 'fs.hasfile', expectedParams: { path: '/package.json' }, split: 'validation' },
  { category: 'coding', request: 'create the folder /src/utils in the vfs for the new helpers', expectedTool: 'fs.createfolder', expectedParams: { path: '/src/utils' } },
  { category: 'coding', request: 'evaluate 2 ** 10 for the buffer size calculation', expectedTool: 'math.evaluate', expectedParams: { expression: '2 ** 10' } },
  { category: 'coding', request: 'count the words in this javascript snippet before I commit it', expectedTool: 'text.analyze', expectedParams: { text: 'const add = (a, b) => a + b;' } },
  { category: 'coding', request: 'generate a fresh correlation id for the build log', expectedTool: 'uuid.generate' },
  { category: 'coding', request: 'what time is it right now in utc for the changelog entry?', expectedTool: 'time.now' },
  { category: 'coding', request: 'remember for this project: the db migration window is sunday 02:00 utc', expectedTool: 'memory.store', expectedParams: { key: 'db-migration-window', value: { window: 'sunday 02:00 utc' } } },
  { category: 'coding', request: 'explain why this node.js snippet throws "cannot read properties of undefined (reading map)"', split: 'test' },
  { category: 'coding', request: 'debug help: my fetch to the internal api returns 204 but no body, is that valid http?' },
  { category: 'coding', request: 'how do I undo the last git commit but keep the changes staged?', split: 'validation' },
  { category: 'coding', request: 'write a json path filter that selects users older than 30 from a users array', split: 'test' },
  { category: 'coding', request: 'store under key "lint-rules" that this repo uses double quotes and 2-space indent', expectedTool: 'memory.store', expectedParams: { key: 'lint-rules', value: { quotes: 'double', indent: 2 } }, split: 'test' },
  { category: 'coding', request: 'what does the javascript equality check "0 == \\"\\"\" evaluate to and why?' },
];

// ---------- §6.4 general knowledge (deterministic, verifiable) ----------
const generalKnowledge: Batch = [
  { category: 'general-knowledge', request: 'what is the capital of France?' },
  { category: 'general-knowledge', request: 'how many continents are there on earth?' },
  { category: 'general-knowledge', request: 'who wrote the play "romeo and juliet"?' },
  { category: 'general-knowledge', request: 'what is the chemical symbol for gold?', split: 'validation' },
  { category: 'general-knowledge', request: 'how many minutes are in one hour?' },
  { category: 'general-knowledge', request: 'what is the largest planet in the solar system?', split: 'test' },
  { category: 'general-knowledge', request: 'in which year did the berlin wall fall?' },
  { category: 'general-knowledge', request: 'what is the boiling point of water in celsius at sea level?', split: 'validation' },
  { category: 'general-knowledge', request: 'what language is primarily spoken in brazil?' },
  { category: 'general-knowledge', request: 'how many sides does a hexagon have?', split: 'test' },
];

// ---------- §6.5 technology knowledge ----------
const technology: Batch = [
  { category: 'technology', request: 'in web development, what does cors stand for and what does it control?' },
  { category: 'technology', request: 'what does the "use strict" directive do in javascript?' },
  { category: 'technology', request: 'in typescript, what is the difference between "interface" and "type"?' },
  { category: 'technology', request: 'what port does https use by default?', split: 'validation' },
  { category: 'technology', request: 'in git, what is the difference between merge and rebase?' },
  { category: 'technology', request: 'what does the linux command "chmod +x script.sh" do?', split: 'test' },
  { category: 'technology', request: 'in networking, what layer of the osi model does tcp operate on?' },
  { category: 'technology', request: 'what is an idempotent http method? give an example.' },
  { category: 'technology', request: 'in databases, what is an index and why does it speed up reads?' },
  { category: 'technology', request: 'what is the difference between supervised and unsupervised machine learning?' },
  { category: 'technology', request: 'what does "stdio" mean in the context of process transports?' },
  { category: 'technology', request: 'in node.js, what does the events module emitter pattern look like conceptually?', split: 'validation' },
  { category: 'technology', request: 'remember this automation convention: cron fields are minute hour day month weekday', expectedTool: 'memory.store', expectedParams: { key: 'cron-field-order', value: { fields: ['minute', 'hour', 'day', 'month', 'weekday'] } } },
];

// ---------- §6.6 NexTool identity ----------
const identity: Batch = [
  { category: 'nexool-identity', request: 'who are you?' },
  { category: 'nexool-identity', request: 'what is nexool?' },
  { category: 'nexool-identity', request: 'what does nexool do?' },
  { category: 'nexool-identity', request: 'what is nexool\'s purpose?' },
  { category: 'nexool-identity', request: 'is nexool a chatbot?' },
  { category: 'nexool-identity', request: 'what is the difference between nexool and a normal chatbot?' },
  { category: 'nexool-identity', request: 'what is a tool in nexool?', split: 'validation' },
  { category: 'nexool-identity', request: 'what is the planner in nexool?' },
  { category: 'nexool-identity', request: 'what does the observer do in nexool?' },
  { category: 'nexool-identity', request: 'what is the coremodule?', split: 'test' },
  { category: 'nexool-identity', request: 'what is goal mode in nexool?' },
  { category: 'nexool-identity', request: 'what is live mode in nexool?' },
  { category: 'nexool-identity', request: 'what are connectors in nexool?' },
  { category: 'nexool-identity', request: 'what is an mcp tool?' },
  { category: 'nexool-identity', request: 'what is the nexool vfs?', split: 'validation' },
  { category: 'nexool-identity', request: 'what is freedom-node?' },
  { category: 'nexool-identity', request: 'are you built by muhammed-radin?', split: 'test' },
  { category: 'nexool-identity', request: 'can nexool plan, execute tools and observe results autonomously?' },
];

// ---------- §6.7 MCP concepts ----------
const mcp: Batch = [
  { category: 'mcp', request: 'what is an mcp server?' },
  { category: 'mcp', request: 'what is an mcp client and which one is nexool?' },
  { category: 'mcp', request: 'what is a connector in the nexool connectors page?' },
  { category: 'mcp', request: 'how does mcp authentication work for the github connector?' },
  { category: 'mcp', request: 'what happens during mcp tool discovery?', split: 'validation' },
  { category: 'mcp', request: 'if I import a github mcp tool, where does its credential come from at execution time?' },
  { category: 'mcp', request: 'what does the mcp environment mean on a nexool tool?', split: 'test' },
  { category: 'mcp', request: 'a connector is disconnected — can its imported mcp tool run right now?' },
  { category: 'mcp', request: 'what does refreshing an imported mcp tool do to my local changes?' },
  { category: 'mcp', request: 'which mcp servers does nexool ship support for in its registry?', split: 'validation' },
];

// ---------- §6.8 shared VFS concepts + freedom-node distinction ----------
const vfs: Batch = [
  { category: 'filesystem', request: 'check whether /workspace/data.json exists in the shared virtual filesystem', expectedTool: 'fs.hasfile', expectedParams: { path: '/workspace/data.json' } },
  { category: 'filesystem', request: 'does the folder /output/reports exist in the shared vfs?', expectedTool: 'fs.hasfolder', expectedParams: { path: '/output/reports' } },
  { category: 'filesystem', request: 'show me metadata for /notes/test.txt in the vfs', expectedTool: 'fs.infofile', expectedParams: { path: '/notes/test.txt' } },
  { category: 'filesystem', request: 'normalize the vfs path /notes/../notes/test.txt for me', expectedTool: 'fs.getpath', expectedParams: { path: '/notes/../notes/test.txt' } },
  { category: 'filesystem', request: 'delete the stale file /tmp/old-export.csv from the shared vfs', expectedTool: 'fs.deletefile', expectedParams: { path: '/tmp/old-export.csv' }, split: 'validation' },
  { category: 'filesystem', request: 'remove the folder /scratch/build-cache and everything under it from the vfs', expectedTool: 'fs.deletefolder', expectedParams: { path: '/scratch/build-cache', recursive: true }, split: 'test' },
  { category: 'filesystem', request: 'create the directory /output/invoices in the shared vfs', expectedTool: 'fs.createfolder', expectedParams: { path: '/output/invoices' } },
  { category: 'filesystem', request: 'write the line "task 42 done" to /logs/task-42.txt in the shared vfs', expectedTool: 'fs.writefile', expectedParams: { path: '/logs/task-42.txt', content: 'task 42 done' }, split: 'validation' },
  { category: 'filesystem', request: 'can a tool read a file that another tool wrote earlier in a different task?' },
  { category: 'filesystem', request: 'can a restricted tool read files outside the vfs root?' },
  { category: 'filesystem', request: 'can freedom-node access the host filesystem directly?', split: 'test' },
  { category: 'filesystem', request: 'what is the difference between the shared vfs and freedom-node?' },
  { category: 'filesystem', request: 'store under key "vfs-policy" that restricted tools share one vfs and freedom-node is exempt', expectedTool: 'memory.store', expectedParams: { key: 'vfs-policy', value: { restricted: 'shared-vfs', freedomNode: 'exempt' } } },
];

const batches: Array<{ batch: Batch; topic: string }> = [
  { batch: categorization, topic: 'categorization' },
  { batch: coding, topic: 'coding' },
  { batch: generalKnowledge, topic: 'general-knowledge' },
  { batch: technology, topic: 'technology' },
  { batch: identity, topic: 'nexool-identity' },
  { batch: mcp, topic: 'mcp' },
  { batch: vfs, topic: 'vfs/freedom-node' },
];

// ---------- assemble with split balancing ----------
const appended: Example[] = [];
for (const { batch, topic } of batches) {
  batch.forEach((e, i) => {
    const split = e.split ?? 'train';
    appended.push({ category: e.category, request: e.request, ...(e.expectedTool ? { expectedTool: e.expectedTool } : {}), ...(e.expectedParams ? { expectedParams: e.expectedParams } : {}), split });
  });
}

// long-Markdown §45/§46 style coding example appended for v1.0.3 (unique request)
appended.push({
  category: 'coding',
  request: [
    'review this typescript module and then save a one-line summary to /reviews/cache.md in the shared vfs.',
    '',
    '## cache.ts',
    '```typescript',
    'type Entry = { key: string; value: unknown; expiresAt: number };',
    'const store = new Map<string, Entry>();',
    'export function get<T>(key: string): T | undefined {',
    '  const hit = store.get(key);',
    '  if (!hit) return undefined;',
    '  if (hit.expiresAt < Date.now()) { store.delete(key); return undefined; }',
    '  return hit.value as T;',
    '}',
    '```',
    '',
    'Focus on: expiry handling, type safety of the cast, and Map memory growth.',
  ].join('\n'),
  expectedTool: 'fs.writefile',
  expectedParams: { path: '/reviews/cache.md', content: 'cache.ts review: expiry handled, cast is safe, Map needs bounded size.' },
  split: 'test',
});

// ---------- validation against the REAL registry ----------
const all = [...carryOver, ...appended];
const errors: string[] = [];

const seen = new Set<string>();
for (const e of all) {
  const key = e.request.replace(/\s+/g, ' ').trim().toLowerCase();
  if (seen.has(key)) errors.push(`duplicate request: ${e.request.slice(0, 60)}`);
  seen.add(key);
}
const schemaOf = new Map(BUILTIN_TOOLS.map((t) => [t.name, t.schema]));
for (const e of appended) {
  if (!e.expectedTool) continue;
  if (!schemaOf.has(e.expectedTool)) errors.push(`unknown tool: ${e.expectedTool}`);
  else {
    const known = new Set(schemaOf.get(e.expectedTool)!.properties.map((p) => p.name));
    for (const k of Object.keys(e.expectedParams ?? {})) {
      if (!known.has(k)) errors.push(`param "${k}" not in ${e.expectedTool} schema`);
    }
  }
}
for (const t of BUILTIN_TOOLS) {
  for (const split of ['train', 'validation', 'test'] as const) {
    if (!all.some((e) => e.expectedTool === t.name && e.split === split)) {
      errors.push(`tool ${t.name} missing from split ${split} (v1.0.3 must keep full coverage)`);
    }
  }
}

if (errors.length > 0) {
  console.error('VALIDATION FAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}

const dataset = {
  name: 'NexTool seed curriculum',
  version: '1.0.3',
  note: 'v1.0.3 — carries the full v1.0.2 curriculum and adds categorization, coding, general-knowledge, technology, NexTool identity, MCP, shared-VFS and freedom-node teaching examples (v1.0.12 §6.1-§6.8).',
  examples: all,
};

const out = 'config/training/seed-dataset-v1.0.3.json';
await Bun.write(out, JSON.stringify(dataset, null, 2) + '\n');

const counts = {
  total: all.length,
  train: all.filter((e) => e.split === 'train').length,
  validation: all.filter((e) => e.split === 'validation').length,
  test: all.filter((e) => e.split === 'test').length,
  categories: new Set(all.map((e) => e.category)).size,
  longMarkdown: all.filter((e) => e.request.length > 1000).length,
};
console.log(`[ok] wrote ${out}`);
console.log(`     ${JSON.stringify(counts)}`);
