import { execFile } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT = 128 * 1024;
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/tmp', TMPDIR: '/tmp' });
const TOOLS = ['bwrap', 'prlimit', 'pdflatex', 'latexmk', 'pdftotext', 'python3', 'python', 'node', 'make', 'git'];
const VERSIONS = { python: '--version', python3: '--version', pdftotext: '-v', latexmk: '-v' };

// Deliberately ignore PATH, shell startup files, and the caller's environment.
async function locate(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const file = path.join(dir, name);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch { /* unavailable */ }
  }
  return null;
}

function run(file, args, { signal, timeoutMs = 3000 } = {}) {
  const start = Date.now();
  return new Promise(resolve => {
    let child, timer, aborted = false, timedOut = false;
    const kill = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    };
    const abort = () => { aborted = true; kill(); };
    const finish = (error, stdout = '', stderr = '') => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Also reap descendants on ordinary completion and output overflow.
      kill();
      resolve({ status: aborted ? 'aborted' : timedOut ? 'timeout' : error ? 'failed' : 'completed',
        stdout: stdout.slice(0, LIMIT), stderr: stderr.slice(0, LIMIT),
        truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        exit: typeof error?.code === 'number' ? error.code : error ? null : 0,
        elapsed: Date.now() - start, error: error?.message });
    };
    if (signal?.aborted) { aborted = true; finish(); return; }
    try {
      child = execFile(file, args, { shell: false, detached: true, cwd: '/', env: ENV,
        encoding: 'utf8', maxBuffer: LIMIT, killSignal: 'SIGKILL' }, finish);
      child.stdin.on('error', () => {});
      child.stdin.end();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    } catch (error) { finish(error); }
  });
}

async function sandboxArgs({ source } = {}) {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv'];
  for (const [key, value] of Object.entries(ENV)) args.push('--setenv', key, value);
  for (const dir of ['/usr', '/bin', '/lib', '/lib64']) {
    try { await access(dir); args.push('--ro-bind', dir, dir); } catch { /* optional runtime tree */ }
  }
  args.push('--dir', '/etc');
  // No /etc/passwd, resolver, SSH keys, home, or whole-root bind.
  for (const file of ['/etc/ld.so.cache', '/etc/fonts', '/etc/texmf']) {
    try { await access(file); args.push('--ro-bind', file, file); } catch { /* optional configuration */ }
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp');
  if (source) args.push('--ro-bind', source, '/src');
  // Never expose host-writable storage: RLIMIT_FSIZE is only per-file.
  // Aggregate output data lives in a size-bounded ephemeral tmpfs.
  args.push('--size', '67108864', '--tmpfs', '/out');
  // The namespace root and /dev must not provide an unbounded writable bypass.
  // Separate /tmp and /out submounts remain the only regular-file write targets.
  args.push('--remount-ro', '/', '--remount-ro', '/dev');
  args.push('--chdir', source ? '/src' : '/tmp');
  return args;
}

function limitedArgs(bwrap, args, timeoutMs) {
  return ['--cpu=' + Math.ceil(timeoutMs / 1000 + 1), '--as=2147483648', '--fsize=67108864',
    '--nofile=128', '--nproc=64', '--core=0', '--', bwrap, ...args];
}

/** Capability discovery is not authorization. Only fixed system version/probe
 * commands execute here; no project code. Usability requires a real isolated run.
 */
export async function probeVerification({ signal } = {}) {
  const tools = {};
  for (const name of TOOLS) {
    const executable = await locate(name);
    const result = executable ? await run(executable, [VERSIONS[name] ?? '--version'], { signal }) : null;
    tools[name] = { available: result?.status === 'completed', path: executable };
  }
  const capabilities = { platform: process.platform, tools, sandboxUsable: false,
    network: 'disabled', source: 'read-only', resourceLimits: 'required prlimit' };
  if (process.platform !== 'linux' || !tools.bwrap.available || !tools.prlimit.available) {
    capabilities.reason = 'Usable Linux bubblewrap and prlimit are required';
    return capabilities;
  }
  const result = await run(tools.prlimit.path, limitedArgs(tools.bwrap.path,
    [...await sandboxArgs(), '--', '/usr/bin/true'], 3000), { signal });
  capabilities.sandboxUsable = result.status === 'completed';
  if (!capabilities.sandboxUsable) capabilities.reason = result.stderr || result.error || result.status;
  return capabilities;
}

/** Opt-in execution ONLY: the caller must obtain permission for the exact source,
 * argv and ephemeral writable output before calling. This adapter grants no
 * authorization. All files under cwd are exposed read-only: callers must choose
 * a source tree without credentials (including hidden files). System runtime
 * trees must be administrator-trusted. Compilation says nothing about macro or
 * mathematical truth. Output files are discarded with the sandbox; only bounded
 * stdout/stderr are returned. No host output-directory bind is permitted.
 */
export async function executeVerification({ cwd, kind, command, args = [], entry, signal, timeoutMs = 30000 } = {}) {
  const start = Date.now();
  const denied = (reason, capabilities = null) => ({ status: 'denied', reason, stdout: '', stderr: '',
    exit: null, elapsed: Date.now() - start, capabilities, artifacts: [] });
  if (!['command', 'tex'].includes(kind) || typeof cwd !== 'string' || !cwd ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Array.isArray(args) || args.length > 256 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 32768)) {
    return denied('Invalid verification request');
  }
  if (kind === 'command' && (!TOOLS.includes(command) || ['bwrap', 'prlimit'].includes(command))) {
    return denied('Command must be an allowlisted system tool name; shell commands and paths are not accepted');
  }
  if (kind === 'tex' && (command !== undefined || args.length || typeof entry !== 'string' ||
      !entry.endsWith('.tex') || entry.includes('\0') || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) {
    return denied('TeX requires a relative .tex entry and does not accept custom compiler arguments');
  }
  let source;
  try {
    source = await realpath(cwd);
    if (!(await stat(source)).isDirectory()) return denied('Source must be a directory');
    // Never expose whole system or whole home trees as the source bind.
    if (['/', '/usr', '/bin', '/lib', '/lib64', '/etc', '/proc', '/dev', '/sys', '/home', '/root', '/tmp', os.homedir()].includes(source)) {
      return denied('Source scope is too broad');
    }
    if (kind === 'tex') {
      const resolved = await realpath(path.join(source, entry));
      if (!resolved.startsWith(source + path.sep) || !(await stat(resolved)).isFile()) return denied('Entry escapes source or is not a file');
    }
  } catch { return denied('Source or entry is unavailable'); }
  if (signal?.aborted) return { ...denied('Aborted'), status: 'aborted' };
  const capabilities = await probeVerification({ signal });
  if (signal?.aborted) return { ...denied('Aborted', capabilities), status: 'aborted' };
  if (!capabilities.sandboxUsable) return denied(capabilities.reason, capabilities);
  const tool = kind === 'tex' ? 'pdflatex' : command;
  if (!capabilities.tools[tool].available) return denied(`${tool} is unavailable`, capabilities);
  if (signal?.aborted) return { ...denied('Aborted', capabilities), status: 'aborted' };
  try {
    const argv = kind === 'tex' ? ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error',
      '-output-directory=/out', `/src/${entry}`] : args;
    const sandbox = [...await sandboxArgs({ source }), '--', capabilities.tools[tool].path, ...argv];
    const result = await run(capabilities.tools.prlimit.path,
      limitedArgs(capabilities.tools.bwrap.path, sandbox, timeoutMs), { signal, timeoutMs });
    return { ...result, elapsed: Date.now() - start, capabilities,
      artifacts: [], outputPolicy: 'Ephemeral 64 MiB tmpfs; files discarded, only bounded logs returned' };
  } catch (error) {
    return denied(error.message, capabilities);
  }
}
