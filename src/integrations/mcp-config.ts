import { readFileSync } from 'node:fs';

// Shared between routes/meta.ts (GET /api/mcp/status, a reachability probe) and
// integrations/mcp-catalog.ts (a real tools/list enumeration) — both read the same
// mcpServers config shape, and routes compose integrations, not the reverse.
export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  headers?: Record<string, string>;
}

export function readMcpServersFile(path: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

export function transportOf(cfg: McpServerConfig): 'http' | 'sse' | 'stdio' {
  if (cfg.type === 'sse') return 'sse';
  if (cfg.type === 'stdio' || (!cfg.url && !!cfg.command)) return 'stdio';
  return 'http';
}
