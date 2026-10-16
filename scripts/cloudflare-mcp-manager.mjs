/**
 * Windows per-user logon supervisor: no admin, no browser endpoint, no extra MCP tools.
 * This is copied to a stable LocalAppData folder by the Magpie plugin.
 *
 * It waits for Magpie's local gateway (3425), only then starts the authenticated
 * 48765 bridge. When Magpie quits, it closes its own listener. It never kills
 * an unknown process using port 48765 (e.g. an older manually started bridge).
 */
import { connect, createServer } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { start } from './cloudflare-mcp-adapter.mjs';

const PAUSE_MS = 2500;
const MAGPIE_PORT = 3425;
const BRIDGE_PORT = 48765;
const base = path.dirname(fileURLToPath(import.meta.url));
const statusFile = path.join(base, 'service-status.json');
const enabledFile = path.join(base, 'service-enabled.flag');
const config = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'magpie-local-review', 'cloudflare-mcp.json');

export function portAvailable(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createSupervisor({
  isEnabled = () => existsSync(enabledFile),
  isMagpieReady = () => portAvailable(MAGPIE_PORT),
  isBridgeInUse = () => portAvailable(BRIDGE_PORT),
  hasConfig = () => existsSync(config),
  createBridge = start,
  report = (state) => {
    try { writeFileSync(statusFile, JSON.stringify({ state, updatedAt: new Date().toISOString() })); }
    catch { /* Status is best effort; never weaken MCP security. */ }
  },
} = {}) {
  let bridge = null;
  let state = '';
  let stopped = false;
  const setState = next => {
    if (next !== state) { state = next; report(next); }
  };
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    if (bridge) {
      const closing = bridge; bridge = null;
      await new Promise(resolve => closing.close(resolve));
    }
    setState('stopped');
  };
  const tick = async () => {
    if (stopped) return;
    if (!isEnabled()) return shutdown();
    const ready = hasConfig() && await isMagpieReady();
    if (!ready) {
      if (bridge) {
        const closing = bridge; bridge = null;
        await new Promise(resolve => closing.close(resolve));
      }
      setState(hasConfig() ? 'waiting-for-magpie' : 'waiting-for-cloudflare-config');
      return;
    }
    if (bridge) {
      setState(bridge.listening ? 'online' : 'starting');
      return;
    }
    if (await isBridgeInUse()) { setState('external-listener-48765'); return; }
    try {
      bridge = createBridge();
      bridge.on('error', () => { bridge = null; setState('listen-error'); });
      setState('starting');
    } catch {
      // Missing or invalid local Cloudflare config must never fall back to
      // unauthenticated public access.
      bridge = null;
      setState('start-error');
    }
  };
  return { tick, shutdown, get state() { return state; }, get stopped() { return stopped; } };
}

/**
 * A local Windows named-pipe lock prevents multiple detached supervisor
 * processes when Magpie reloads the same plugin. This exposes no TCP service.
 * The pipe belongs to the current Windows logon user only by convention;
 * an unrelated process can block the name but cannot authenticate MCP calls.
 */
export async function acquireManagerSingleton(name = 'MagpieLocalReviewMCP') {
  if (process.platform !== 'win32') return { close: async () => {} };
  const user = (process.env.USERNAME || os.userInfo().username).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const pipeName = '\\\\.\\pipe\\' + name + '-' + user;
  const listener = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(pipeName, resolve);
    });
    return { close: () => new Promise(resolve => listener.close(resolve)) };
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Exit duplicates without touching the existing manager's 48765 listener.
  const singleton = await acquireManagerSingleton();
  if (!singleton) process.exit(0);
  const supervisor = createSupervisor();
  let exiting = false;
  const quit = () => {
    if (exiting) return;
    exiting = true;
    supervisor.shutdown().finally(() => singleton.close()).finally(() => process.exit(0));
  };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  // A single self-rearming loop prevents overlapping probes/close operations.
  while (!exiting) {
    try { await supervisor.tick(); }
    catch { /* Retry; connection/initialization may be transient. */ }
    if (exiting || supervisor.stopped) break;
    await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
  }
  if (!exiting) await singleton.close();
}
