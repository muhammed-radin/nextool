/**
 * NexTool v1.0.16 — seed dataset v1.0.5 generator (spec §5).
 *
 * Builds config/training/seed-dataset-v1.0.5.json by carrying over the whole
 * v1.0.4 curriculum (v1.0.15 generation) and appending the v1.0.16 CODING
 * batches (spec §5 — "Train/use examples that cover"):
 *
 *   L1  HTML + CSS (structure, layout, debugging, preview workflows)
 *   L2  JavaScript + TypeScript (syntax, async/await, APIs, npm/deps)
 *   L3  JSX/TSX — React components (writing, reading, prop errors)
 *   L4  Python (venv, pip, running, indentation errors)
 *   L5  Markdown + JSON (structure, parsing errors, JSON requests)
 *   L6  C / C++ (gcc/g++ compile, make, segmentation faults)
 *   L7  SQL (queries, schema, joins)
 *   L8  Shell/Bash (scripts, permissions, PATH, pipes)
 *   T1  reading code / explaining code (AskSelf generative routing)
 *   T2  writing code + file editing (fs.writefile)
 *   T3  debugging: error messages, stack traces, package/dependency errors
 *   T4  refactoring + multi-file projects (fs.find/fs.list navigation)
 *   T5  test writing + command-line workflows (fs.cmd)
 *   T6  no-tool + AskSelf routing for pure explanation, and honest
 *       clarification requests when a required path/file is missing
 *
 * Tool-routing policy taught CONSISTENTLY (a noisy mapping would hurt the
 * classifier): read/open/view → fs.readfile · write/save/create/edit files →
 * fs.writefile · run/build/test/compile/install/execute → fs.cmd · locate
 * definitions/usages/files → fs.find · list project structure → fs.list ·
 * explain/identify/interpret/generate content → ask.self · genuinely missing
 * required info → ask.user · existence checks → fs.hasfile.
 *
 * Every appended example is validated against the REAL registry before the
 * file is written: unique requests, real tools only, param keys inside the
 * real schemas, enum membership, required params, split balance and full
 * per-tool 3-split coverage. The generator exits non-zero on any violation.
 */
import { BUILTIN_TOOLS } from '../src/lib/nexool/tools/registry';
import v104 from '../config/training/seed-dataset-v1.0.4.json';

interface Example {
  category: string;
  request: string;
  expectedTool?: string;
  expectedParams?: Record<string, unknown>;
  split?: 'train' | 'validation' | 'test';
}

const carryOver = v104.examples as Example[];

type Batch = Array<Omit<Example, 'split'> & { split?: Example['split'] }>;

// ---------- L1 HTML + CSS ----------
const htmlCss: Batch = [
  { category: 'coding-html', request: 'read index.html from the site folder so I can check the markup', expectedTool: 'fs.readfile', expectedParams: { path: '/site/index.html' }, split: 'train' },
  { category: 'coding-html', request: 'show me the contents of landing.html', expectedTool: 'fs.readfile', expectedParams: { path: '/landing.html' }, split: 'validation' },
  { category: 'coding-html', request: 'open styles/main.css and show the theme variables', expectedTool: 'fs.readfile', expectedParams: { path: '/styles/main.css' }, split: 'train' },
  { category: 'coding-html', request: 'write a responsive hero section with a navbar into hero.html', expectedTool: 'fs.writefile', expectedParams: { path: '/hero.html', content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Hero</title>\n</head>\n<body>\n  <nav class="navbar" aria-label="Main navigation">\n    <a class="brand" href="/">Brand</a>\n    <ul class="nav-links">\n      <li><a href="#features">Features</a></li>\n      <li><a href="#pricing">Pricing</a></li>\n    </ul>\n  </nav>\n  <header class="hero">\n    <h1>Ship faster</h1>\n    <p>A responsive hero section that adapts from 320px to 4K.</p>\n  </header>\n</body>\n</html>\n' }, split: 'train' },
  { category: 'coding-html', request: 'create a new stylesheet dark-theme.css with CSS custom properties for a dark palette', expectedTool: 'fs.writefile', expectedParams: { path: '/dark-theme.css', content: ':root {\n  --bg: #0b0e14;\n  --surface: #151a23;\n  --text: #e6edf3;\n  --accent: #4ade80;\n  --muted: #8b98a9;\n}\n\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font-family: system-ui, sans-serif;\n}\n\n.card {\n  background: var(--surface);\n  border-radius: 12px;\n}\n' }, split: 'validation' },
  { category: 'coding-html', request: 'fix the broken flexbox centering in layout.css — the card is not centered', expectedTool: 'fs.readfile', expectedParams: { path: '/layout.css' }, split: 'train' },
  { category: 'coding-html', request: 'what does the CSS selector .nav > li:hover~.dropdown do?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain what the CSS selector .nav > li:hover ~ .dropdown does, including child combinator, hover pseudo-class and the general sibling combinator (~).' }, split: 'test' },
  { category: 'coding-html', request: 'validate my HTML: the button inside the form does not submit', expectedTool: 'ask.self', expectedParams: { prompt: 'A button inside an HTML form does not submit. List the common causes (missing type submit, form attribute mismatch, JS preventDefault, disabled state, invalid nested markup) and how to fix each.' }, split: 'train' },
  { category: 'coding-html', request: 'search the project for every place the class btn-primary is used', expectedTool: 'fs.find', expectedParams: { query: 'btn-primary' }, split: 'validation' },
  { category: 'coding-html', request: 'save this grid layout snippet to components/grid.css', expectedTool: 'fs.writefile', expectedParams: { path: '/components/grid.css', content: '.grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));\n  gap: 1rem;\n}\n' }, split: 'test' },
];

// ---------- L2 JavaScript + TypeScript ----------
const jsTs: Batch = [
  { category: 'coding-js', request: 'read app.js and tell me where the fetch call happens', expectedTool: 'fs.readfile', expectedParams: { path: '/app.js' }, split: 'train' },
  { category: 'coding-js', request: 'show src/utils/format.ts', expectedTool: 'fs.readfile', expectedParams: { path: '/src/utils/format.ts' }, split: 'validation' },
  { category: 'coding-js', request: 'write a TypeScript debounce function into src/debounce.ts', expectedTool: 'fs.writefile', expectedParams: { path: '/src/debounce.ts', content: 'export function debounce<T extends (...args: unknown[]) => void>(fn: T, waitMs = 250): (...args: Parameters<T>) => void {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  return (...args: Parameters<T>) => {\n    if (timer) clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), waitMs);\n  };\n}\n' }, split: 'train' },
  { category: 'coding-js', request: 'create a package.json scripts section that builds with tsc and watches with tsc --watch', expectedTool: 'fs.writefile', expectedParams: { path: '/package.json', content: '{\n  "name": "my-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "build": "tsc",\n    "watch": "tsc --watch",\n    "start": "node dist/index.js"\n  }\n}\n' }, split: 'test' },
  { category: 'coding-js', request: 'explain how async/await works in JavaScript', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain how async/await works in JavaScript: promises, the event loop, error handling with try/catch, sequential vs parallel awaits (Promise.all), and common pitfalls like unawaited promises.' }, split: 'train' },
  { category: 'coding-js', request: 'what is the difference between null and undefined in JS?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the difference between null and undefined in JavaScript, including typeof results, default parameters, and when each value appears.' }, split: 'validation' },
  { category: 'coding-js', request: 'run the TypeScript build and show me the compiler errors', expectedTool: 'fs.cmd', expectedParams: { command: 'npx tsc --noEmit 2>&1 | head -50' }, split: 'train' },
  { category: 'coding-js', request: 'install the lodash dependency with npm', expectedTool: 'fs.cmd', expectedParams: { command: 'npm install lodash' }, split: 'validation' },
  { category: 'coding-js', request: 'my node process crashes with EADDRINUSE — help me fix it', expectedTool: 'ask.self', expectedParams: { prompt: 'A Node.js process crashes with EADDRINUSE. Explain the cause (another listener holds the port), how to find the PID (lsof -i :PORT or ss -ltnp) and safe fixes (kill the stale process, change the port, SO_REUSEADDR).' }, split: 'test' },
  { category: 'coding-js', request: 'which file exports the parseDate helper? find it', expectedTool: 'fs.find', expectedParams: { query: 'parseDate', filesOnly: true }, split: 'train' },
  { category: 'coding-js', request: 'run eslint on the src folder', expectedTool: 'fs.cmd', expectedParams: { command: 'npx eslint src' }, split: 'validation' },
  { category: 'coding-js', request: 'TypeError: Cannot read properties of undefined (reading map) — what does it mean?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the JavaScript error "TypeError: Cannot read properties of undefined (reading \'map\')": the value is undefined at the call site, typical causes (uninitialized state, async data not yet loaded, wrong variable) and fixes (optional chaining, default [], guards).' }, split: 'train' },
];

// ---------- L3 JSX / TSX / React ----------
const reactTsx: Batch = [
  { category: 'coding-react', request: 'read components/Header.tsx so I can review the props', expectedTool: 'fs.readfile', expectedParams: { path: '/components/Header.tsx' }, split: 'train' },
  { category: 'coding-react', request: 'write a React button component with variants into Button.tsx', expectedTool: 'fs.writefile', expectedParams: { path: '/components/Button.tsx', content: "import type { ButtonHTMLAttributes } from 'react';\n\ntype Variant = 'primary' | 'ghost' | 'danger';\n\ninterface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {\n  variant?: Variant;\n}\n\nexport function Button({ variant = 'primary', ...rest }: ButtonProps) {\n  return <button className={`btn btn-${variant}`} {...rest} />;\n}\n" }, split: 'train' },
  { category: 'coding-react', request: 'why does React warn "Each child in a list should have a unique key prop"?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the React warning "Each child in a list should have a unique key prop": reconciliation, why array index keys are risky with reordering, and how to fix with stable ids.' }, split: 'validation' },
  { category: 'coding-react', request: 'run the vitest suite for the components folder', expectedTool: 'fs.cmd', expectedParams: { command: 'npx vitest run components' }, split: 'test' },
  { category: 'coding-react', request: 'find every usage of the UserProfile component in the codebase', expectedTool: 'fs.find', expectedParams: { query: 'UserProfile' }, split: 'train' },
  { category: 'coding-react', request: 'save a minimal App.tsx that renders a heading and a counter with useState', expectedTool: 'fs.writefile', expectedParams: { path: '/App.tsx', content: "import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main>\n      <h1>Counter</h1>\n      <button onClick={() => setCount((c) => c + 1)}>{count}</button>\n    </main>\n  );\n}\n" }, split: 'validation' },
];

// ---------- L4 Python ----------
const python: Batch = [
  { category: 'coding-python', request: 'read main.py and check the indentation of the parse_args function', expectedTool: 'fs.readfile', expectedParams: { path: '/main.py' }, split: 'train' },
  { category: 'coding-python', request: 'show scripts/ingest.py', expectedTool: 'fs.readfile', expectedParams: { path: '/scripts/ingest.py' }, split: 'validation' },
  { category: 'coding-python', request: 'write a python script that reads data.csv and prints the column totals', expectedTool: 'fs.writefile', expectedParams: { path: '/totals.py', content: 'import csv\nfrom collections import defaultdict\n\ntotals: dict[str, float] = defaultdict(float)\n\nwith open("data.csv", newline="", encoding="utf-8") as fh:\n    for row in csv.DictReader(fh):\n        for col, value in row.items():\n            try:\n                totals[col] += float(value)\n            except (TypeError, ValueError):\n                pass\n\nfor col, total in totals.items():\n    print(f"{col}: {total}")\n' }, split: 'train' },
  { category: 'coding-python', request: 'run the python unit tests with pytest', expectedTool: 'fs.cmd', expectedParams: { command: 'python -m pytest -q' }, split: 'validation' },
  { category: 'coding-python', request: 'create the requirements file and install requests', expectedTool: 'fs.cmd', expectedParams: { command: 'pip install requests && pip freeze > requirements.txt' }, split: 'test' },
  { category: 'coding-python', request: 'IndentationError: unexpected indent on line 12 — explain and fix', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the Python IndentationError "unexpected indent": mixing tabs/spaces or wrong nesting level, and how to fix it with consistent 4-space indentation.' }, split: 'train' },
  { category: 'coding-python', request: 'what is the difference between a list and a tuple in python?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the difference between a Python list and a tuple: mutability, memory, hashing, when to use each.' }, split: 'validation' },
  { category: 'coding-python', request: 'search the repo for every TODO comment in python files', expectedTool: 'fs.find', expectedParams: { query: 'TODO' }, split: 'test' },
];

// ---------- L5 Markdown + JSON ----------
const markdownJson: Batch = [
  { category: 'coding-docs', request: 'read README.md and summarize the setup steps', expectedTool: 'fs.readfile', expectedParams: { path: '/README.md' }, split: 'train' },
  { category: 'coding-docs', request: 'write a markdown changelog entry for release 2.1.0', expectedTool: 'fs.writefile', expectedParams: { path: '/CHANGELOG.md', content: '# Changelog\n\n## 2.1.0 — 2026-10-09\n\n### Added\n- Skills system with SKILL.md discovery\n\n### Fixed\n- Terminal session lifecycle never sticks in `starting`\n\n### Changed\n- Task Preview loads history in 40-item pages\n' }, split: 'train' },
  { category: 'coding-docs', request: 'is the config.json valid JSON? read it and check', expectedTool: 'fs.readfile', expectedParams: { path: '/config.json' }, split: 'validation' },
  { category: 'coding-docs', request: 'json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes — why?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain json.decoder.JSONDecodeError "Expecting property name enclosed in double quotes": trailing commas, single quotes or comments are invalid in strict JSON; show the fix.' }, split: 'test' },
  { category: 'coding-docs', request: 'convert this structured request into valid JSON with an items array', expectedTool: 'ask.self', expectedParams: { prompt: 'Convert the request into strict JSON: an object with an "items" array where each item has name and quantity as strings/numbers, double-quoted keys, no trailing commas.' }, split: 'validation' },
  { category: 'coding-docs', request: 'save the API response template into schemas/response.json', expectedTool: 'fs.writefile', expectedParams: { path: '/schemas/response.json', content: '{\n  "ok": true,\n  "data": {\n    "id": "string",\n    "createdAt": "2026-10-09T00:00:00.000Z"\n  },\n  "error": null\n}\n' }, split: 'train' },
];

// ---------- L6 C / C++ ----------
const cCpp: Batch = [
  { category: 'coding-cpp', request: 'compile main.c with gcc and warnings enabled', expectedTool: 'fs.cmd', expectedParams: { command: 'gcc -Wall -Wextra -o main main.c' }, split: 'train' },
  { category: 'coding-cpp', request: 'build the cpp project with g++ and c++17', expectedTool: 'fs.cmd', expectedParams: { command: 'g++ -std=c++17 -O2 -o app src/*.cpp' }, split: 'validation' },
  { category: 'coding-cpp', request: 'read queue.c and check the malloc return handling', expectedTool: 'fs.readfile', expectedParams: { path: '/queue.c' }, split: 'train' },
  { category: 'coding-cpp', request: 'the program crashes with a segmentation fault — how do I debug it?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain how to debug a segmentation fault in C/C++: compile with -g -fsanitize=address, run gdb with backtrace, common causes (null deref, out-of-bounds, use-after-free, stack overflow).' }, split: 'test' },
  { category: 'coding-cpp', request: 'undefined reference to `sqrt` — why does the link fail?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the linker error "undefined reference to sqrt": libm is not linked by default on some toolchains; fix with -lm at the END of the compile command.' }, split: 'validation' },
  { category: 'coding-cpp', request: 'write a Makefile that builds src/*.c into the binary server', expectedTool: 'fs.writefile', expectedParams: { path: '/Makefile', content: 'CC ?= gcc\nCFLAGS ?= -Wall -Wextra -O2\n\nserver: $(wildcard src/*.c)\n\t$(CC) $(CFLAGS) -o $@ $^\n\n.PHONY: clean\nclean:\n\trm -f server\n' }, split: 'train' },
  { category: 'coding-cpp', request: 'run make to rebuild the project', expectedTool: 'fs.cmd', expectedParams: { command: 'make -j2' }, split: 'test' },
];

// ---------- L7 SQL ----------
const sql: Batch = [
  { category: 'coding-sql', request: 'write a SQL query for the top 10 customers by total order amount', expectedTool: 'ask.self', expectedParams: { prompt: 'Write a SQL query: SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id ORDER BY total DESC LIMIT 10; explain the aggregation and ordering.' }, split: 'train' },
  { category: 'coding-sql', request: 'explain the difference between INNER JOIN and LEFT JOIN', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain INNER JOIN vs LEFT JOIN with a small example table pair and which rows survive each join.' }, split: 'validation' },
  { category: 'coding-sql', request: 'read the migration file 0002_add_indexes.sql', expectedTool: 'fs.readfile', expectedParams: { path: '/migrations/0002_add_indexes.sql' }, split: 'train' },
  { category: 'coding-sql', request: 'save a query that computes monthly revenue into reports/revenue.sql', expectedTool: 'fs.writefile', expectedParams: { path: '/reports/revenue.sql', content: "-- Monthly revenue\nSELECT\n  strftime('%Y-%m', created_at) AS month,\n  SUM(amount) AS revenue\nFROM orders\nGROUP BY month\nORDER BY month;\n" }, split: 'test' },
  { category: 'coding-sql', request: 'no such column: user_id in my sqlite query — help', expectedTool: 'ask.self', expectedParams: { prompt: 'The SQLite error "no such column: user_id" means the column does not exist in the queried table; check the schema with PRAGMA table_info(table), fix spelling/aliases, or add the column with a migration.' }, split: 'validation' },
];

// ---------- L8 Shell / Bash ----------
const shell: Batch = [
  { category: 'coding-shell', request: 'write a bash script that backs up the logs folder into a timestamped tar.gz', expectedTool: 'fs.writefile', expectedParams: { path: '/backup.sh', content: '#!/usr/bin/env bash\nset -euo pipefail\n\nSTAMP=$(date +%Y%m%d-%H%M%S)\ntar -czf "logs-${STAMP}.tar.gz" logs/\necho "wrote logs-${STAMP}.tar.gz"\n' }, split: 'train' },
  { category: 'coding-shell', request: 'make deploy.sh executable and run it', expectedTool: 'fs.cmd', expectedParams: { command: 'chmod +x deploy.sh && ./deploy.sh' }, split: 'train' },
  { category: 'coding-shell', request: 'bash: command not found: nvm — what is wrong?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain "bash: command not found: nvm": nvm is a shell function loaded by sourcing nvm.sh in the rc file, not a binary; fix by sourcing it or loading the rc file.' }, split: 'validation' },
  { category: 'coding-shell', request: 'list all files modified in the last 24 hours', expectedTool: 'fs.cmd', expectedParams: { command: 'find . -type f -mmin -1440 -print' }, split: 'test' },
  { category: 'coding-shell', request: 'read run.sh and explain the set -euo pipefail line', expectedTool: 'fs.readfile', expectedParams: { path: '/run.sh' }, split: 'validation' },
  { category: 'coding-shell', request: 'permission denied when executing build.sh — fix it', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain "permission denied" when running a script: the executable bit is missing (chmod +x build.sh) or the interpreter lacks permissions; also check shebang and ownership.' }, split: 'train' },
];

// ---------- T3 errors / stack traces / packages ----------
const errorsDeep: Batch = [
  { category: 'coding-errors', request: 'read the build log and find the first real error', expectedTool: 'fs.readfile', expectedParams: { path: '/build.log' }, split: 'train' },
  { category: 'coding-errors', request: 'interpret this stack trace: at parseUser (src/auth.ts:42:19)', expectedTool: 'ask.self', expectedParams: { prompt: 'Interpret the stack trace frame "at parseUser (src/auth.ts:42:19)": file src/auth.ts, line 42, column 19, inside function parseUser; explain how to read frames top-down and locate the throwing line.' }, split: 'train' },
  { category: 'coding-errors', request: 'npm ERR! ERESOLVE unable to resolve dependency tree — what now?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain npm ERR! ERESOLVE: peer dependency conflicts; fixes include installing the compatible versions, using --legacy-peer-deps deliberately, or updating the conflicting package.' }, split: 'validation' },
  { category: 'coding-errors', request: 're-run the failing command so I can see the exact error output', expectedTool: 'fs.cmd', expectedParams: { command: 'bash -lc "npm run build" 2>&1 | tail -40' }, split: 'train' },
  { category: 'coding-errors', request: 'ModuleNotFoundError: No module named yaml — explain the cause', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain ModuleNotFoundError: No module named yaml: the package is not installed in the active interpreter/venv; fix with pip install pyyaml inside the right environment.' }, split: 'test' },
  { category: 'coding-errors', request: 'check whether the lockfile exists before reinstalling', expectedTool: 'fs.hasfile', expectedParams: { path: '/package-lock.json' }, split: 'validation' },
];

// ---------- T4 refactoring / multi-file projects ----------
const refactoring: Batch = [
  { category: 'coding-refactor', request: 'refactor utils.js to split the big function into helpers and save the result', expectedTool: 'ask.self', expectedParams: { prompt: 'Refactor the large function in utils.js: propose helper extraction (pure functions, single responsibility), keep behavior identical, and show the refactored module.' }, split: 'train' },
  { category: 'coding-refactor', request: 'show the project structure so I can plan the refactor', expectedTool: 'fs.list', expectedParams: { path: '/src' }, split: 'validation' },
  { category: 'coding-refactor', request: 'find all files importing the deprecated helper', expectedTool: 'fs.find', expectedParams: { query: 'deprecated-helper' }, split: 'train' },
  { category: 'coding-refactor', request: 'rename legacyName to modernName across the config module', expectedTool: 'fs.cmd', expectedParams: { command: "grep -rl 'legacyName' config/ | xargs sed -i 's/legacyName/modernName/g'" }, split: 'test' },
  { category: 'coding-refactor', request: 'read both versions of the module and diff their exports', expectedTool: 'fs.readfile', expectedParams: { path: '/src/module.new.ts' }, split: 'validation' },
];

// ---------- T5 tests / CLI workflows ----------
const testsCli: Batch = [
  { category: 'coding-tests', request: 'write jest tests for the validateEmail function', expectedTool: 'ask.self', expectedParams: { prompt: 'Write jest tests for validateEmail: valid addresses, missing @, double dots, empty string, unicode local part; use describe/it with expect().toBe.' }, split: 'train' },
  { category: 'coding-tests', request: 'save the test file as tests/validateEmail.test.ts', expectedTool: 'fs.writefile', expectedParams: { path: '/tests/validateEmail.test.ts', content: "import { validateEmail } from '../src/validateEmail';\n\ndescribe('validateEmail', () => {\n  it('accepts a normal address', () => {\n    expect(validateEmail('ops@example.com')).toBe(true);\n  });\n  it('rejects a missing @', () => {\n    expect(validateEmail('ops.example.com')).toBe(false);\n  });\n  it('rejects an empty string', () => {\n    expect(validateEmail('')).toBe(false);\n  });\n});\n" }, split: 'validation' },
  { category: 'coding-tests', request: 'run the full test suite and report failures', expectedTool: 'fs.cmd', expectedParams: { command: 'npm test -- --run' }, split: 'train' },
  { category: 'coding-tests', request: 'execute the cli with --help and show the usage output', expectedTool: 'fs.cmd', expectedParams: { command: 'node cli.js --help' }, split: 'test' },
  { category: 'coding-tests', request: 'check that tests/setup.ts exists before running the suite', expectedTool: 'fs.hasfile', expectedParams: { path: '/tests/setup.ts' }, split: 'validation' },
];

// ---------- T6 honest routing: no-tool / clarification ----------
const routing: Batch = [
  { category: 'coding-routing', request: 'explain the event loop in one paragraph', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the JavaScript event loop in one paragraph: call stack, task queue, microtasks, and why setTimeout(fn, 0) is not immediate.' }, split: 'train' },
  { category: 'coding-routing', request: 'what does the spread operator do in JavaScript?', expectedTool: 'ask.self', expectedParams: { prompt: 'Explain the spread operator (...) in JavaScript: array/object expansion, shallow copies, and rest parameters.' }, split: 'validation' },
  { category: 'coding-routing', request: 'fix the bug in the file — which file do you mean?', expectedTool: 'ask.user', expectedParams: { message: 'Which file contains the bug you want fixed? Please provide the path.' }, split: 'train' },
  { category: 'coding-routing', request: 'deploy it — deploy what exactly? ask me for the target', expectedTool: 'ask.user', expectedParams: { message: 'What should I deploy, and to which target (server/folder/service)?' }, split: 'validation' },
  { category: 'coding-routing', request: 'show me the tests for the auth module', expectedTool: 'fs.find', expectedParams: { query: 'auth', foldersOnly: false }, split: 'test' },
];

const batches: { batch: Batch; topic: string }[] = [
  { batch: htmlCss, topic: 'HTML/CSS' },
  { batch: jsTs, topic: 'JavaScript/TypeScript' },
  { batch: reactTsx, topic: 'JSX/TSX React' },
  { batch: python, topic: 'Python' },
  { batch: markdownJson, topic: 'Markdown/JSON' },
  { batch: cCpp, topic: 'C/C++' },
  { batch: sql, topic: 'SQL' },
  { batch: shell, topic: 'Shell/Bash' },
  { batch: errorsDeep, topic: 'errors/stack traces/packages' },
  { batch: refactoring, topic: 'refactoring/multi-file' },
  { batch: testsCli, topic: 'tests/CLI' },
  { batch: routing, topic: 'routing/AskSelf/AskForUser' },
];

// ---------- assemble ----------
const appended: Example[] = [];
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
// v1.0.5 keeps the CARRIED-OVER coverage guarantees intact (every registered
// tool in every split) and adds split balance for the new batches.
for (const t of BUILTIN_TOOLS) {
  for (const split of ['train', 'validation', 'test'] as const) {
    if (!all.some((e) => e.expectedTool === t.name && e.split === split)) {
      validationErrors.push(`tool ${t.name} missing from split ${split} (v1.0.5 must keep full coverage)`);
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
  version: '1.0.5',
  note: 'v1.0.16 (model v1.0.5) — carries the full v1.0.4 curriculum and adds the coding release batches (v1.0.16 spec §5): HTML, CSS, JavaScript, TypeScript, JSX/TSX (React), Python, Markdown, JSON, C, C++, SQL, Shell/Bash — plus error messages/stack traces/package-dependency errors, code reading/writing/explaining, debugging, refactoring, file editing, APIs, async/await, test writing, HTML/CSS layout, command-line workflows, multi-file projects, structured JSON requests and complex natural-language instructions. Tool routing is taught consistently: fs.readfile / fs.writefile / fs.cmd / fs.find / fs.list / fs.hasfile / ask.self / ask.user.',
  examples: all,
};

const out = 'config/training/seed-dataset-v1.0.5.json';
await Bun.write(out, JSON.stringify(dataset, null, 2) + '\n');

const counts = {
  total: all.length,
  carriedOver: carryOver.length,
  appended: appended.length,
  train: all.filter((e) => e.split === 'train').length,
  validation: all.filter((e) => e.split === 'validation').length,
  test: all.filter((e) => e.split === 'test').length,
  categories: new Set(all.map((e) => e.category)).size,
  newCategories: new Set(appended.map((e) => e.category)).size,
};
console.log(`[ok] wrote ${out}`);
console.log(`     ${JSON.stringify(counts)}`);
