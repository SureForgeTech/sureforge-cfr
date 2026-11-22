import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clientConfigPath,
  formatMcpSnippet,
  installClientConfig,
  runMcpInstallCommand,
} from '../src/commands/mcp-install.js';
import { CommandError, EXIT } from '../src/exit-codes.js';

describe('mcp-install', () => {
  it('formats snippet with npx command and mcp args', () => {
    const snippet = formatMcpSnippet();
    expect(snippet).toContain('"cfr-free"');
    expect(snippet).toContain('"command": "npx"');
    expect(snippet).toContain('"args": [');
    expect(snippet).toContain('"mcp"');
  });

  it('computes expected paths for cursor, vscode, and windsurf', () => {
    const cwd = '/test/workspace';
    const homedir = '/test/home';
    expect(clientConfigPath('cursor', { cwd, homedir })).toBe(
      path.join(cwd, '.cursor', 'mcp.json'),
    );
    expect(clientConfigPath('vscode', { cwd, homedir })).toBe(
      path.join(cwd, '.vscode', 'mcp.json'),
    );
    expect(clientConfigPath('windsurf', { cwd, homedir })).toBe(
      path.join(homedir, '.codeium', 'windsurf', 'mcp_config.json'),
    );
  });

  it('creates target file and injects cfr-free server entry', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-install-'));
    try {
      const target = path.join(tempDir, '.cursor', 'mcp.json');
      const result = installClientConfig('cursor', target);
      expect(result.status).toBe('created');
      expect(result.updated).toBe(true);

      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      expect(content['mcpServers']).toBeDefined();
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves existing servers when updating config', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-preserve-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(
        target,
        JSON.stringify({ mcpServers: { other: { command: 'other-cmd' } } }),
        'utf8',
      );
      const result = installClientConfig('cursor', target);
      expect(result.status).toBe('updated');

      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['other']).toEqual({ command: 'other-cmd' });
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts a config whose first byte is a byte-order mark', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-bom-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(target, '\uFEFF{"mcpServers":{"other":{"command":"other-cmd"}}}', 'utf8');
      expect(installClientConfig('cursor', target).status).toBe('updated');
      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['other']).toEqual({ command: 'other-cmd' });
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves no temp file behind after a successful write', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-atomic-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      installClientConfig('cursor', target);
      expect(readdirSync(tempDir)).toEqual(['mcp.json']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a config it cannot parse', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-invalid-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      // JSONC: VS Code and Cursor both accept comments and trailing commas in
      // their config files, and `JSON.parse` rejects them. The previous
      // behaviour replaced the whole file with `{"mcpServers": …}`.
      const original = '{\n  // my servers\n  "mcpServers": { "other": { "command": "x" } },\n}\n';
      writeFileSync(target, original, 'utf8');

      expect(() => installClientConfig('cursor', target)).toThrow(CommandError);
      try {
        installClientConfig('cursor', target);
      } catch (error) {
        expect((error as CommandError).exitCode).toBe(EXIT.REFUSED);
      }
      expect(readFileSync(target, 'utf8')).toBe(original);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a config whose root is not a JSON object', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-array-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(target, '[]\n', 'utf8');
      expect(() => installClientConfig('cursor', target)).toThrow(CommandError);
      expect(readFileSync(target, 'utf8')).toBe('[]\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a client name it does not know', () => {
    expect(() => runMcpInstallCommand({ client: 'emacs' })).toThrow(CommandError);
    let caught: unknown;
    try {
      runMcpInstallCommand({ client: 'cursor,emacs' });
    } catch (error) {
      caught = error;
    }
    // Outside the `catch`: an assertion inside it silently passes when
    // nothing is thrown at all, which is exactly the regression this covers.
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).exitCode).toBe(EXIT.USAGE);
  });

  it('refuses a config that is not valid UTF-8 instead of rewriting its bytes', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-utf8-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      // Windows-1252 "café" in a JSON string: `e9` is not valid UTF-8, but a
      // lenient decode turns it into U+FFFD and the file still parses.
      const original = Buffer.concat([
        Buffer.from('{"note":"caf'),
        Buffer.from([0xe9]),
        Buffer.from('","mcpServers":{}}'),
      ]);
      writeFileSync(target, original);

      let caught: unknown;
      try {
        installClientConfig('cursor', target);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CommandError);
      expect((caught as CommandError).exitCode).toBe(EXIT.REFUSED);
      expect(readFileSync(target).equals(original)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a config whose mcpServers is not an object', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-servers-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      for (const original of ['{"mcpServers":[]}\n', '{"mcpServers":"cursor"}\n']) {
        writeFileSync(target, original, 'utf8');
        expect(() => installClientConfig('cursor', target)).toThrow(CommandError);
        expect(readFileSync(target, 'utf8')).toBe(original);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of a config it updates', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-mode-'));
    // A umask of 002 would leave 0664 on a newly created file by itself, so
    // the test would pass with the chmod removed. Pin the umask that makes
    // the bits disappear, and restore whatever the runner had.
    const previousUmask = process.umask(0o022);
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(target, '{"mcpServers":{}}\n', 'utf8');
      chmodSync(target, 0o664);
      installClientConfig('cursor', target);
      expect(statSync(target).mode & 0o777).toBe(0o664);
    } finally {
      process.umask(previousUmask);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked config instead of replacing the link',
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-link-'));
      try {
        // Dotfile setups keep the real config in a tracked directory and
        // symlink the client's path at it; a rename onto the LINK would leave
        // the tracked file untouched and the user's setup broken.
        const real = path.join(tempDir, 'real.json');
        writeFileSync(real, '{"mcpServers":{"other":{"command":"x"}}}\n', 'utf8');
        const link = path.join(tempDir, 'mcp.json');
        symlinkSync(real, link);

        installClientConfig('cursor', link);

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        const content = JSON.parse(readFileSync(real, 'utf8')) as Record<string, unknown>;
        const servers = content['mcpServers'] as Record<string, unknown>;
        expect(servers['other']).toEqual({ command: 'x' });
        expect(servers['cfr-free']).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates the target of a dangling symlink instead of replacing the link',
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-dangling-'));
      try {
        // A dotfiles setup links the client's path at a tracked file it has
        // not created yet. Resolving the link must not fall back to the
        // link's own path: a rename there would replace it with a regular
        // file and detach the setup.
        const real = path.join(tempDir, 'tracked.json');
        const link = path.join(tempDir, 'mcp.json');
        symlinkSync(real, link);

        expect(installClientConfig('cursor', link).status).toBe('created');

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        const content = JSON.parse(readFileSync(real, 'utf8')) as Record<string, unknown>;
        expect(content['mcpServers']).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  // As root, `access(…, W_OK)` succeeds on a 0444 file, so there is nothing
  // for this check to refuse.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a read-only config instead of replacing it through the rename',
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-readonly-'));
      try {
        const target = path.join(tempDir, 'mcp.json');
        const original = '{"mcpServers":{"other":{"command":"x"}}}\n';
        writeFileSync(target, original, 'utf8');
        // The rename needs write permission on the DIRECTORY only, so without
        // an explicit check this read-only file would be replaced silently.
        chmodSync(target, 0o444);

        let caught: unknown;
        try {
          installClientConfig('cursor', target);
        } catch (error) {
          caught = error;
        }
        // The refusal is this module's, not the filesystem's: an OS error
        // would carry an errno code. Asserting on that rather than on the
        // message keeps a revert detectable without pinning the wording.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBeUndefined();
        chmodSync(target, 0o644);
        expect(readFileSync(target, 'utf8')).toBe(original);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a pre-created temp path instead of writing through it',
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-symlink-'));
      try {
        const target = path.join(tempDir, 'mcp.json');
        const victim = path.join(tempDir, 'victim.txt');
        writeFileSync(victim, 'untouched\n', 'utf8');
        // The temp name is predictable; a hostile or accidental file sitting
        // there must fail the install, not receive the config.
        symlinkSync(victim, `${target}.${process.pid}.cfr-free.tmp`);
        expect(() => installClientConfig('cursor', target)).toThrow();
        expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
        expect(existsSync(target)).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('supports --print mode without writing files', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-print-'));
    try {
      const res = runMcpInstallCommand({ print: true, cwd: tempDir, homedir: tempDir });
      expect(res.output).toContain('```json');
      expect(res.output).toContain('"cfr-free"');
      expect(res.results.every((r) => r.status === 'printed')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installs across clients in specified cwd and homedir', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-run-'));
    try {
      const res = runMcpInstallCommand({
        client: 'cursor,vscode',
        cwd: tempDir,
        homedir: tempDir,
      });
      expect(res.results.length).toBe(2);
      expect(res.output).toContain('Configured cfr-free for cursor');
      expect(res.output).toContain('Configured cfr-free for vscode');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
