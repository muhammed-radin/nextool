/**
 * NexTool v1.0.13 §2 — FS Inspector file-type knowledge (pure, client-safe).
 *
 * Shared by the inspector API routes and the console UI: extension → rough
 * MIME type, the text-like extension set used for previews/editors, image
 * extensions and the Monaco language map. No Node/browser APIs here.
 */

/** Extensions that preview/edit as text (spec §2.3). */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'less',
  'html', 'htm', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'xml', 'csv', 'tsv', 'sh',
  'bash', 'zsh', 'env', 'properties', 'sql', 'graphql', 'gql', 'vue', 'svelte', 'php', 'rb',
  'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'dart', 'tex', 'gitignore',
  'dockerignore', 'editorconfig', 'babelrc', 'prettierrc', 'eslintrc', 'npmrc', 'prisma', 'lock',
  'license', 'readme', 'makefile', 'cmake', 'diff', 'patch', 'htaccess', 'plist',
]);

/** Extensions previewable as images (spec §2.3). */
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  html: 'text/html',
  htm: 'text/html',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  env: 'text/plain',
  sql: 'application/sql',
  graphql: 'application/graphql',
  gql: 'application/graphql',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java-source',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'application/x-httpd-php',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Rough "MIME-ish" type from the file extension (empty string for unknown). */
export function mimeishType(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return MIME_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? '';
}

/** Monaco language id for a file name (falls back to plaintext). */
export function monacoLanguage(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'hpp':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'sql':
      return 'sql';
    case 'toml':
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'env':
      return 'ini';
    default:
      return 'plaintext';
  }
}

export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isTextLike(name: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

export function isImageLike(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}
