/**
 * NexTool v1.0.7 §2 — tool search/filter.
 *
 * ONE pure filtering implementation shared by the Tools page (live client
 * filtering, no page reload). Case-insensitive, whitespace-trimmed, multi-
 * token (every token must match at least one field). Searches across the
 * useful tool metadata: name, description, category, environment, handler
 * kind, tool version and user metadata key/value pairs (tags equivalent),
 * where those fields exist.
 */

export interface SearchableTool {
  name: string;
  description?: string;
  purpose?: string;
  category?: string;
  environment?: string;
  handlerKind?: string;
  toolVersion?: string;
  metadata?: Record<string, string> | null;
}

function haystack(tool: SearchableTool): string {
  const parts: (string | undefined)[] = [
    tool.name,
    tool.description,
    tool.purpose,
    tool.category,
    tool.environment,
    tool.handlerKind,
    tool.toolVersion,
  ];
  if (tool.metadata && typeof tool.metadata === 'object') {
    for (const [k, v] of Object.entries(tool.metadata)) {
      parts.push(k, v);
    }
  }
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase();
}

/**
 * Filter tools for a query.
 * - empty/whitespace query → all tools (in the given order)
 * - case-insensitive; tokens are split on whitespace; every token must match
 *   (subString match, so "image" matches image.generate, image.edit, …)
 */
export function filterTools<T extends SearchableTool>(tools: T[], rawQuery: string): T[] {
  const query = String(rawQuery ?? '').trim().toLowerCase();
  if (!query) return [...tools];
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...tools];
  return tools.filter((tool) => {
    const hay = haystack(tool);
    return tokens.every((t) => hay.includes(t));
  });
}
