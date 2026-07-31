import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from './config.js';
import { ControlPlane } from './domain/control-plane.js';
import { ClaudeSource } from './adapters/sources/claude.js';
import { QoderCliSource } from './adapters/sources/qoder-cli.js';
import { Tmux } from './adapters/tmux.js';
import { FileManagedRegistry } from './adapters/managed-registry.js';
import { SystemClock } from './adapters/clock.js';

export function buildPlane(cfg: Config): ControlPlane {
  return new ControlPlane({
    tmux: new Tmux(cfg.tmux.socket, cfg.tmux.bin),
    sources: [
      new ClaudeSource(cfg.paths.claudeHome, cfg.claude.bin, cfg.claude.sessionPermissionMode),
      new QoderCliSource(cfg.qoder.qoderHome, cfg.qoder.cliBin, cfg.qoder.cliPermissionMode),
    ],
    registry: new FileManagedRegistry(join(cfg.paths.stateDir, 'managed.json')),
    clock: new SystemClock(),
    newSessionId: () => randomUUID(),
  });
}

// 构造“运行本 CLI 某子命令”的命令行：优先用已构建的 dist（稳定，适合 launchd），
// 否则回退到 tsx 运行源码（开发/热更新）。
export function selfCommand(sub: string): string[] {
  const distCli = resolve(process.cwd(), 'dist/cli.js');
  if (existsSync(distCli)) return [process.execPath, distCli, sub];
  const entry = resolve(process.argv[1] ?? 'src/cli.ts');
  if (entry.endsWith('.ts')) return ['npx', 'tsx', entry, sub];
  return [process.execPath, entry, sub];
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  const plane = buildPlane(cfg);

  if (cmd === 'sessions') {
    for (const s of await plane.listSessions()) {
      console.log(`${s.status.padEnd(7)} ${s.controllable ? 'ctl' : '   '} ${s.sessionId.slice(0, 8)} ${s.name ?? ''} ${s.cwd}`);
    }
  } else if (cmd === 'tail' && arg) {
    for (const e of await plane.getMessages(arg)) {
      const body = (e as any).text ?? (e as any).content ?? (e as any).type ?? '';
      console.log(`[${e.kind}] ${body}`);
    }
  } else if (cmd === 'serve') {
    const { startServer } = await import('./index.js');
    await startServer(cfg);
  } else if (cmd === 'mcp') {
    const modeIdx = process.argv.indexOf('--mode');
    const mode = (modeIdx >= 0 ? process.argv[modeIdx + 1] : 'direct') as 'direct' | 'im';
    const { buildMcpServer } = await import('./mcp/control-mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { FilePendingStore } = await import('./adapters/pending-store.js');
    const conv = process.env.LIFESTREAM_CONV ?? 'cli';
    const server = await buildMcpServer({
      plane, mode,
      pending: new FilePendingStore(join(cfg.paths.stateDir, 'pending.json')),
      conversationId: conv,
      clock: new SystemClock(),
      newId: () => randomUUID(),
    });
    await server.connect(new StdioServerTransport());
  } else if (cmd === 'daemon') {
    const { Supervisor } = await import('./daemon.js');
    const watch = process.argv.includes('--watch');
    const root = process.cwd();
    new Supervisor({
      command: selfCommand('serve'),
      cwd: root,
      watchDir: watch ? join(root, 'src') : undefined,
      pidFile: join(cfg.paths.stateDir, 'daemon.pid'),
      logFile: join(cfg.paths.stateDir, 'daemon.log'),
    }).start();
    console.log(`[lifestream] daemon started${watch ? ' (watching src/)' : ''}; child: ${selfCommand('serve').join(' ')}`);
  } else if (cmd === 'install-launchd') {
    const { renderLaunchdPlist } = await import('./launchd.js');
    const { homedir } = await import('node:os');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const label = 'com.lifestream.daemon';
    const plist = renderLaunchdPlist({
      label,
      programArguments: selfCommand('daemon'),
      workingDirectory: process.cwd(),
      stdoutPath: join(cfg.paths.stateDir, 'daemon.out.log'),
      stderrPath: join(cfg.paths.stateDir, 'daemon.err.log'),
    });
    const dest = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, plist);
    console.log('wrote ' + dest);
    console.log('enable:  launchctl load -w "' + dest + '"');
    console.log('restart: launchctl kickstart -k gui/$(id -u)/' + label);
  } else if (cmd === 'reload') {
    // 手动重新部署：向守护进程发 SIGHUP，触发对 serve 的优雅重启（编辑期间主链路不断，编辑完再 reload）。
    const pidFile = join(cfg.paths.stateDir, 'daemon.pid');
    if (!existsSync(pidFile)) { console.error('daemon 未运行（找不到 ' + pidFile + '）。先 `lifestream daemon`。'); process.exit(1); }
    const { readFileSync } = await import('node:fs');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    try { process.kill(pid, 'SIGHUP'); console.log(`已通知 daemon(pid=${pid}) 优雅重启 serve。`); }
    catch (e: any) { console.error('通知失败: ' + e.message + '（daemon 可能已退出）'); process.exit(1); }
  } else if (cmd === 'token') {
    // 在 PC 上获取主令牌（新设备登录用；缺失则生成并写回配置）。
    if (!cfg.web.token) {
      const { randomBytes } = await import('node:crypto');
      const { writeFileSync } = await import('node:fs');
      cfg.web.token = randomBytes(24).toString('hex');
      try { writeFileSync('lifestream.config.json', JSON.stringify(cfg, null, 2)); } catch { /* ignore */ }
    }
    console.log(cfg.web.token);
  } else {
    console.log('usage: lifestream <sessions | tail <id> | serve | daemon [--watch] | reload | token | install-launchd | mcp [--mode direct|im]>');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
