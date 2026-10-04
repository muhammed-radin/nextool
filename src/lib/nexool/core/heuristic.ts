/**
 * Heuristic fallback matcher — deterministic tool matching used when the LLM core
 * is unavailable. Transparent: output is tagged engine 'heuristic-fallback'.
 */
import type { CoreModuleOutput, ToolDefinition } from '../types';

const TYPO_FIXES: Record<string, string> = {
  moniter: 'monitor', monitoring: 'monitor', montior: 'monitor',
  infrom: 'inform', infom: 'inform', informtion: 'information',
  restrt: 'restart', restarrt: 'restart', restat: 'restart',
  servr: 'server', serer: 'server', serv: 'server',
  helth: 'health', healty: 'healthy', healhty: 'healthy',
  notifcation: 'notification', notifycation: 'notification',
  genrate: 'generate', generte: 'generate', creat: 'create', crate: 'create',
  memry: 'memory', meory: 'memory', statis: 'status', statu: 'status',
  chek: 'check', ceck: 'check', enviroment: 'environment', envirement: 'environment',
  iamge: 'image', imgae: 'image', prodution: 'production', prouduction: 'production',
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'please', 'and', 'or', 'to', 'of', 'me', 'my', 'if',
  'it', 'its', 'this', 'that', 'in', 'on', 'for', 'with', 'be', 'becomes', 'become', 'i',
  'you', 'we', 'should', 'would', 'can', 'could', 'do', 'does', 'did', 'when', 'then',
  'there', 'their', 'has', 'have', 'had', 'at', 'by', 'from', 'as', 'so', 'not', 'no',
]);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => TYPO_FIXES[w] ?? w)
    .join(' ')
    .replace(/[^a-z0-9\s._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  const raw = norm.split(/[\s._-]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // also keep dotted tool-ish tokens intact for matching (e.g. api-01)
  return [...new Set(raw)];
}

interface ToolDoc {
  def: ToolDefinition;
  tokens: Map<string, number>; // token → weight
  totalWeight: number;
}

function buildToolDoc(def: ToolDefinition): ToolDoc {
  const tokens = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) {
      tokens.set(t, Math.max(tokens.get(t) ?? 0, weight));
    }
  };
  add(def.name, 3);
  add(def.description, 1);
  if (def.purpose) add(def.purpose, 1);
  add(def.category, 1);
  for (const prop of def.schema.properties) {
    add(prop.name, 2);
    if (prop.enumValues) add(prop.enumValues.join(' '), 1);
  }
  const totalWeight = [...tokens.values()].reduce((a, b) => a + b, 0);
  return { def, tokens, totalWeight };
}

function scoreTool(requestTokens: string[], doc: ToolDoc): number {
  let iw = 0;
  for (const t of requestTokens) {
    const w = doc.tokens.get(t);
    if (w) iw += w;
  }
  const r = requestTokens.length;
  if (iw === 0) return 0;
  // F1-like weighted overlap
  return iw / (iw + 0.5 * (doc.totalWeight - iw) + 0.35 * (r - iw) * 2);
}

// ---------- Naive parameter extraction ----------

function extractParams(request: string, def: ToolDefinition): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const quoted = [...request.matchAll(/["'“”]([^"'“”]{1,300})["'“”]/g)].map((m) => m[1]).filter((s) => s.trim());
  const serverIdMatch = request.match(/(?:api|web|db)-\d+/i)?.[0];
  const numbers = [...request.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)].map((m) => Number(m[1]));
  const reqLower = request.toLowerCase();

  for (const prop of def.schema.properties) {
    const name = prop.name.toLowerCase();

    if (prop.type === 'number') {
      const hint = name === 'ms' || name === 'milliseconds' || name === 'wait';
      const candidate = numbers.find((n) => (hint ? n >= 100 : true)) ?? numbers[0];
      if (candidate !== undefined) {
        params[prop.name] = prop.min !== undefined && candidate < prop.min && name === 'count'
          ? Math.min(Math.max(Math.round(candidate), prop.min), prop.max ?? 10)
          : candidate;
        continue;
      }
      if (prop.required) params[prop.name] = prop.min ?? 1;
      continue;
    }

    if (prop.type === 'boolean') {
      if (prop.required) params[prop.name] = true;
      continue;
    }

    if (prop.type === 'array') {
      if (name.includes('tag')) {
        const tags = [...request.matchAll(/#(\w+)/g)].map((m) => m[1]);
        if (tags.length) params[prop.name] = tags;
      }
      if (prop.required && !params[prop.name]) params[prop.name] = [];
      continue;
    }

    if (prop.type === 'object') {
      if (prop.required && !params[prop.name]) {
        // value for memory.store: take the sentence minus a leading verb phrase
        params[prop.name] = request.trim().slice(0, 200);
      }
      continue;
    }

    // string params
    if (name.includes('server') || name.includes('service') || name.includes('host')) {
      if (serverIdMatch) {
        params[prop.name] = serverIdMatch.toLowerCase();
        continue;
      }
      if (prop.required) {
        const envServers = ['api-01', 'web-01', 'db-01'];
        const found = envServers.find((s) => reqLower.includes(s.split('-')[0]));
        params[prop.name] = found ?? 'api-01';
      }
      continue;
    }

    if (prop.enumValues && prop.enumValues.length > 0) {
      const hit = prop.enumValues.find((e) => reqLower.includes(e.toLowerCase()));
      if (hit) params[prop.name] = hit;
      else if (prop.required) params[prop.name] = prop.enumValues[0];
      continue;
    }

    if (name === 'expression' || name === 'expr' || name === 'formula') {
      const mathish = request.match(/[-(]?\d[\d\s.+\-*/%()]*\d\)?/);
      if (mathish) {
        params[prop.name] = mathish[0].trim();
        continue;
      }
      if (prop.required) params[prop.name] = '0';
      continue;
    }

    if (quoted.length > 0) {
      params[prop.name] = quoted[0];
      continue;
    }

    if (prop.generation === 'constructive') {
      // fallback: derive a short constructive value from the request
      params[prop.name] = request.trim().slice(0, 180) || 'n/a';
      continue;
    }

    if (prop.required) {
      params[prop.name] = request.trim().slice(0, 180) || 'n/a';
    }
  }
  return params;
}

// ---------- Public entry ----------

export interface HeuristicInput {
  objective: string;
  request?: string;
  toolDefs: ToolDefinition[];
  lastObservation?: string;
}

export function heuristicDecide(input: HeuristicInput): CoreModuleOutput {
  const text = `${input.request ?? ''} ${input.objective} ${input.lastObservation ?? ''}`;
  const requestTokens = tokenize(text);
  const started = Date.now();

  const docs = input.toolDefs.map(buildToolDoc);
  const scored = docs
    .map((doc) => ({ def: doc.def, score: scoreTool(requestTokens, doc) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const threshold = 0.18;

  if (!top || top.score < threshold) {
    return {
      status: 'no_tool',
      confidence: Math.min(0.6, Math.max(0.1, top ? top.score : 0)),
      reason: 'No registered tool sufficiently matches the current objective (heuristic fallback).',
      candidates: scored.slice(0, 3).map((s) => ({ tool: s.def.name, score: Math.round(s.score * 1000) / 1000 })),
      engine: 'heuristic-fallback',
      latencyMs: Date.now() - started,
    };
  }

  const missing = top.def.schema.properties.filter((p) => p.required).map((p) => p.name);
  const params = extractParams(text, top.def);
  const filled = missing.filter((m) => params[m] !== undefined && params[m] !== '');
  const stillMissing = missing.filter((m) => !filled.includes(m));

  if (stillMissing.length > 0) {
    return {
      status: 'clarification_required',
      missing: stillMissing,
      confidence: 0.5,
      reason: `Heuristic fallback could not fill required params: ${stillMissing.join(', ')}.`,
      candidates: scored.slice(0, 3).map((s) => ({ tool: s.def.name, score: Math.round(s.score * 1000) / 1000 })),
      engine: 'heuristic-fallback',
      latencyMs: Date.now() - started,
    };
  }

  return {
    status: 'tool_call',
    tool: top.def.name,
    params,
    confidence: Math.min(0.72, top.score + 0.1),
    reason: `Selected ${top.def.name} via deterministic keyword overlap (fallback engine).`,
    candidates: scored.slice(0, 3).map((s) => ({ tool: s.def.name, score: Math.round(s.score * 1000) / 1000 })),
    engine: 'heuristic-fallback',
    latencyMs: Date.now() - started,
  };
}
