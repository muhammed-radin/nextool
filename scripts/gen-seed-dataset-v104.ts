/**
 * NexTool v1.0.15 — seed dataset v1.0.4 generator (spec §1-§9, §50-§57).
 *
 * Builds config/training/seed-dataset-v1.0.4.json by carrying over the whole
 * v1.0.3 curriculum (447 examples, every registered tool in all three splits)
 * and appending the v1.0.15 teaching batches:
 *
 *   §2  coding (fundamentals, algorithms, data structures, debugging, code
 *       reading/generation/modification/refactoring, APIs, modules, deps,
 *       async, concurrency, error handling, testing, architecture, CLI, fs
 *       programming, networking, databases, web/backend/frontend, automation)
 *   §3  error understanding (machine + human phrasing; error → cause → fix →
 *       appropriate tool)
 *   §4  general knowledge (science, technology, computers, engineering,
 *       mathematics, logic, everyday concepts, geography/history, practical)
 *   §5  coding languages (JavaScript, TypeScript, Python, C, C++, C#, Java,
 *       Rust, Go, PHP, SQL, HTML, CSS, Shell — identify language/syntax/
 *       structure/intent/errors/tooling/runtime)
 *   §6  generative + creative intelligence (AskSelf selection for generation
 *       vs execution vs explanation)
 *   §7  complex content (long/multi-step instructions, nested conditions,
 *       constraints, relationships, priorities, corrections)
 *   §8  pattern understanding (A→B→C, if/unless/before/after, error→recovery,
 *       JSON/execution/planning/event patterns)
 *   §9  self understanding (NexTool identity, purpose, subsystems, built by
 *       Muhammed Radin — paraphrases, not one memorized sentence)
 *   §10 PCB design · §11 electronic components · §12 electricity
 *   §13 software engineering · §14 computer engineering · §15 design
 *   §16 intelligent improvement (correction → updated behavior)
 *   §17/§18 tool understanding (tool title + BODY + schema + environment;
 *       all tool categories incl. MCP boundaries)
 *   §19 AskSelf teaching · (AskForUser) §50 user events
 *   §51 terminal environments (fs real FS vs vfs vs freedom-node)
 *   §52 approval states (accepted → continue, skipped → alternative,
 *       rejected → revise plan/stop)
 *   §54 intelligent-improvement failure data · §55 JSON understanding
 *   §56 rich text understanding · planner/recovery (§21)
 *
 * Every appended example is validated against the REAL registry before the
 * file is written: unique requests (§53), real tools only, param keys inside
 * the real schemas, enum membership, split balance, per-tool 3-split coverage.
 * The generator exits non-zero on any violation — no fabricated facts.
 */
import { BUILTIN_TOOLS } from '../src/lib/nexool/tools/registry';
import v103 from '../config/training/seed-dataset-v1.0.3.json';

interface Example {
  category: string;
  request: string;
  expectedTool?: string;
  expectedParams?: Record<string, unknown>;
  split?: 'train' | 'validation' | 'test';
}

const carryOver = v103.examples as Example[];

type Batch = Array<Omit<Example, 'split'> & { split?: Example['split'] }>;

// ---------- §2 coding (expanded: fundamentals → automation) ----------
const coding: Batch = [
  { category: 'coding', request: 'explain the difference between an array and a linked list for our build notes', split: 'validation' },
  { category: 'coding', request: 'what is big-o notation of a binary search over a sorted array?' },
  { category: 'coding', request: 'save this algorithm note under key "algo-cache": quicksort average complexity is n log n, worst is n^2', expectedTool: 'memory.store', expectedParams: { key: 'algo-cache', value: { algorithm: 'quicksort', average: 'n log n', worst: 'n^2' } } },
  { category: 'coding', request: 'generate four possible names for the new helper module that wraps date formatting', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate four possible names for a helper module that wraps date formatting.', pattern: 'list of four short module names' }, split: 'test' },
  { category: 'coding', request: 'explain why this promise chain never resolves: the then callback returns but nothing is awaited' },
  { category: 'coding', request: 'read /src/utils/retry.ts from the shared vfs so I can review the backoff logic', expectedTool: 'fs.readfile', expectedParams: { path: '/src/utils/retry.ts' } },
  { category: 'coding', request: 'write a debounce implementation snippet to /snippets/debounce.js in the vfs', expectedTool: 'fs.writefile', expectedParams: { path: '/snippets/debounce.js', content: 'function debounce(fn, wait) {\n  let t;\n  return (...args) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), wait);\n  };\n}' } },
  { category: 'coding', request: 'list the modules under /src/lib in the workspace so I can plan the refactor', expectedTool: 'fs.list', expectedParams: { path: '/src/lib' } },
  { category: 'coding', request: 'how many words are in this commit message: "fix auth race when refreshing expired tokens"', expectedTool: 'text.analyze', expectedParams: { text: 'fix auth race when refreshing expired tokens' } },
  { category: 'coding', request: 'compute the number of milliseconds in 3 days for the retry budget constant', expectedTool: 'math.evaluate', expectedParams: { expression: '3 * 24 * 60 * 60 * 1000' } },
  { category: 'coding', request: 'remember for the team: dependency updates only run on thursdays and require two reviewers', expectedTool: 'memory.store', expectedParams: { key: 'dependency-update-policy', value: { day: 'thursday', reviewers: 2 } } },
  { category: 'coding', request: 'refactor plan: what should I extract first from a 900-line function that mixes parsing and io?' },
  { category: 'coding', request: 'what does the api term "rate limiting with exponential backoff" mean and when should a client retry?' },
  { category: 'coding', request: 'is a 204 response with a content-length header valid http for our api review?', split: 'validation' },
  { category: 'coding', request: 'what is the difference between process.stdout.write and console.log in node.js automation scripts?' },
  { category: 'coding', request: 'generate three test case ideas for a function that parses iso dates', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate three test case ideas for a function that parses ISO date strings.' } },
  { category: 'coding', request: 'when designing a task queue, which data structure fits fifo scheduling and why?' },
  { category: 'coding', request: 'explain how a connection pool prevents socket exhaustion under load' },
  { category: 'coding', request: 'write the react component skeleton for a settings toggle into /drafts/toggle.tsx in the vfs', expectedTool: 'fs.writefile', expectedParams: { path: '/drafts/toggle.tsx', content: 'export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {\n  return <button role="switch" aria-checked={on} onClick={() => onChange(!on)}>{on ? \'On\' : \'Off\'}</button>;\n}' }, split: 'validation' },
  { category: 'coding', request: 'what is the difference between a race condition and a deadlock in concurrent programming?' , split: 'test' },
];

// ---------- §3 error understanding (machine + human phrasing) ----------
const errors: Batch = [
  { category: 'errors', request: 'explain this stack trace: "TypeError: Cannot read properties of undefined (reading \'map\') at render (app/page.tsx:41)"' },
  { category: 'errors', request: 'the api returns "HTTP 429 Too Many Requests" — what causes it and how should the caller react?', split: 'validation' },
  { category: 'errors', request: 'our build fails with "Module not found: Error: Cannot resolve \'lodash\'" — what is the likely cause and fix?' },
  { category: 'coding', request: 'log the incident summary to /logs/econnrefused-incident.md in the vfs: connection refused on api-01, port 5432, likely postgres down', expectedTool: 'fs.writefile', expectedParams: { path: '/logs/econnrefused-incident.md', content: '# ECONNREFUSED incident\n\nTarget: api-01:5432. Connection refused — the postgres service is likely down. Action: verify service, restart if stopped.' }, split: 'test' },
  { category: 'errors', request: 'what does a compiler error "expected \';\' before } token" in c++ mean and how do I locate it?' },
  { category: 'errors', request: 'dependency error: peer dependency conflict between react 18 and react 17 — what are the resolution options?' },
  { category: 'errors', request: 'explain the filesystem error EACCES: permission denied when writing to /var/log/app.log' },
  { category: 'errors', request: 'network error ETIMEDOUT during a fetch — transient or permanent, and what should the retry policy be?', split: 'validation' },
  { category: 'errors', request: 'what is the difference between a 401 unauthorized and a 403 forbidden http error?' },
  { category: 'errors', request: 'tool execution failed with TOOL_TIMEOUT after 30 seconds — what are the recovery options in a nexool plan?' },
  { category: 'errors', request: 'validation error: expected number, received string "5" for field retries — should the caller coerce or reject?' },
  { category: 'errors', request: 'configuration error: missing DATABASE_URL environment variable at startup — what is the structured way to fail?' },
  { category: 'errors', request: 'auth error "invalid_grant" from the oauth token refresh — what does it mean for stored credentials?' },
  { category: 'errors', request: 'explain this runtime error: "RangeError: Maximum call stack size exceeded" and give the two most common causes' },
  { category: 'errors', request: 'syntax error on line 12: unexpected end of input in my javascript — what usually causes it?' },
  { category: 'errors', request: 'our health check reports 503 while the process is running — what is the likely cause chain?', split: 'test' },
  { category: 'errors', request: 'remember the incident fix: 502 from nginx meant the upstream node process crashed, fix was raising the memory limit', expectedTool: 'memory.store', expectedParams: { key: 'incident-502-fix', value: { symptom: 'nginx 502', cause: 'upstream node crash', fix: 'raise memory limit' } } },
  { category: 'errors', request: 'recall the stored fix for the nginx 502 incident so I can apply it again', expectedTool: 'memory.recall', expectedParams: { key: 'incident-502-fix' } },
  { category: 'errors', request: 'what does EPIPE mean when a process writes to a closed pipe?' },
  { category: 'errors', request: 'explain "ENOENT: no such file or directory, open /tmp/config.json" and the two-step fix' },
  { category: 'errors', request: 'send a warning notification titled "build failed" with body "typescript errors in 3 files after the merge"', expectedTool: 'notification.send', expectedParams: { title: 'build failed', body: 'typescript errors in 3 files after the merge', level: 'warning' } },
  { category: 'errors', request: 'the deploy failed again with the same rollup circular dependency error — generate three alternative fixes', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate three alternative fixes for a rollup circular dependency build error.' } },
];

// ---------- §4 general knowledge expansion ----------
const generalKnowledge: Batch = [
  { category: 'general-knowledge', request: 'what force keeps planets in orbit around the sun?' },
  { category: 'general-knowledge', request: 'what is the powerhouse of the cell?', split: 'validation' },
  { category: 'general-knowledge', request: 'how many bits are in one byte?' },
  { category: 'general-knowledge', request: 'what is the capital of japan?' },
  { category: 'general-knowledge', request: 'in what year did the first human land on the moon?', split: 'test' },
  { category: 'general-knowledge', request: 'what is the freezing point of water in fahrenheit?' },
  { category: 'general-knowledge', request: 'what gas do plants primarily absorb for photosynthesis?' },
  { category: 'general-knowledge', request: 'which is longer: a kilometer or a mile?', split: 'validation' },
  { category: 'general-knowledge', request: 'what does dna stand for?' },
  { category: 'general-knowledge', request: 'if a train travels 120 kilometers in 2 hours, what is its average speed?', split: 'test' },
  { category: 'general-knowledge', request: 'what is the largest ocean on earth?' },
  { category: 'general-knowledge', request: 'name the four cardinal directions' },
  { category: 'general-knowledge', request: 'what is half of 144?', split: 'validation' },
  { category: 'general-knowledge', request: 'why does ice float on water — density or weight?' },
  { category: 'general-knowledge', request: 'what instrument measures atmospheric pressure?' },
  { category: 'general-knowledge', request: 'how many hours are in a leap year?', split: 'test' },
  { category: 'general-knowledge', request: 'compute that exactly: 366 * 24 hours', expectedTool: 'math.evaluate', expectedParams: { expression: '366 * 24' } },
  { category: 'general-knowledge', request: 'what is the primary language spoken in egypt?' },
  { category: 'general-knowledge', request: 'what does a thermometer measure?' },
  { category: 'general-knowledge', request: 'which planet is known as the red planet?' },
  { category: 'general-knowledge', request: 'remember for quiz night: the seven colors of the rainbow in order', expectedTool: 'memory.store', expectedParams: { key: 'rainbow-colors', value: { order: ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'] } } },
  { category: 'general-knowledge', request: 'what is the smallest prime number?' },
];

// ---------- §5 coding languages ----------
const languages: Batch = [
  { category: 'coding-languages', request: 'in python, what is the difference between a list and a tuple?' },
  { category: 'coding-languages', request: 'what does the rust ownership model prevent at compile time?' },
  { category: 'coding-languages', request: 'identify the language of this snippet and its runtime: "func main() { fmt.Println(\\"hi\\") }"' },
  { category: 'coding-languages', request: 'in java, what is the difference between an interface and an abstract class?' },
  { category: 'coding-languages', request: 'what does the c preprocessor directive #include <stdio.h> do?' },
  { category: 'coding-languages', request: 'in c#, what is the difference between var and dynamic?', split: 'validation' },
  { category: 'coding-languages', request: 'what are php superglobals like $_POST used for?' },
  { category: 'coding-languages', request: 'what sql clause filters rows after aggregation?' },
  { category: 'coding-languages', request: 'what is the difference between let and var in javascript?', split: 'test' },
  { category: 'coding-languages', request: 'in typescript, what does the "as const" assertion do?' },
  { category: 'coding-languages', request: 'what does "chmod +x deploy.sh" prepare in bash scripts?' },
  { category: 'coding-languages', request: 'in html, what is the semantic difference between <section> and <div>?' },
  { category: 'coding-languages', request: 'in css, what does the flex shorthand "flex: 1 1 auto" mean?' },
  { category: 'coding-languages', request: 'save this go snippet to /snippets/hello.go in the vfs: package main; func main() { fmt.Println("hello") }', expectedTool: 'fs.writefile', expectedParams: { path: '/snippets/hello.go', content: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello") }' } },
  { category: 'coding-languages', request: 'run the python version check on the host terminal so we know the runtime', expectedTool: 'fs.cmd', expectedParams: { command: 'python3 --version' } },
  { category: 'coding-languages', request: 'count the words in this sql query before documenting it: SELECT id, name FROM users WHERE active = 1', expectedTool: 'text.analyze', expectedParams: { text: 'SELECT id, name FROM users WHERE active = 1' }, split: 'validation' },
  { category: 'coding-languages', request: 'what common errors do beginners make with python indentation?' },
  { category: 'coding-languages', request: 'which tooling compiles typescript to javascript and what is the standard config file called?' },
  { category: 'coding-languages', request: 'explain what a shell shebang "#!/usr/bin/env bash" controls', split: 'validation' },
  { category: 'coding-languages', request: 'in go, what is a goroutine and how does it differ from an os thread?' },
  { category: 'coding-languages', request: 'what is the rust equivalent of a javascript promise for async work?' },
  { category: 'coding-languages', request: 'remember the team convention: python code uses 4-space indent and snake_case', expectedTool: 'memory.store', expectedParams: { key: 'python-style', value: { indent: 4, naming: 'snake_case' } } },
];

// ---------- §6 generative + creative intelligence (AskSelf selection) ----------
const creative: Batch = [
  { category: 'creative', request: 'generate five tagline options for a task automation console' },
  { category: 'creative', request: 'brainstorm three dashboard layout ideas for a server monitor', expectedTool: 'ask.self', expectedParams: { prompt: 'Brainstorm three dashboard layout ideas for a server monitoring console.', pattern: 'three named concepts with one-line descriptions' }, split: 'validation' },
  { category: 'creative', request: 'write a short product description for a self-hosted automation tool called NexTool', expectedTool: 'ask.self', expectedParams: { prompt: 'Write a short product description for a self-hosted AI task automation tool called NexTool.' } },
  { category: 'creative', request: 'give me four alternative names for a nightly backup job' },
  { category: 'creative', request: 'generate a json schema draft for a settings object with theme and timezone fields', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate a JSON schema draft for a settings object with theme and timezone fields.' } },
  { category: 'creative', request: 'propose three ux improvements for a long settings form', expectedTool: 'ask.self', expectedParams: { prompt: 'Propose three UX improvements for a long settings form.' }, split: 'test' },
  { category: 'creative', request: 'write a friendly explanation of what a cron job is for a beginner' },
  { category: 'creative', request: 'generate an image of a futuristic control room with soft blue lighting for the landing page', expectedTool: 'image.generate', expectedParams: { prompt: 'A futuristic AI control room with soft blue ambient lighting, wide-angle cinematic composition, glowing dashboard panels, atmospheric haze, photorealistic', size: '1344x768' } },
  { category: 'creative', request: 'draft the changelog entry text for our next release in a professional tone' },
  { category: 'creative', request: 'explain how this regex works: ^[a-z]+\\d{2}$ and give two sample matches', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain how the regex ^[a-z]+\\d{2}$ works and give two sample matches.' } },
  { category: 'creative', request: 'restructure this sentence into three clearer alternatives: "the thing that stops the server when it breaks"', split: 'validation' },
  { category: 'creative', request: 'what are three creative ways to visualize a dependency graph in a web ui?' },
  { category: 'creative', request: 'design concept: how would you lay out a file manager for touch screens?' },
  { category: 'creative', request: 'generate a naming scheme for our microservices with a consistent prefix convention', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate a naming scheme for microservices with a consistent prefix convention.' } },
  { category: 'creative', request: 'draft an apology message to users about a brief maintenance window' },
];

// ---------- §7 complex content (long, multi-step, conditional) ----------
const complexContent: Batch = [
  { category: 'complex-content', request: 'multi-step: first read /configs/server.json from the vfs, then tell me whether maintenance mode is on', expectedTool: 'fs.readfile', expectedParams: { path: '/configs/server.json' } },
  { category: 'complex-content', request: 'if the server is unhealthy restart it, but do not restart it while a deployment is in progress — remember this operating rule under key "restart-rule"', expectedTool: 'memory.store', expectedParams: { key: 'restart-rule', value: { rule: 'restart only if unhealthy', unless: 'deployment in progress' } } },
  { category: 'complex-content', request: 'unless the backup already ran today, run the backup verification first and report the result', expectedTool: 'ask.user', expectedParams: { message: 'Should I run the backup verification now, or did the backup already run today?' }, split: 'validation' },
  { category: 'complex-content', request: 'before deleting the cache folder, check that /cache/manifest.json still exists in the vfs', expectedTool: 'fs.hasfile', expectedParams: { path: '/cache/manifest.json' } },
  { category: 'complex-content', request: 'after the deploy completes, verify the health endpoint and notify me with the result', expectedTool: 'notification.send', expectedParams: { title: 'deploy verification', body: 'Post-deploy health check result', level: 'info' }, split: 'test' },
  { category: 'complex-content', request: 'read the long instruction file /notes/migration-steps.md from the vfs and hold on to it for the migration', expectedTool: 'fs.readfile', expectedParams: { path: '/notes/migration-steps.md' } },
  { category: 'complex-content', request: 'two constraints: never restart during business hours, and always notify before restarting — store both under key "restart-policy"', expectedTool: 'memory.store', expectedParams: { key: 'restart-policy', value: { rules: ['never restart during business hours', 'always notify before restarting'] } } },
  { category: 'complex-content', request: 'when the queue depth exceeds 1000 scale out, but if the error rate is above 5% page me instead — what plan order should I follow?' },
  { category: 'complex-content', request: 'priorities: fixing the login outage comes before the report generation task — remember the priority order under "sprint-priority"', expectedTool: 'memory.store', expectedParams: { key: 'sprint-priority', value: { first: 'fix login outage', second: 'generate reports' } } },
  { category: 'complex-content', request: 'the user corrected me earlier: do not auto-suspend idle servers — recall that correction before proceeding', expectedTool: 'memory.recall', expectedParams: { key: 'no-auto-suspend' }, split: 'validation' },
  { category: 'complex-content', request: 'check whether the release notes file /docs/release.md exists in the vfs, and if it does read it for the announcement draft', expectedTool: 'fs.hasfile', expectedParams: { path: '/docs/release.md' } },
  { category: 'complex-content', request: 'read /feedback/user-notes.txt from the vfs, summarize the top complaint, then save the summary to /feedback/summary.md', expectedTool: 'fs.readfile', expectedParams: { path: '/feedback/user-notes.txt' } },
  { category: 'complex-content', request: 'if step one succeeded write the flag file /state/step1.done into the vfs, otherwise report which error occurred', expectedTool: 'fs.writefile', expectedParams: { path: '/state/step1.done', content: 'step 1 completed' } },
  { category: 'complex-content', request: 'i need a plan for: verify dns, then renew the certificate, then restart nginx, then verify https works — which check comes first?', split: 'test' },
  { category: 'complex-content', request: 'contradiction check: the ticket says deploy at noon but the operator said freeze at noon — what should I ask before acting?', expectedTool: 'ask.user', expectedParams: { message: 'The ticket says deploy at noon, but the operator declared a freeze at noon. Should I deploy or hold?' } },
];

// ---------- §8 pattern understanding ----------
const patterns: Batch = [
  { category: 'patterns', request: 'pattern: health check fails then restart then verify — what is the second step after a failed health check?', expectedTool: 'server.restart', expectedParams: { serverId: 'api-01' } },
  { category: 'patterns', request: 'pattern a fails then b: the primary endpoint 503s, so which fallback check should I run next?', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' } },
  { category: 'patterns', request: 'pattern: if condition then action — if disk usage is above 90 percent, which command shows the biggest offenders on the host?' },
  { category: 'patterns', request: 'pattern: before x do y — before applying migrations, what should be captured?', split: 'validation' },
  { category: 'patterns', request: 'pattern: after x verify z — after moving /old/report.csv to /archive/report.csv in the vfs, how do I verify the file exists?', expectedTool: 'fs.hasfile', expectedParams: { path: '/archive/report.csv' } },
  { category: 'patterns', request: 'sequence a to b to c: create the folder /out/daily in the vfs, then the next step is writing the export there — start with the folder', expectedTool: 'fs.createfolder', expectedParams: { path: '/out/daily' } },
  { category: 'patterns', request: 'error then recovery pattern: the write to /reports/q3.md failed with ENOSPC — what should the recovery step check first?' },
  { category: 'patterns', request: 'execution pattern: long build commands on the host need what protection against hangs?', split: 'test' },
  { category: 'patterns', request: 'event pattern: a user correction arrives while the live task is running — what does nexool do with it under the queue policy?' },
  { category: 'patterns', request: 'json pattern: when a field is missing in the response body, should the plan branch to clarification or assume a default?' },
  { category: 'patterns', request: 'planning pattern: which plan shape handles "try the fast path, and if it fails use the safe path"?' },
  { category: 'patterns', request: 'user behavior pattern: the operator always asks for verification after deletions — remember that under key "operator-style"', expectedTool: 'memory.store', expectedParams: { key: 'operator-style', value: { habit: 'verify after deletions' } } },
  { category: 'patterns', request: 'unless condition pattern: unless the user is deploying, restarting is allowed — how does that change a restart plan?', split: 'validation' },
  { category: 'patterns', request: 'cause and effect pattern: high load average then slow responses — what host metric confirms the cause?', expectedTool: 'system.info' },
  { category: 'patterns', request: 'state change pattern: the flag file /state/deploy.lock appearing in the vfs means what for scheduled restarts?', expectedTool: 'fs.hasfile', expectedParams: { path: '/state/deploy.lock' } },
];

// ---------- §9 self understanding (paraphrases; AskSelf carries the answer) ----------
const selfUnderstanding: Batch = [
  { category: 'nexool-identity', request: 'who built you?', expectedTool: 'ask.self', expectedParams: { prompt: 'Who built you? Answer from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'who is muhammed radin in the context of this system?', expectedTool: 'ask.self', expectedParams: { prompt: 'Who is Muhammed Radin in the context of NexTool? Answer from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'what can you do for me?', expectedTool: 'ask.self', expectedParams: { prompt: 'What can you do for me? Answer from NexTool self-knowledge about its purpose and tool system.' } },
  { category: 'nexool-identity', request: 'are you a task automation system or a chat app?', expectedTool: 'ask.self', expectedParams: { prompt: 'Are you a task automation system or a chat app? Answer from NexTool self-knowledge.' }, split: 'validation' },
  { category: 'nexool-identity', request: 'explain your planner and coremodule in one short answer', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain your planner and coremodule in one short answer, from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'what is the observer in your architecture?', expectedTool: 'ask.self', expectedParams: { prompt: 'What is the Observer in your architecture? Answer from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'how does your event system and live mode work?', expectedTool: 'ask.self', expectedParams: { prompt: 'How do your event system and Live Mode work? Answer from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'what is your real filesystem boundary called?', expectedTool: 'ask.self', expectedParams: { prompt: 'What is your real filesystem boundary called? Answer from NexTool self-knowledge (freedom-node).' }, split: 'test' },
  { category: 'nexool-identity', request: 'do you run self-hosted?', expectedTool: 'ask.self', expectedParams: { prompt: 'Are you self-hosted? Answer from NexTool self-knowledge.' } },
  { category: 'nexool-identity', request: 'what environments can your tools run in?', expectedTool: 'ask.self', expectedParams: { prompt: 'What environments can your tools run in? Answer from NexTool self-knowledge (js-function, nodejs, freedom-node, mcp).' } },
  { category: 'nexool-identity', request: 'how do you decide which tool to use for a request?', expectedTool: 'ask.self', expectedParams: { prompt: 'How do you decide which tool to use for a request? Answer from NexTool self-knowledge about the Understand → Plan → Select → Params → Execute → Observe → Replan flow.' } },
  { category: 'nexool-identity', request: 'who created nexool?', expectedTool: 'ask.self', expectedParams: { prompt: 'Who created NexTool? Answer from NexTool self-knowledge.' } },
];

// ---------- §10 PCB design ----------
const pcb: Batch = [
  { category: 'pcb', request: 'in pcb design, what is the purpose of a ground plane?' },
  { category: 'pcb', request: 'what is the difference between a via and a through-hole in a pcb?' },
  { category: 'pcb', request: 'explain signal integrity considerations for high-speed traces on a 4-layer board' },
  { category: 'pcb', request: 'what does footprint mean when placing a component in a schematic-to-board flow?' },
  { category: 'pcb', request: 'compute the trace width current estimate: 2 amperes with 1 oz copper and 10 celsius rise — evaluate 2 * 0.048 * 10^0.44 for a kitchen-table estimate', expectedTool: 'math.evaluate', expectedParams: { expression: '2 * 0.048 * (10 ** 0.44)' }, split: 'validation' },
  { category: 'pcb', request: 'remember our board guideline: keep crystal oscillator traces under 10 mm and guard them with ground', expectedTool: 'memory.store', expectedParams: { key: 'pcb-crystal-rule', value: { maxTraceMm: 10, guard: 'ground' } } },
  { category: 'pcb', request: 'what file formats do pcb tools commonly exchange (gerber, kicad, eagle)?' },
  { category: 'pcb', request: 'generate three placement ideas to decouple the power section from the analog section on a mixed-signal board', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate three placement ideas to decouple the power section from the analog section on a mixed-signal PCB.' } },
  { category: 'pcb', request: 'what is the role of solder mask and silkscreen in manufacturing?' },
  { category: 'pcb', request: 'in routing, why should usb differential pairs be length matched?', split: 'test' },
  { category: 'pcb', request: 'draft a short checklist for reviewing a 2-layer pcb before ordering', expectedTool: 'ask.self', expectedParams: { prompt: 'Draft a short review checklist for a 2-layer PCB before ordering fabrication.' } },
  { category: 'pcb', request: 'what does drc mean in pcb tools and why must it pass before fabrication?' },
];

// ---------- §11 electronic components ----------
const electronics: Batch = [
  { category: 'electronics', request: 'what is the difference between a bjt transistor and a mosfet?' },
  { category: 'electronics', request: 'in a microcontroller to sensor to gpio chain, what does the gpio pin actually read?' },
  { category: 'electronics', request: 'when do you need a flyback diode across a relay coil?' },
  { category: 'electronics', request: 'what does a voltage regulator do between the battery and the microcontroller?', split: 'validation' },
  { category: 'electronics', request: 'how does an led current-limiting resistor get sized — what do you need to know?' },
  { category: 'electronics', request: 'compute the led resistor: 5 volt supply, 2 volt led drop, 15 milliamp current — evaluate the ohms', expectedTool: 'math.evaluate', expectedParams: { expression: '(5 - 2) / 0.015' } },
  { category: 'electronics', request: 'what is the difference between a ceramic and an electrolytic capacitor in decoupling?' },
  { category: 'electronics', request: 'why does an inductor resist sudden current changes in a power supply?' },
  { category: 'electronics', request: 'what is the difference between a servo and a standard dc motor for positioning?' },
  { category: 'electronics', request: 'remember the parts choice: we use the ams1117 regulator for 3.3 volt rails on prototype boards', expectedTool: 'memory.store', expectedParams: { key: 'parts-regulator', value: { part: 'AMS1117', rail: '3.3V', use: 'prototypes' } } },
  { category: 'electronics', request: 'what sensor types commonly connect over i2c on microcontrollers?' },
  { category: 'electronics', request: 'what does a crystal oscillator provide to a microcontroller?' },
  { category: 'electronics', request: 'generate three component alternatives to a relay for switching a 12 volt load', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate three component alternatives to a relay for switching a 12V load.' } },
  { category: 'electronics', request: 'what is an operational amplifier used for in sensor front-ends?', split: 'test' },
  { category: 'electronics', request: 'why does a fuse belong near the power input on a board?' },
];

// ---------- §12 electricity / electrical concepts ----------
const electricity: Batch = [
  { category: 'electricity', request: 'ohm\'s law: a 100 ohm resistor across 5 volts — evaluate the current in amperes', expectedTool: 'math.evaluate', expectedParams: { expression: '5 / 100' } },
  { category: 'electricity', request: 'what is the difference between ac and dc current?' },
  { category: 'electricity', request: 'in a series circuit, how does total resistance combine — and in parallel?', split: 'validation' },
  { category: 'electricity', request: 'compute the parallel resistance of 100 and 220 ohms: evaluate (100 * 220) / (100 + 220)', expectedTool: 'math.evaluate', expectedParams: { expression: '(100 * 220) / (100 + 220)' } },
  { category: 'electricity', request: 'what does polarity mean when connecting an electrolytic capacitor or led?' },
  { category: 'electricity', request: 'why is grounding important and what is a short circuit?' },
  { category: 'electricity', request: 'what is the difference between a signal wire and a power wire in a wiring plan?' },
  { category: 'electricity', request: 'compute the power dissipated: 12 volts times 0.5 amperes', expectedTool: 'math.evaluate', expectedParams: { expression: '12 * 0.5' } },
  { category: 'electricity', request: 'what is voltage drop along a long cable run and why does it matter for sensors?' },
  { category: 'electricity', request: 'digital versus analog signals — how does a microcontroller pin tell them apart?', split: 'test' },
  { category: 'electricity', request: 'what does the load in a circuit mean and how does current draw change with it?' },
  { category: 'electricity', request: 'safety concept: why should the current rating of a wire exceed the expected load current?' },
  { category: 'electricity', request: 'remember the lab rule: always discharge capacitors before touching a switched-off power supply', expectedTool: 'memory.store', expectedParams: { key: 'lab-safety-discharge', value: { rule: 'discharge capacitors before touching a switched-off PSU' } } },
  { category: 'electricity', request: 'explain current draw spikes when a motor starts and what that does to a weak supply' },
];

// ---------- §13 software engineering ----------
const softwareEngineering: Batch = [
  { category: 'software-engineering', request: 'what is the difference between coupling and cohesion in modular design?' },
  { category: 'software-engineering', request: 'when is an interface better than a concrete class as a dependency boundary?' },
  { category: 'software-engineering', request: 'explain the observer design pattern with a practical automation example', split: 'validation' },
  { category: 'software-engineering', request: 'what belongs in a changelog-driven release process for maintainability?' },
  { category: 'software-engineering', request: 'how does structured logging improve observability in a task runner?' },
  { category: 'software-engineering', request: 'what is the difference between horizontal and vertical scaling for a self-hosted service?' },
  { category: 'software-engineering', request: 'remember the architecture decision: the runtime stays single-process with sse for realtime', expectedTool: 'memory.store', expectedParams: { key: 'arch-decision-runtime', value: { process: 'single', realtime: 'sse' } } },
  { category: 'software-engineering', request: 'what security concepts matter for a self-hosted tool that executes commands?' },
  { category: 'software-engineering', request: 'how should error recovery be represented in a deployment pipeline?' },
  { category: 'software-engineering', request: 'what does "design for failure" mean for a system that calls external apis?' },
  { category: 'software-engineering', request: 'version control concept: when should a team prefer rebase over merge and why?', split: 'test' },
  { category: 'software-engineering', request: 'generate four acceptance-test ideas for an approval state machine with accept, skip and reject', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate four acceptance-test ideas for an approval state machine with accept, skip and reject outcomes.' } },
  { category: 'software-engineering', request: 'what is idempotency and why does it matter for retrying failed tool executions?' },
  { category: 'software-engineering', request: 'system design: how would you keep a scheduler and a queue consistent under crash-restart?' },
  { category: 'software-engineering', request: 'explain state management choices for a dashboard that streams live task updates' },
];

// ---------- §14 computer engineering ----------
const computerEngineering: Batch = [
  { category: 'computer-engineering', request: 'what is the difference between ram and storage in a small server?' },
  { category: 'computer-engineering', request: 'what does the cpu load average actually measure on linux?', expectedTool: 'system.info' },
  { category: 'computer-engineering', request: 'show me the host system information so we can check memory and cpu count', expectedTool: 'system.info' },
  { category: 'computer-engineering', request: 'what is the difference between a process and a thread at the os level?' },
  { category: 'computer-engineering', request: 'how does a filesystem journal protect against sudden power loss?', split: 'validation' },
  { category: 'computer-engineering', request: 'what is binary 1010 in decimal — evaluate it', expectedTool: 'math.evaluate', expectedParams: { expression: '1 * 8 + 0 * 4 + 1 * 2 + 0 * 1' } },
  { category: 'computer-engineering', request: 'what is the role of the bus between cpu, memory and i/o devices?' },
  { category: 'computer-engineering', request: 'in embedded systems, why do microcontrollers avoid heavy context switches?' },
  { category: 'computer-engineering', request: 'what does the kernel do when a process requests more memory than is free?' },
  { category: 'computer-engineering', request: 'what is the difference between polling and interrupts for peripherals?' },
  { category: 'computer-engineering', request: 'how many kilobytes are in a mebibyte — evaluate 1024 * 1024 bytes in kb', expectedTool: 'math.evaluate', expectedParams: { expression: '(1024 * 1024) / 1024' }, split: 'test' },
  { category: 'computer-engineering', request: 'what happens to running processes when the terminal session that started them closes?' },
  { category: 'computer-engineering', request: 'why does an ssd handle random io better than a spinning disk?' },
  { category: 'computer-engineering', request: 'what does uptime and load average tell you together about a server\'s health?' },
  { category: 'computer-engineering', request: 'remember the host fact: this sandbox runs linux with a fixed cpu count, verify with system info before load tests', expectedTool: 'memory.store', expectedParams: { key: 'host-fact', value: { os: 'linux', note: 'verify cpu count with system.info before load tests' } } },
];

// ---------- §15 designing / UI / system design ----------
const design: Batch = [
  { category: 'design', request: 'what is visual hierarchy and how does it guide a dashboard layout?' },
  { category: 'design', request: 'responsive design: what does mobile-first mean for breakpoint planning?' },
  { category: 'design', request: 'what is the minimum comfortable touch target size on mobile and why?' },
  { category: 'design', request: 'generate three layout alternatives for a two-pane file manager on tablets', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate three layout alternatives for a two-pane file manager on tablets.' }, split: 'validation' },
  { category: 'design', request: 'accessibility: what does aria-label add for a screen reader on an icon-only button?' },
  { category: 'design', request: 'interaction design: when should a destructive action require typed confirmation?' },
  { category: 'design', request: 'what makes a loading state honest instead of misleading — skeleton, spinner or progress?' },
  { category: 'design', request: 'remember the design rule: every destructive button in the console needs a confirmation step', expectedTool: 'memory.store', expectedParams: { key: 'design-destructive-rule', value: { rule: 'destructive buttons need confirmation' } } },
  { category: 'design', request: 'animation concept: what should a 150-200 ms transition communicate versus a 500 ms one?' },
  { category: 'design', request: 'component systems: why do design tokens prevent drift across pages?' },
  { category: 'design', request: 'system architecture diagram: what belongs in boxes versus arrows?' },
  { category: 'design', request: 'critique this design idea: putting the primary action in the top-right corner on mobile', split: 'test' },
  { category: 'design', request: 'generate a color-role scheme (background, surface, primary, danger) for a technical console', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate a color-role scheme (background, surface, primary, danger) for a technical console, avoiding blue/indigo defaults.' } },
  { category: 'design', request: 'what is the difference between ux writing and marketing copy in an operator console?' },
];

// ---------- §16 intelligent improvement (correction → updated behavior) ----------
const improvement: Batch = [
  { category: 'improvement', request: 'you tried to suspend the server while users were active. do not suspend while users are active — save that as a rule under key "no-suspend-active"', expectedTool: 'memory.store', expectedParams: { key: 'no-suspend-active', value: { rule: 'never suspend while users are active' } } },
  { category: 'improvement', request: 'the last deletion used the wrong path — the log folder is /logs/archive not /archive/logs. write the corrected delete for /logs/archive/stale.txt in the vfs', expectedTool: 'fs.deletefile', expectedParams: { path: '/logs/archive/stale.txt' } },
  { category: 'improvement', request: 'that plan failed because you skipped the verification step. after restarting a service, which check confirms recovery?', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' }, split: 'validation' },
  { category: 'improvement', request: 'you assumed the timezone. ask me the meeting timezone instead of guessing', expectedTool: 'ask.user', expectedParams: { message: 'Which timezone should I use for the meeting time?', placeholder: 'e.g. Asia/Kolkata' } },
  { category: 'improvement', request: 'your notification level was too aggressive — send status updates as info, not critical', expectedTool: 'notification.send', expectedParams: { title: 'status update', body: 'routine status update', level: 'info' } },
  { category: 'improvement', request: 'the user rejected that delete yesterday. what should happen before any delete is attempted again?' },
  { category: 'improvement', request: 'the write to /reports/q3.md was skipped by the user. propose an alternative that does not write files', expectedTool: 'ask.self', expectedParams: { prompt: 'The write to /reports/q3.md was skipped by the user. Propose an alternative way to deliver the report content that does not write files.' } },
  { category: 'improvement', request: 'the wrong tool was chosen: the request was about the shared vfs, not the host. which tool lists /docs inside the vfs?', expectedTool: 'fs.list', expectedParams: { path: '/docs' }, split: 'test' },
  { category: 'improvement', request: 'parameters were wrong: the timeout was 5 ms and the command never finished. re-run the host version check with a sane timeout', expectedTool: 'fs.cmd', expectedParams: { command: 'node --version', timeoutMs: 10000 } },
  { category: 'improvement', request: 'remember from the failure: batch writes need a delay between them or the device drops packets — store under key "device-write-pacing"', expectedTool: 'memory.store', expectedParams: { key: 'device-write-pacing', value: { lesson: 'delay between batch writes or packets drop' } } },
  { category: 'improvement', request: 'the plan ignored the condition. restate: if a deployment is running, restarts must wait — what would you check first?', expectedTool: 'fs.hasfile', expectedParams: { path: '/state/deploy.lock' } },
  { category: 'improvement', request: 'successful alternative: when the direct download failed, which vfs tool produces a shareable link?', expectedTool: 'fs.download', expectedParams: { path: '/exports/dataset.csv' } },
];

// ---------- §17/§18 tool understanding (title + body + schema + environment) ----------
const toolBody: Batch = [
  { category: 'tool-understanding', request: 'search my project for every typescript file under /src in the shared vfs', expectedTool: 'fs.find', expectedParams: { query: '.ts', path: '/src', filesOnly: true } },
  { category: 'tool-understanding', request: 'using the tool whose body says it lists entries with name, path, kind and size — show me the /workspace folder in the vfs', expectedTool: 'fs.list', expectedParams: { path: '/workspace' } },
  { category: 'tool-understanding', request: 'the tool description says it normalizes a path and never leaks the host path — run it on /notes/../notes/a.txt', expectedTool: 'fs.getpath', expectedParams: { path: '/notes/../notes/a.txt' } },
  { category: 'tool-understanding', request: 'which tool matches "bounded by an explicit depth" for folder search, and what depth is 0?', expectedTool: 'fs.find', expectedParams: { query: 'report', path: '/', depth: 0 }, split: 'validation' },
  { category: 'tool-understanding', request: 'a tool whose description says "pauses until the operator answers" — what kind of request should use it?' },
  { category: 'tool-understanding', request: 'the builtin whose result is { success, opinion } — what is that tool for?', expectedTool: 'ask.self', expectedParams: { prompt: 'What is the AskSelf tool for, given its { success, opinion } result shape?' } },
  { category: 'tool-understanding', request: 'an mcp-imported tool can only touch the shared vfs — true or false, and why?' },
  { category: 'tool-understanding', request: 'freedom-node tools are exempt from the vfs sandbox — what does that mean for a command like df -h on the host?', expectedTool: 'fs.cmd', expectedParams: { command: 'df -h' } },
  { category: 'tool-understanding', request: 'pick the tool by body: "Evaluates a safe arithmetic expression" — I need 15 percent of 240', expectedTool: 'math.evaluate', expectedParams: { expression: '240 * 0.15' } },
  { category: 'tool-understanding', request: 'pick by description: "Sends a notification with a level" — warn the operator that the disk is filling', expectedTool: 'notification.send', expectedParams: { title: 'disk filling up', body: 'disk usage is approaching capacity', level: 'warning' } },
  { category: 'tool-understanding', request: 'which tool copies a whole folder recursively inside the vfs — give me the call for /site to /backup/site', expectedTool: 'fs.copy', expectedParams: { path: '/site', to: '/backup/site' } },
  { category: 'tool-understanding', request: 'which tool moves and renames inside the vfs boundary — rename /drafts/v1.md to /drafts/notes-v1.md', expectedTool: 'fs.move', expectedParams: { path: '/drafts/v1.md', to: '/drafts/notes-v1.md' } },
  { category: 'tool-understanding', request: 'the tool body says it registers a short-lived console download url — make /exports/dataset.csv downloadable', expectedTool: 'fs.download', expectedParams: { path: '/exports/dataset.csv' } },
  { category: 'tool-understanding', request: 'a tool asks the operator to pick a file from their device — which tool uploads it into the vfs?', expectedTool: 'fs.upload', expectedParams: { suggestedName: 'capture.png', message: 'Choose the screenshot to attach' }, split: 'validation' },
  { category: 'tool-understanding', request: 'environment check: a js-function tool cannot read the host filesystem — which environment actually can?' },
  { category: 'tool-understanding', request: 'the memory tool description says upsert by unique key — update my stored proxy port under key "proxy-config"', expectedTool: 'memory.store', expectedParams: { key: 'proxy-config', value: { port: 8080 } } },
  { category: 'tool-understanding', request: 'which tool fuzzy-searches stored entries when you only remember part of a key?', expectedTool: 'memory.recall', expectedParams: { query: 'proxy' } },
  { category: 'tool-understanding', request: 'by description, which tool echoes a message for runtime verification — verify the round trip with hello-runtime', expectedTool: 'echo.echo', expectedParams: { message: 'hello-runtime' } },
  { category: 'tool-understanding', request: 'which tool waits a bounded number of milliseconds between retries — set a 2 second pause', expectedTool: 'delay.wait', expectedParams: { ms: 2000 } },
  { category: 'tool-understanding', request: 'which server tool lists the virtual environment with health, cpu and memory?', expectedTool: 'server.list' },
  { category: 'tool-understanding', request: 'generate fresh correlation ids for the batch — the tool description says it returns 1-10 uuids', expectedTool: 'uuid.generate', expectedParams: { count: 3 } },
];

// ---------- §19 AskSelf teaching ----------
const askSelfBatch: Batch = [
  { category: 'askself', request: 'what are three possible names for the release branch?', expectedTool: 'ask.self', expectedParams: { prompt: 'What are three possible names for the release branch?' } },
  { category: 'askself', request: 'explain why the previous tool failed before we retry anything', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain why the previous tool failed, using the last observation as context.', context: 'previous tool attempt failed' } },
  { category: 'askself', request: 'generate four choices in this format: number, label, one-line reason', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate four choices in this format: number, label, one-line reason.', pattern: 'numbered list with label and reason' } },
  { category: 'askself', request: 'extract the action items from this paragraph and list them as questions', expectedTool: 'ask.self', expectedParams: { prompt: 'Extract the action items from the given paragraph and list them as questions.', context: 'paragraph provided by the user in the conversation' }, split: 'validation' },
  { category: 'askself', request: 'write a short explanation of what the settings page does for the onboarding doc' },
  { category: 'askself', request: 'when should you NOT use askself and instead call a real tool?' },
  { category: 'askself', request: 'summarize the conversation so far into three operator-facing bullets', expectedTool: 'ask.self', expectedParams: { prompt: 'Summarize the conversation so far into three operator-facing bullets.', history: ['operator asked for a summary'] } },
  { category: 'askself', request: 'what is your opinion on retrying immediately versus backing off after a timeout?', expectedTool: 'ask.self', expectedParams: { prompt: 'What is your opinion on retrying immediately versus backing off after a timeout?' }, split: 'test' },
  { category: 'askself', request: 'draft the body text for the maintenance notification window announcement' },
  { category: 'askself', request: 'reasoning support: list the risks of running rm -rf on a path before I ask the operator to approve it', expectedTool: 'ask.self', expectedParams: { prompt: 'List the risks of running rm -rf on a path before asking the operator for approval.' } },
];

// ---------- AskForUser teaching (missing human information) ----------
const askForUserBatch: Batch = [
  { category: 'askforuser', request: 'which server id should I restart? there are three and you did not say', expectedTool: 'ask.user', expectedParams: { message: 'Which server id should I restart?', placeholder: 'server id' } },
  { category: 'askforuser', request: 'the branch name is missing for the release — ask me for it', expectedTool: 'ask.user', expectedParams: { message: 'Which branch should I release?' } },
  { category: 'askforuser', request: 'deleting /shared/templates removes shared assets — get my confirmation first', expectedTool: 'ask.user', expectedParams: { message: 'Delete /shared/templates and its shared assets? This cannot be undone.', defaultValue: 'no' }, split: 'validation' },
  { category: 'askforuser', request: 'what port should the new connector use? ask me with 8080 prefilled', expectedTool: 'ask.user', expectedParams: { message: 'Which port should the new connector use?', defaultValue: '8080' } },
  { category: 'askforuser', request: 'i need the ticket priority from you before scheduling — just ask', expectedTool: 'ask.user', expectedParams: { message: 'What priority should the ticket get?' } },
  { category: 'askforuser', request: 'should the report go to /reports or /out? stop guessing and ask me', expectedTool: 'ask.user', expectedParams: { message: 'Should the report be written to /reports or /out?', placeholder: '/reports' } },
];

// ---------- §50 user events (Live Mode) ----------
const userEvents: Batch = [
  { category: 'user-events', request: 'why did you stop the server?', expectedTool: 'ask.self', expectedParams: { prompt: 'Answer the operator: why did you stop the server? Use the task and event context.', context: 'live task context; a stop action happened earlier' } },
  { category: 'user-events', request: 'why did you reject the request earlier?', expectedTool: 'ask.self', expectedParams: { prompt: 'Answer the operator: why was the request rejected earlier? Use the task and event context.', context: 'a tool was rejected by approval earlier' }, split: 'validation' },
  { category: 'user-events', request: 'you did that wrong. do not suspend the server — acknowledge and fix the rule', expectedTool: 'memory.store', expectedParams: { key: 'no-suspend-active', value: { rule: 'never suspend the server', reason: 'operator correction via live event' } } },
  { category: 'user-events', request: 'while you are running, the user asks for the current status — which tool answers without side effects?', expectedTool: 'ask.self', expectedParams: { prompt: 'Report the current task status to the user from context, without side effects.' } },
  { category: 'user-events', request: 'the user just sent a new message while the action was running — what happens to it under read and act all events?', split: 'test' },
  { category: 'user-events', request: 'the operator says the target folder changed to /out/november — update the plan and write the export to /out/november/result.csv', expectedTool: 'fs.writefile', expectedParams: { path: '/out/november/result.csv', content: 'export result (november folder)' } },
  { category: 'user-events', request: 'an event says the server recovered on its own — cancel the pending restart and tell the user', expectedTool: 'notification.send', expectedParams: { title: 'restart cancelled', body: 'server recovered on its own; pending restart cancelled', level: 'info' } },
  { category: 'user-events', request: 'the user asks a question you cannot answer from context — what should nexool do instead of inventing an answer?' },
  { category: 'user-events', request: 'an irrelevant event arrives (a test ping) while the task works on reports — should it interrupt the work?' },
  { category: 'user-events', request: 'user message: is the migration finished? answer from the current task state', expectedTool: 'ask.self', expectedParams: { prompt: 'Answer the operator: is the migration finished? Use current task state and observations.', context: 'migration task in progress' } },
];

// ---------- §52 approval states (accepted → continue, skipped → alternative, rejected → revise) ----------
const approvals: Batch = [
  { category: 'approvals', request: 'the user accepted the fs.cmd approval — continue the plan: check the node version on the host now', expectedTool: 'fs.cmd', expectedParams: { command: 'node --version' } },
  { category: 'approvals', request: 'tool fs.writefile was skipped by the user — continue with the next logical step and verify whether /reports/q3.md already exists', expectedTool: 'fs.hasfile', expectedParams: { path: '/reports/q3.md' } },
  { category: 'approvals', request: 'the write was skipped by the operator — instead of writing, state the report content in your reply', expectedTool: 'ask.self', expectedParams: { prompt: 'The file write was skipped by the operator. State the report content in your reply instead of writing a file.' }, split: 'validation' },
  { category: 'approvals', request: 'the user rejected the delete of /shared/assets — revise the plan: which archive step could replace deletion?', expectedTool: 'fs.move', expectedParams: { path: '/shared/assets', to: '/archive/assets' } },
  { category: 'approvals', request: 'after a rejection, what must never happen with that same rejected action?' },
  { category: 'approvals', request: 'execution history shows the tool was skipped — the dependent step must not assume success; which check proves the file state?', expectedTool: 'fs.infofile', expectedParams: { path: '/reports/q3.md' }, split: 'test' },
  { category: 'approvals', request: 'the restart approval timed out — what is the safe continuation for the waiting plan?' },
  { category: 'approvals', request: 'user accepted the earlier step; proceed with the dependent follow-up and save the receipt to /logs/step1-receipt.txt', expectedTool: 'fs.writefile', expectedParams: { path: '/logs/step1-receipt.txt', content: 'step 1 accepted and completed' } },
  { category: 'approvals', request: 'destructive command rm -rf ./build needs explicit approval — what does the approval card show the operator?' },
  { category: 'approvals', request: 'the plan hit a rejected fs.cmd. re-plan: run the read-only listing instead to make progress', expectedTool: 'fs.list', expectedParams: { path: '/build' } },
];

// ---------- §51 terminal environments (fs real FS vs vfs vs freedom-node) ----------
const terminal: Batch = [
  { category: 'terminal', request: 'print the current working directory on the real host terminal', expectedTool: 'fs.cmd', expectedParams: { command: 'pwd' } },
  { category: 'terminal', request: 'run ls -la on the host shell in the project directory', expectedTool: 'fs.cmd', expectedParams: { command: 'ls -la', cwd: '.' } },
  { category: 'terminal', request: 'check the git version installed on the host', expectedTool: 'fs.cmd', expectedParams: { command: 'git --version' } },
  { category: 'terminal', request: 'create a scratch directory on the host for the build test', expectedTool: 'fs.cmd', expectedParams: { command: 'mkdir -p scratch/build-test' } },
  { category: 'terminal', request: 'what is the difference between the fs terminal and the vfs terminal in the inspector?' },
  { category: 'terminal', request: 'in the vfs terminal, the find command searches which boundary — the host or the shared vfs?', split: 'validation' },
  { category: 'terminal', request: 'which terminal affects the actual host machine and must be treated as real?', expectedTool: 'fs.cmd', expectedParams: { command: 'echo real-fs-boundary' } },
  { category: 'terminal', request: 'the mcp environment is vfs-only — can an mcp tool run a host terminal command?' },
  { category: 'terminal', request: 'freedom-node is the unrestricted execution surface — what kind of tool needs that instead of fs.cmd?' },
  { category: 'terminal', request: 'interactive stdin commands like npm init belong to which inspector terminal?' },
  { category: 'terminal', request: 'list the top-level entries of the shared vfs so I can compare it with the host listing', expectedTool: 'fs.list', expectedParams: { path: '/' } },
  { category: 'terminal', request: 'run the host node version check and remember the result under key "host-node"', expectedTool: 'fs.cmd', expectedParams: { command: 'node --version' }, split: 'test' },
];

// ---------- §21 planner training (multi-step, dependencies, recovery) ----------
const planner: Batch = [
  { category: 'planner', request: 'plan the goal: monitor the api server, restart on failure, never restart during a deployment — what is the first observation call?', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' } },
  { category: 'planner', request: 'plan: backup then verify — after the backup writes /backups/daily.zip in the vfs, which check verifies it exists?', expectedTool: 'fs.hasfile', expectedParams: { path: '/backups/daily.zip' } },
  { category: 'planner', request: 'multi-step: gather host facts, then decide scaling — start with the host facts call', expectedTool: 'system.info' },
  { category: 'planner', request: 'dependency order: create /out/eu in the vfs before writing there — do the create now', expectedTool: 'fs.createfolder', expectedParams: { path: '/out/eu' } },
  { category: 'planner', request: 'conditional plan: if the manifest exists proceed with cleanup, else stop — check the manifest first', expectedTool: 'fs.hasfile', expectedParams: { path: '/cache/manifest.json' }, split: 'validation' },
  { category: 'planner', request: 'recovery step: the primary endpoint failed the health check — what is the next diagnostic call?', expectedTool: 'server.list' },
  { category: 'planner', request: 'verification step: after moving /tmp/report.csv to /archive/report.csv, verify with the existence check', expectedTool: 'fs.hasfile', expectedParams: { path: '/archive/report.csv' } },
  { category: 'planner', request: 'the plan achieved its goal — which built-in ends a live cycle without inventing more work?' },
  { category: 'planner', request: 'plan: rotate logs on the host then confirm the archive file exists in the vfs — the rotation ran, now verify /logs/archive.txt', expectedTool: 'fs.hasfile', expectedParams: { path: '/logs/archive.txt' } },
  { category: 'planner', request: 'stopping criteria: when should a monitoring plan stop calling tools?' },
  { category: 'planner', request: 'subgoal: the big goal is a release, the current subgoal is a changelog draft — which tool drafts text without file writes?', expectedTool: 'ask.self', expectedParams: { prompt: 'Draft the release changelog entry from the merged changes context.', context: 'release preparation subgoal' } },
  { category: 'planner', request: 'plan with alternative: if fs.download is rejected, generate the report inline instead — produce the inline report now', expectedTool: 'ask.self', expectedParams: { prompt: 'Produce the report inline as text, since the download link was rejected by the operator.' }, split: 'test' },
];

// ---------- §55 JSON understanding ----------
const jsonUnderstanding: Batch = [
  { category: 'json', request: 'read this json and tell me the meaning of the status field: {"server":"api-01","status":503,"users":0}', expectedTool: 'ask.self', expectedParams: { prompt: 'Interpret this JSON and explain the status field: {"server":"api-01","status":503,"users":0}', context: 'json understanding' } },
  { category: 'json', request: 'save this config object to /configs/alerts.json in the vfs: {"channel":"ops","minLevel":"warning"}', expectedTool: 'fs.writefile', expectedParams: { path: '/configs/alerts.json', content: '{"channel":"ops","minLevel":"warning"}' } },
  { category: 'json', request: 'in a nested json payload, what distinguishes a missing field from a null field?' },
  { category: 'json', request: 'the response array has three objects with an optional "region" field — how should a plan handle missing regions?' },
  { category: 'json', request: 'count the words in this json snippet before documenting it: {"a":1,"b":[2,3]}', expectedTool: 'text.analyze', expectedParams: { text: '{"a":1,"b":[2,3]}' }, split: 'validation' },
  { category: 'json', request: 'store this structured payload in memory under key "health-snapshot": {"status":"degraded","checks":3}', expectedTool: 'memory.store', expectedParams: { key: 'health-snapshot', value: { status: 'degraded', checks: 3 } } },
  { category: 'json', request: 'type difference check: is "5" the same as 5 in json semantics for a numeric field?' },
  { category: 'json', request: 'read /configs/alerts.json from the vfs so I can check the alert channel value', expectedTool: 'fs.readfile', expectedParams: { path: '/configs/alerts.json' } },
  { category: 'json', request: 'the tool returned {"ok":true,"items":[]} — is that a success with no data or a failure?' },
  { category: 'json', request: 'generate a json example with nested objects and arrays for the api documentation', expectedTool: 'ask.self', expectedParams: { prompt: 'Generate a JSON example with nested objects and arrays for API documentation.' } },
];

// ---------- §56 rich text understanding (paraphrase → same intent) ----------
const richText: Batch = [
  { category: 'rich-text', request: 'the api is down; bring it back online', expectedTool: 'server.restart', expectedParams: { serverId: 'api-01' } },
  { category: 'rich-text', request: '503 responses are coming from api-01, please recover it', expectedTool: 'server.restart', expectedParams: { serverId: 'api-01' }, split: 'validation' },
  { category: 'rich-text', request: 'api-01 fell over again — get it healthy', expectedTool: 'server.restart', expectedParams: { serverId: 'api-01' } },
  { category: 'rich-text', request: 'can you take a quick look at whether api-01 is actually serving traffic right now?', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' } },
  { category: 'rich-text', request: 'i need eyes on the fleet — health, cpu and memory for everything', expectedTool: 'server.list' },
  { category: 'rich-text', request: 'drop me a note when you start the maintenance so I am not surprised', expectedTool: 'notification.send', expectedParams: { title: 'maintenance starting', body: 'maintenance window is beginning', level: 'info' }, split: 'test' },
  { category: 'rich-text', request: 'that document is huge — how many words are we talking about? "the quick brown fox jumps over the lazy dog"', expectedTool: 'text.analyze', expectedParams: { text: 'the quick brown fox jumps over the lazy dog' } },
  { category: 'rich-text', request: 'what time do we have right now? i keep losing track', expectedTool: 'time.now' },
  { category: 'rich-text', request: 'we need a proper identifier for the support ticket, something unique', expectedTool: 'uuid.generate' },
  { category: 'rich-text', request: 'park this in memory: the vendor call is scheduled for friday 15:00 utc', expectedTool: 'memory.store', expectedParams: { key: 'vendor-call', value: { when: 'friday 15:00 utc' } } },
];

// ---------- §53 round 2 — targeted confusion pairs from the first benchmark ----------
// The first v1.0.4 pass showed 1-per-pair confusions on: typo variants,
// short time questions (time.now vs math.evaluate), echo typos, "saved"
// retrieval (memory.recall vs ask.self), contents-vs-metadata (readfile vs
// infofile), existence-vs-creation (hasfile/hasfolder vs createfolder),
// list-vs-create, "store as <path>" (writefile vs memory.store/ask.self),
// canonical path questions (getpath vs math), visual-for-cover (image vs
// server.list), health-vs-restart, copy-vs-write, move-vs-create,
// find-vs-hasfile, upload-vs-hasfile, download-vs-askself.
const round2: Batch = [
  { category: 'time', request: 'whats the time right now?' },
  { category: 'time', request: 'tell me the current hour for the log stamp' },
  { category: 'time', request: 'current timestamp please', split: 'validation' },
  { category: 'time', request: 'what day is it today for the changelog header?' },
  { category: 'echo-verification', request: 'eco the message roundtrip two' },
  { category: 'echo-verification', request: 'verify the pipeline with echo roundtrip-check' },
  { category: 'echo-verification', request: 'send the literal test phrase back to me', expectedTool: 'echo.echo', expectedParams: { message: 'test phrase' }, split: 'validation' },
  { category: 'math', request: 'what is 45 plus 78 for the totals row?' },
  { category: 'math', request: 'evaluate the share split: 300 divided by 7', expectedTool: 'math.evaluate', expectedParams: { expression: '300 / 7' }, split: 'validation' },
  { category: 'math', request: 'multiply 32 by 1.5 for the cost estimate' },
  { category: 'memory', request: 'retrieve the sla targets we saved earlier', expectedTool: 'memory.recall', expectedParams: { key: 'sla-targets' }, split: 'validation' },
  { category: 'memory', request: 'fetch the stored release checklist from memory', expectedTool: 'memory.recall', expectedParams: { key: 'release-checklist' } },
  { category: 'memory', request: 'look up the remembered proxy settings', expectedTool: 'memory.recall', expectedParams: { query: 'proxy settings' } },
  { category: 'memory', request: 'what did we store about the maintenance window?' },
  { category: 'filesystem', request: 'show everything inside /data in the shared vfs', expectedTool: 'fs.list', expectedParams: { path: '/data' }, split: 'test' },
  { category: 'filesystem', request: 'list the contents of /workspace in the shared vfs', expectedTool: 'fs.list', expectedParams: { path: '/workspace' } },
  { category: 'filesystem', request: 'what files live under /assets in the vfs?' },
  { category: 'filesystem', request: 'open /workspace/data.json from the shared vfs and show its contents', expectedTool: 'fs.readfile', expectedParams: { path: '/workspace/data.json' } },
  { category: 'filesystem', request: 'give me the full text of /notes/plan.md stored in the vfs', expectedTool: 'fs.readfile', expectedParams: { path: '/notes/plan.md' }, split: 'validation' },
  { category: 'filesystem', request: 'show the file size and modified time of /logs/app.log', expectedTool: 'fs.infofile', expectedParams: { path: '/logs/app.log' } },
  { category: 'filesystem', request: 'metadata for /configs/runtime.json please', expectedTool: 'fs.infofile', expectedParams: { path: '/configs/runtime.json' }, split: 'validation' },
  { category: 'filesystem', request: 'is there a directory called /data/archives in the shared virtual filesystem?', expectedTool: 'fs.hasfolder', expectedParams: { path: '/data/archives' }, split: 'test' },
  { category: 'filesystem', request: 'does the vfs folder /backups exist yet?' },
  { category: 'filesystem', request: 'make me a new vfs folder named /scratch/session', expectedTool: 'fs.createfolder', expectedParams: { path: '/scratch/session' } },
  { category: 'filesystem', request: 'set up the directory /out/november in the shared vfs', expectedTool: 'fs.createfolder', expectedParams: { path: '/out/november' }, split: 'validation' },
  { category: 'filesystem', request: 'save the json payload {"status":"ok"} as /workspace/status.json in the shared virtual filesystem', expectedTool: 'fs.writefile', expectedParams: { path: '/workspace/status.json', content: '{"status":"ok"}' }, split: 'test' },
  { category: 'filesystem', request: 'dump this text into /notes/idea.txt in the vfs: cache the lint results', expectedTool: 'fs.writefile', expectedParams: { path: '/notes/idea.txt', content: 'cache the lint results' } },
  { category: 'filesystem', request: 'resolve the canonical virtual path of /workspace/sub/../notes/draft.txt', expectedTool: 'fs.getpath', expectedParams: { path: '/workspace/sub/../notes/draft.txt' }, split: 'test' },
  { category: 'filesystem', request: 'clean up the vfs by deleting /tmp/scratch-pad.txt', expectedTool: 'fs.deletefile', expectedParams: { path: '/tmp/scratch-pad.txt' } },
  { category: 'filesystem', request: 'remove the empty vfs folder /scratch/old-session', expectedTool: 'fs.deletefolder', expectedParams: { path: '/scratch/old-session' } },
  { category: 'filesystem', request: 'search the shared vfs for anything named invoice under /finance', expectedTool: 'fs.find', expectedParams: { query: 'invoice', path: '/finance' } },
  { category: 'filesystem', request: 'locate files matching report in the vfs start folder', expectedTool: 'fs.find', expectedParams: { query: 'report' }, split: 'validation' },
  { category: 'filesystem', request: 'does the vfs file /exports/dataset.csv exist?', expectedTool: 'fs.hasfile', expectedParams: { path: '/exports/dataset.csv' } },
  { category: 'filesystem', request: 'check that /configs/limits.json is present in the shared vfs', expectedTool: 'fs.hasfile', expectedParams: { path: '/configs/limits.json' }, split: 'validation' },
  { category: 'filesystem', request: 'clone /templates/header.html to /templates/header-v2.html inside the vfs', expectedTool: 'fs.copy', expectedParams: { path: '/templates/header.html', to: '/templates/header-v2.html' } },
  { category: 'filesystem', request: 'shift /logs/today.log into /logs/archive/today.log in the vfs', expectedTool: 'fs.move', expectedParams: { path: '/logs/today.log', to: '/logs/archive/today.log' } },
  { category: 'filesystem', request: 'give me a download link for /out/weekly-final.csv', expectedTool: 'fs.download', expectedParams: { path: '/out/weekly-final.csv' } },
  { category: 'filesystem', request: 'the operator will provide /imports/metrics.json from their device — start the pick flow', expectedTool: 'fs.upload', expectedParams: { path: '/imports', suggestedName: 'metrics.json' } },
  { category: 'image', request: 'i need a cover visual for the incident postmortem: a burning server room, dramatic lighting', expectedTool: 'image.generate', expectedParams: { prompt: 'A burning server room, dramatic lighting, smoke and ember particles, cinematic wide shot, postmortem cover art' }, split: 'validation' },
  { category: 'image', request: 'create an illustration of two servers shaking hands for the blog', expectedTool: 'image.generate', expectedParams: { prompt: 'Two stylized server racks shaking hands, friendly illustration, soft studio lighting, clean background' } },
  { category: 'server-ops', request: 'is api-01 up right now?', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' }, split: 'validation' },
  { category: 'server-ops', request: 'web-02 needs a restart — the render worker is stuck (servcie restart)', expectedTool: 'service.restart', expectedParams: { serverId: 'web-02' }, split: 'validation' },
  { category: 'server-ops', request: 'restart the whole api-01 box', expectedTool: 'server.restart', expectedParams: { serverId: 'api-01' } },
  { category: 'server-ops', request: 'give me the fleet overview with cpu and memory', expectedTool: 'server.list' },
  { category: 'server-ops', request: 'check whether web-01 responds to health checks', expectedTool: 'server.health', expectedParams: { serverId: 'web-01' } },
  { category: 'notification', request: 'alert the operator that the queue is backlogged', expectedTool: 'notification.send', expectedParams: { title: 'queue backlogged', body: 'the event queue is accumulating faster than it drains', level: 'warning' } },
  { category: 'notification', request: 'critical notice: the primary database is unreachable', expectedTool: 'notification.send', expectedParams: { title: 'primary database unreachable', body: 'the primary database is not responding', level: 'critical' } },
  { category: 'nexool-identity', request: 'what is your opinion on retrying immediately versus backing off after timeouts?', expectedTool: 'ask.self', expectedParams: { prompt: 'What is your opinion on retrying immediately versus backing off after timeouts?' } },
  { category: 'askself', request: 'wait two seconds before the next step of the plan', expectedTool: 'delay.wait', expectedParams: { ms: 2000 }, split: 'validation' },
  { category: 'patterns', request: 'pause briefly so the device can catch up: 1.5 seconds', expectedTool: 'delay.wait', expectedParams: { ms: 1500 } },
  { category: 'terminal', request: 'show the host disk usage summary', expectedTool: 'fs.cmd', expectedParams: { command: 'df -h' } },
  { category: 'terminal', request: 'count the files in the current host directory', expectedTool: 'fs.cmd', expectedParams: { command: 'ls -1 | wc -l' } },
];

// ---------- split-coverage completion ----------
// v1.0.3 predated the v1.0.13/v1.0.14 tool additions (fs.find, fs.copy,
// fs.move, fs.cmd, fs.download, fs.upload, ask.user) — its trained class list
// only held 25 of the current 33 tools. The v1.0.4 curriculum teaches ALL
// registered tools in every split; these examples close the remaining gaps.
const coverage: Batch = [
  { category: 'filesystem', request: 'find every file matching the name draft under /projects in the shared vfs', expectedTool: 'fs.find', expectedParams: { query: 'draft', path: '/projects' }, split: 'test' },
  { category: 'filesystem', request: 'duplicate the folder /themes/dark into /themes/dark-v2 inside the vfs for a variant test', expectedTool: 'fs.copy', expectedParams: { path: '/themes/dark', to: '/themes/dark-v2' }, split: 'validation' },
  { category: 'filesystem', request: 'copy /docs/api.md to /docs/api-snapshot.md in the shared vfs before I edit the original', expectedTool: 'fs.copy', expectedParams: { path: '/docs/api.md', to: '/docs/api-snapshot.md' }, split: 'test' },
  { category: 'filesystem', request: 'relocate /uploads/notes.txt to /archive/notes.txt within the vfs', expectedTool: 'fs.move', expectedParams: { path: '/uploads/notes.txt', to: '/archive/notes.txt' }, split: 'validation' },
  { category: 'filesystem', request: 'rename /out/weekly.csv to /out/weekly-final.csv in the shared vfs', expectedTool: 'fs.move', expectedParams: { path: '/out/weekly.csv', to: '/out/weekly-final.csv' }, split: 'test' },
  { category: 'terminal', request: 'show the host kernel and architecture with uname', expectedTool: 'fs.cmd', expectedParams: { command: 'uname -a' }, split: 'validation' },
  { category: 'filesystem', request: 'produce a shareable download link for /reports/summary.pdf in the vfs', expectedTool: 'fs.download', expectedParams: { path: '/reports/summary.pdf' }, split: 'validation' },
  { category: 'filesystem', request: 'generate the short-lived download url for /exports/backup.zip', expectedTool: 'fs.download', expectedParams: { path: '/exports/backup.zip' }, split: 'test' },
  { category: 'tool-understanding', request: 'the operator has a csv on their laptop — ask them to pick it and store it as /imports/data.csv', expectedTool: 'fs.upload', expectedParams: { path: '/imports', suggestedName: 'data.csv', message: 'Choose the CSV file to import' }, split: 'train' },
  { category: 'tool-understanding', request: 'which tool lets the operator choose a file from their device into the vfs — request it for /uploads/photo.jpg', expectedTool: 'fs.upload', expectedParams: { path: '/uploads', suggestedName: 'photo.jpg' }, split: 'test' },
  { category: 'askforuser', request: 'two deployment targets match the name staging — ask me which one you should use', expectedTool: 'ask.user', expectedParams: { message: 'Which staging target should I deploy to?' }, split: 'test' },
];

// ---------- assemble with split balancing ----------
const appended: Example[] = [];
const batches: Array<{ batch: Batch; topic: string }> = [
  { batch: coding, topic: 'coding (expanded)' },
  { batch: errors, topic: 'error understanding' },
  { batch: generalKnowledge, topic: 'general knowledge' },
  { batch: languages, topic: 'coding languages' },
  { batch: creative, topic: 'generative/creative' },
  { batch: complexContent, topic: 'complex content' },
  { batch: patterns, topic: 'pattern understanding' },
  { batch: selfUnderstanding, topic: 'self understanding' },
  { batch: pcb, topic: 'pcb design' },
  { batch: electronics, topic: 'electronic components' },
  { batch: electricity, topic: 'electricity' },
  { batch: softwareEngineering, topic: 'software engineering' },
  { batch: computerEngineering, topic: 'computer engineering' },
  { batch: design, topic: 'design' },
  { batch: improvement, topic: 'intelligent improvement' },
  { batch: toolBody, topic: 'tool title+body' },
  { batch: askSelfBatch, topic: 'askself' },
  { batch: askForUserBatch, topic: 'askforuser' },
  { batch: userEvents, topic: 'user events' },
  { batch: approvals, topic: 'approval states' },
  { batch: terminal, topic: 'terminal environments' },
  { batch: planner, topic: 'planner' },
  { batch: jsonUnderstanding, topic: 'json understanding' },
  { batch: richText, topic: 'rich text' },
  { batch: coverage, topic: 'split coverage completion' },
  { batch: round2, topic: 'round-2 confusion pairs (§53 benchmark-driven)' },
];
for (const { batch } of batches) {
  for (const e of batch) {
    appended.push({
      category: e.category,
      request: e.request,
      ...(e.expectedTool ? { expectedTool: e.expectedTool } : {}),
      ...(e.expectedParams ? { expectedParams: e.expectedParams } : {}),
      split: e.split ?? 'train',
    });
  }
}

// ---------- validation against the REAL registry ----------
const all = [...carryOver, ...appended];
const validationErrors: string[] = [];

const seen = new Set<string>();
for (const e of all) {
  const key = e.request.replace(/\s+/g, ' ').trim().toLowerCase();
  if (seen.has(key)) validationErrors.push(`duplicate request: ${e.request.slice(0, 60)}`);
  seen.add(key);
}
const schemaOf = new Map(BUILTIN_TOOLS.map((t) => [t.name, t.schema]));
for (const e of appended) {
  if (!e.expectedTool) continue;
  if (!schemaOf.has(e.expectedTool)) validationErrors.push(`unknown tool: ${e.expectedTool}`);
  else {
    const def = schemaOf.get(e.expectedTool)!;
    const known = new Set(def.properties.map((p) => p.name));
    for (const [k, v] of Object.entries(e.expectedParams ?? {})) {
      if (!known.has(k)) { validationErrors.push(`param "${k}" not in ${e.expectedTool} schema`); continue; }
      const meta = def.properties.find((p) => p.name === k)!;
      if (meta.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) {
        validationErrors.push(`param "${k}" of ${e.expectedTool} must be an object`);
      }
      if (meta.type === 'number' && typeof v !== 'number') {
        validationErrors.push(`param "${k}" of ${e.expectedTool} must be a number`);
      }
      if (meta.enumValues && !meta.enumValues.includes(String(v))) {
        validationErrors.push(`param "${k}" of ${e.expectedTool} must be one of ${meta.enumValues.join('|')}`);
      }
    }
    for (const p of def.properties) {
      if (p.required && !(p.name in (e.expectedParams ?? {}))) {
        validationErrors.push(`required param "${p.name}" missing for ${e.expectedTool} example: ${e.request.slice(0, 50)}`);
      }
    }
  }
}
for (const t of BUILTIN_TOOLS) {
  for (const split of ['train', 'validation', 'test'] as const) {
    if (!all.some((e) => e.expectedTool === t.name && e.split === split)) {
      validationErrors.push(`tool ${t.name} missing from split ${split} (v1.0.4 must keep full coverage)`);
    }
  }
}

if (validationErrors.length > 0) {
  console.error('VALIDATION FAILED:');
  for (const e of validationErrors) console.error(' -', e);
  process.exit(1);
}

const dataset = {
  name: 'NexTool seed curriculum',
  version: '1.0.4',
  note: 'v1.0.15 (model v1.0.4) — carries the full v1.0.3 curriculum and adds the expanded knowledge domains: coding, error understanding, general knowledge, coding languages, generative/creative (AskSelf), complex content, patterns, self-understanding, PCB, electronics, electricity, software/computer engineering, design, intelligent improvement, tool title+body+environment, AskSelf/AskForUser, user events, approval states (accept/skip/reject), terminal environments, planner/recovery and JSON understanding (v1.0.15 spec §1-§9, §50-§57).',
  examples: all,
};

const out = 'config/training/seed-dataset-v1.0.4.json';
await Bun.write(out, JSON.stringify(dataset, null, 2) + '\n');

const counts = {
  total: all.length,
  appended: appended.length,
  train: all.filter((e) => e.split === 'train').length,
  validation: all.filter((e) => e.split === 'validation').length,
  test: all.filter((e) => e.split === 'test').length,
  categories: new Set(all.map((e) => e.category)).size,
  longMarkdown: all.filter((e) => e.request.length > 1000).length,
};
console.log(`[ok] wrote ${out}`);
console.log(`     ${JSON.stringify(counts)}`);
