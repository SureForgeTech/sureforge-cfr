import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError, EXIT } from '../exit-codes.js';

export type SupportedClient = 'cursor' | 'claude' | 'windsurf' | 'vscode';

/** Every client the installer knows, in the order `--client all` uses. */
const SUPPORTED_CLIENTS: readonly SupportedClient[] = ['cursor', 'claude', 'windsurf', 'vscode'];

/** True for a name the installer knows. */
function isSupportedClient(value: string): value is SupportedClient {
  return (SUPPORTED_CLIENTS as readonly string[]).includes(value);
}

/**
 * The clients one `--client` value names, deduplicated and validated.
 *
 * The CLI parser checks the flag itself, but `runMcpInstallCommand` is also a
 * library surface, and there the value was CAST to the union: an unknown name
 * reached `clientConfigPath`, whose switch has no case for it and returns
 * `undefined`, so the installer tried to write a file at "undefined".
 *
 * @throws {CommandError} (exit 2) for a name the installer does not know.
 */
function resolveClients(rawClient: string): readonly SupportedClient[] {
  if (rawClient === 'all') return SUPPORTED_CLIENTS;
  const names = [...new Set(rawClient.split(',').map((name) => name.trim()))].filter(
    (name) => name !== '',
  );
  if (names.length === 0 || !names.every(isSupportedClient)) {
    throw new CommandError(
      `client must be one of: ${SUPPORTED_CLIENTS.join(', ')}, all`,
      EXIT.USAGE,
    );
  }
  return names as SupportedClient[];
}

export interface McpInstallOptions {
  readonly client?: string | undefined;
  readonly workspace?: boolean | undefined;
  readonly print?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly homedir?: string | undefined;
}

export interface McpInstallResult {
  readonly client: SupportedClient;
  readonly path: string;
  readonly updated: boolean;
  readonly status: 'updated' | 'created' | 'printed';
}

const MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'cfr-free@latest', 'mcp'],
};

/** Determine target config paths for each supported client. */
export function clientConfigPath(
  client: SupportedClient,
  options: { cwd: string; homedir: string; workspace?: boolean | undefined },
): string {
  const { cwd, homedir, workspace } = options;
  switch (client) {
    case 'cursor':
      return workspace === false
        ? path.join(
            homedir,
            'Library',
            'Application Support',
            'Cursor',
            'User',
            'globalStorage',
            'cursor.mcp',
            'mcp.json',
          )
        : path.join(cwd, '.cursor', 'mcp.json');
    case 'vscode':
      return path.join(cwd, '.vscode', 'mcp.json');
    case 'windsurf':
      return path.join(homedir, '.codeium', 'windsurf', 'mcp_config.json');
    case 'claude':
      if (process.platform === 'win32') {
        const appData = process.env['APPDATA'] ?? path.join(homedir, 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'darwin') {
        return path.join(
          homedir,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        );
      }
      return path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

/** Generate a snippet object for display. */
export function formatMcpSnippet(): string {
  return JSON.stringify({ mcpServers: { 'cfr-free': MCP_ENTRY } }, null, 2);
}

/**
 * The parsed config already at `targetPath`, or null when there is none.
 *
 * A file that exists but cannot be read or parsed is REFUSED, not replaced.
 * Client config files are the user's: a VS Code or Cursor file may contain
 * comments or trailing commas that `JSON.parse` rejects, and the previous
 * "start fresh" fallback silently destroyed every other server entry in it.
 * The installer only ever rewrites a config it can understand.
 *
 * @throws {CommandError} (exit 5) when a file exists but is unreadable,
 *   not valid UTF-8, invalid JSON, or not a JSON object.
 */
function readExistingConfig(targetPath: string): Record<string, unknown> | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CommandError(
      `cannot read ${targetPath} — refusing to overwrite it; fix its permissions or remove it first`,
      EXIT.REFUSED,
    );
  }

  // Decode STRICTLY. A lenient `readFileSync(path, 'utf8')` replaces invalid
  // bytes with U+FFFD, so a Windows-1252 config can still look like valid
  // JSON, parse, and be rewritten with the original bytes destroyed — the
  // exact loss this function exists to prevent. `fatal: true` refuses it.
  // The default `ignoreBOM: false` also drops a leading UTF-8 BOM, which
  // Windows editors write and which `JSON.parse` would reject.
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CommandError(
      `${targetPath} is not valid UTF-8 — refusing to overwrite it; re-save it as UTF-8 or remove the file`,
      EXIT.REFUSED,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommandError(
      `${targetPath} is not valid JSON — refusing to overwrite it; add the cfr-free entry by hand or remove the file`,
      EXIT.REFUSED,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError(
      `${targetPath} does not contain a JSON object — refusing to overwrite it; remove the file and re-run`,
      EXIT.REFUSED,
    );
  }
  const config = parsed as Record<string, unknown>;
  // The same rule one level down: entries live under `mcpServers`, so a
  // non-object there means the entries cannot be merged — rewriting would
  // delete them. Checking it here keeps every "cannot understand" reason in
  // one place.
  const servers = config['mcpServers'];
  if (
    servers !== undefined &&
    (servers === null || typeof servers !== 'object' || Array.isArray(servers))
  ) {
    throw new CommandError(
      `${targetPath} has a non-object "mcpServers" — refusing to overwrite it; remove the file and re-run`,
      EXIT.REFUSED,
    );
  }
  return config;
}

/** Install or update MCP server config for the given client. */
export function installClientConfig(
  _client: SupportedClient,
  targetPath: string,
): { updated: boolean; status: 'updated' | 'created' } {
  const existing = readExistingConfig(targetPath);
  const isCreated = existing === null;
  const config: Record<string, unknown> = existing ?? {};

  const mcpServers =
    config['mcpServers'] &&
    typeof config['mcpServers'] === 'object' &&
    !Array.isArray(config['mcpServers'])
      ? (config['mcpServers'] as Record<string, unknown>)
      : {};

  mcpServers['cfr-free'] = MCP_ENTRY;
  config['mcpServers'] = mcpServers;

  const parentDir = path.dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  return {
    updated: true,
    status: isCreated ? 'created' : 'updated',
  };
}

/** Execute the `cfr-free mcp install` command. */
export function runMcpInstallCommand(options: McpInstallOptions = {}): {
  readonly results: readonly McpInstallResult[];
  readonly output: string;
} {
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir();
  const clients = resolveClients((options.client ?? 'all').toLowerCase());

  if (options.print === true) {
    const lines = [
      '# Add cfr-free to your MCP client configuration:\n',
      'For Cursor (.cursor/mcp.json), Claude Desktop (claude_desktop_config.json), or Windsurf (mcp_config.json):\n',
      '```json',
      formatMcpSnippet(),
      '```',
    ];
    return {
      results: clients.map((client) => ({
        client,
        path: clientConfigPath(client, { cwd, homedir, workspace: options.workspace }),
        updated: false,
        status: 'printed',
      })),
      output: lines.join('\n') + '\n',
    };
  }

  const results: McpInstallResult[] = [];
  const lines: string[] = [];

  for (const client of clients) {
    const targetPath = clientConfigPath(client, { cwd, homedir, workspace: options.workspace });
    const { updated, status } = installClientConfig(client, targetPath);
    results.push({ client, path: targetPath, updated, status });
    lines.push(`✓ Configured cfr-free for ${client}: ${targetPath}`);
  }

  lines.push('\ncfr-free MCP server is configured. Restart or reload your AI editor to connect.');
  return { results, output: lines.join('\n') + '\n' };
}
