import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { describe, expect, it, vi } from 'vitest';
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

  // The directory entry is what a rename publishes, so the rename itself is
  // only durable once the directory has been synced. Both directory tests
  // substitute `node:fs` because the ordering and the failure are not
  // otherwise observable from a passing command.
  it.skipIf(process.platform === 'win32')(
    'flushes the directory entry after the rename',
    async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-dirsync-'));
      try {
        const target = path.join(tempDir, 'mcp.json');
        writeFileSync(target, '{"mcpServers":{}}\n', 'utf8');
        const events: string[] = [];

        vi.resetModules();
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          const opened = new Map<number, string>();
          return {
            ...actual,
            openSync: (
              file: Parameters<typeof actual.openSync>[0],
              flags: Parameters<typeof actual.openSync>[1],
              mode?: Parameters<typeof actual.openSync>[2],
            ): number => {
              const fd = actual.openSync(file, flags, mode);
              const label = flags === 'r' && file === tempDir ? 'directory' : 'temp';
              opened.set(fd, label);
              events.push(`open:${label}`);
              return fd;
            },
            writeFileSync: (
              file: Parameters<typeof actual.writeFileSync>[0],
              data: Parameters<typeof actual.writeFileSync>[1],
              options?: Parameters<typeof actual.writeFileSync>[2],
            ): void => {
              if (typeof file === 'number') events.push('write');
              actual.writeFileSync(file, data, options);
            },
            fsyncSync: (fd: number): void => {
              events.push(`fsync:${opened.get(fd) ?? 'unknown'}`);
              actual.fsyncSync(fd);
            },
            renameSync: (
              from: Parameters<typeof actual.renameSync>[0],
              to: Parameters<typeof actual.renameSync>[1],
            ): void => {
              events.push('rename');
              actual.renameSync(from, to);
            },
          };
        });
        const mocked = await import('../src/commands/mcp-install.js');

        expect(mocked.installClientConfig('cursor', target).status).toBe('updated');

        // Bytes before the name, name before its directory entry.
        expect(events.indexOf('write')).toBeLessThan(events.indexOf('fsync:temp'));
        expect(events[events.indexOf('rename') - 1]).toBe('fsync:temp');
        expect(events.slice(events.indexOf('rename') + 1)).toContain('fsync:directory');
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still installs when the filesystem refuses a directory sync',
    async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-dirsync-fail-'));
      try {
        const target = path.join(tempDir, 'mcp.json');
        writeFileSync(target, '{"mcpServers":{}}\n', 'utf8');

        vi.resetModules();
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            // A directory handler that cannot sync is a durability
            // limitation, not a reason to fail a write that succeeded.
            fsyncSync: (fd: number): void => {
              const isDirectory = actual.fstatSync(fd).isDirectory();
              if (isDirectory) {
                const error = new Error('EINVAL: invalid argument, fsync') as NodeJS.ErrnoException;
                error.code = 'EINVAL';
                throw error;
              }
              actual.fsyncSync(fd);
            },
          };
        });
        const mocked = await import('../src/commands/mcp-install.js');

        expect(mocked.installClientConfig('cursor', target).status).toBe('updated');
        expect(readFileSync(target, 'utf8')).toContain('"mcpServers"');
        expect(readdirSync(tempDir)).toEqual(['mcp.json']);
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'removes the temp file when the write fails part-way through',
    async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-partial-'));
      try {
        const target = path.join(tempDir, 'mcp.json');
        const original = '{"mcpServers":{}}\n';
        writeFileSync(target, original, 'utf8');

        // A disk that fills between the temp file's creation and its content
        // is the case the cleanup exists for, and it cannot be reproduced
        // portably (a real ENOSPC needs a disposable filesystem), so the one
        // fs call that fails is substituted. Only `writeFileSync` is replaced
        // and only for a file descriptor, which is the temp write.
        vi.resetModules();
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            writeFileSync: (
              file: Parameters<typeof actual.writeFileSync>[0],
              data: Parameters<typeof actual.writeFileSync>[1],
              options?: Parameters<typeof actual.writeFileSync>[2],
            ): void => {
              if (typeof file === 'number') {
                const error = new Error(
                  'ENOSPC: no space left on device, write',
                ) as NodeJS.ErrnoException;
                error.code = 'ENOSPC';
                throw error;
              }
              actual.writeFileSync(file, data, options);
            },
          };
        });
        const partial = await import('../src/commands/mcp-install.js');

        expect(() => partial.installClientConfig('cursor', target)).toThrow(/ENOSPC/);
        // The config is untouched AND the half-made temp is gone: a leftover
        // would make a later run with the same pid fail with EEXIST.
        expect(readFileSync(target, 'utf8')).toBe(original);
        expect(readdirSync(tempDir)).toEqual(['mcp.json']);
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

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

  it.skipIf(process.platform === 'win32')(
    'resolves a relative link against the directory it really sits in',
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-dirlink-'));
      try {
        // The client's directory is a symlink two levels down (a dotfiles
        // setup). The config inside it points one level up, so it names the
        // file beside the TRACKED directory — not the file beside the link.
        const deep = path.join(tempDir, 'deep');
        const tracked = path.join(deep, 'tracked');
        mkdirSync(tracked, { recursive: true });
        const intended = path.join(deep, 'shared.json');
        writeFileSync(intended, '{"mcpServers":{}}\n', 'utf8');
        const clientDir = path.join(tempDir, 'client');
        symlinkSync(tracked, clientDir);
        const config = path.join(clientDir, 'mcp.json');
        symlinkSync('../shared.json', config);

        expect(installClientConfig('cursor', config).status).toBe('updated');

        expect(lstatSync(config).isSymbolicLink()).toBe(true);
        const content = JSON.parse(readFileSync(intended, 'utf8')) as Record<string, unknown>;
        expect(content['mcpServers']).toBeDefined();
        // A lexical `..` would have created this file instead, replacing
        // content the config never read.
        expect(existsSync(path.join(tempDir, 'shared.json'))).toBe(false);
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
        const squatter = `${target}.${process.pid}.cfr-free.tmp`;
        symlinkSync(victim, squatter);
        expect(() => installClientConfig('cursor', target)).toThrow();
        expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
        expect(existsSync(target)).toBe(false);
        // The cleanup removes only a temp this call CREATED. An occupant that
        // was already there — this link — has to survive the refusal too, or
        // the error path would delete a file it never made.
        expect(lstatSync(squatter).isSymbolicLink()).toBe(true);
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
