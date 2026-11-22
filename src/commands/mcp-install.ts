import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

  const mode = isCreated ? undefined : writableMode(targetPath);
  const parentDir = path.dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });
  writeConfigAtomically(targetPath, JSON.stringify(config, null, 2) + '\n', mode);

  return {
    updated: true,
    status: isCreated ? 'created' : 'updated',
  };
}

/**
 * The permission bits of a config that is already there, refusing one this
 * process may not write.
 *
 * Two facts live here. `rename` REPLACES the target, and the replacement's
 * mode is the one that survives — so the original bits are carried over and
 * the installer's effect on a file it updates stays what it was. And a
 * rename needs write permission on the DIRECTORY, not on the file, so an
 * atomic write would silently replace a config the user had made read-only;
 * the explicit check keeps the old outcome (an error, file intact) for that
 * case instead of silently succeeding.
 *
 * @throws {Error} when the existing file is not writable (exit 1, as the
 *   in-place write did).
 */
function writableMode(targetPath: string): number | undefined {
  let mode: number;
  try {
    mode = statSync(targetPath).mode & 0o777;
    accessSync(targetPath, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A plain Error, not a CommandError: the file is readable but not
    // writable, so this is the same "write failed" outcome the in-place
    // write used to produce (exit 1), not the exit-5 refusal for a config
    // that cannot be understood.
    throw new Error(
      `cannot write ${targetPath} — the config is read-only; fix its permissions or remove it first`,
      { cause: error },
    );
  }
  return mode;
}

/**
 * Replace `targetPath` with `contents` in one step.
 *
 * A bare `writeFileSync` truncates the target before it writes, so a crash,
 * a full disk or a killed process leaves the reader with a half-written
 * client config — and this command refuses to rewrite a config it cannot
 * parse, so a torn write would leave a file it will not repair. Writing a
 * sibling temp file, fsync-ing it and renaming it into place is atomic on the
 * same filesystem: the config is either untouched or fully replaced, and the
 * bytes the rename publishes are already on the disk.
 *
 * The rename is a DIRECTORY operation, so replacing the file needs write
 * permission on its directory even when the file itself is writable; that is
 * stated in SPEC, because the old in-place write did not need it. The
 * directory is synced after the rename for the same reason the file is
 * synced before it: the entry must reach the disk too.
 *
 * `flag: 'wx'` REFUSES an existing temp path rather than opening it. Without
 * that, a pre-created symlink at the predictable temp name would redirect
 * the write to whatever it points at. The temp name carries the pid so two
 * concurrent runs do not collide, and nothing is removed unless this call
 * created it.
 *
 * A target that is a SYMLINK is written through to the file it points at:
 * the in-place write followed the link, and users keep these configs in
 * dotfiles repositories. Renaming onto the link would replace it with a
 * regular file and quietly detach the config from wherever it is tracked.
 */
function writeConfigAtomically(
  targetPath: string,
  contents: string,
  mode: number | undefined,
): void {
  const destination = resolveWriteTarget(targetPath);
  const tempPath = `${destination}.${process.pid}.cfr-free.tmp`;
  // `openSync` with 'wx' is what makes the temp file OURS: it either creates
  // a brand-new entry or throws. Only a file this call created is removed
  // on the way out, so an existing temp (or a symlink squatting on the
  // name) is never deleted or written through.
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(tempPath, 'wx', mode ?? 0o666);
    created = true;
    writeFileSync(fd, contents, 'utf8');
    // Get the bytes onto the disk BEFORE the rename publishes the name: a
    // rename that commits ahead of its data leaves a power-cut reader with an
    // empty or partial config, which is the failure this function exists to
    // prevent. One extra fsync for a command that runs once per setup.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // `mode` at creation is masked by the process umask, so an existing
    // 0664 config would come back 0644. Set the bits explicitly instead.
    if (mode !== undefined) chmodSync(tempPath, mode);
    renameSync(tempPath, destination);
    // The rename publishes the NAME, and that is a directory change: syncing
    // the file's bytes does not make the entry durable, so a power cut after
    // a successful install could still lose the config. Best effort — the
    // bytes are already in place, so a directory that cannot be opened or
    // synced (Windows cannot open a directory at all) must not turn a
    // completed write into a failed command.
    syncDirectory(path.dirname(destination));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    // `created` is set as soon as `openSync` returns, so a write that fails
    // part-way (ENOSPC, EIO, EDQUOT) still leaves nothing behind — and a
    // temp path this call did not create (EEXIST) is never removed.
    if (created) rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Ask the operating system to flush a directory's entries, so a name that a
 * rename just published survives a power cut. Best effort by design: this is
 * a durability improvement, not a precondition, and the caller has already
 * written every byte it promised.
 */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  let dirFd: number | undefined;
  try {
    dirFd = openSync(directory, 'r');
    fsyncSync(dirFd);
  } catch {
    // An unopenable or unsyncable directory (a network filesystem, a host
    // that refuses directory sync) does not invalidate the write.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // Nothing left to report: the config is in place.
      }
    }
  }
}

/**
 * The path a rename should target: the file at the end of a chain of
 * symlinks, whether or not that file exists yet.
 *
 * The in-place write FOLLOWED a symlinked config, and users keep these in
 * dotfiles repositories. Renaming onto the link would replace it with a
 * regular file and quietly detach the config from wherever it is tracked,
 * so the link chain is resolved here — including a link whose target does
 * not exist yet, which is how a dotfiles setup adds a config on first run.
 *
 * The walk stops at the first path with nothing at it, so the caller's own
 * spelling is kept for a new config, and a cycle is reported rather than
 * followed.
 *
 * A relative link is joined to its DIRECTORY, and that directory is
 * canonicalized first. `path.resolve` only rewrites `..` lexically: if the
 * config sits in a symlinked directory (`~/.cursor` → `/dotfiles/cursor`),
 * a link of `../shared.json` then resolves to the wrong file, and the rename
 * would replace content the config never read.
 */
function resolveWriteTarget(targetPath: string, depth = 0): string {
  if (depth >= 40) {
    throw new Error(`too many levels of symbolic links resolving ${targetPath}`);
  }
  let isLink: boolean;
  try {
    isLink = lstatSync(targetPath).isSymbolicLink();
  } catch {
    return targetPath;
  }
  if (!isLink) return targetPath;
  const link = readlinkSync(targetPath);
  const parent = canonicalDirectory(path.dirname(targetPath));
  return resolveWriteTarget(path.resolve(parent, link), depth + 1);
}

/**
 * The real path of `directory`, or of its longest existing ancestor with the
 * remaining names kept, so a directory that does not exist yet still resolves
 * everything above the missing part. `realpathSync` cannot be used alone: it
 * throws on the whole path when the last component is missing.
 */
function canonicalDirectory(directory: string): string {
  const missing: string[] = [];
  let current = directory;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return directory;
      missing.push(path.basename(current));
      current = parent;
    }
  }
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
