export interface LaunchdOptions {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  env?: Record<string, string>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 生成 macOS launchd plist：KeepAlive 保活、RunAtLoad 开机自启、崩溃自动重启。
export function renderLaunchdPlist(o: LaunchdOptions): string {
  const args = o.programArguments.map(a => `    <string>${esc(a)}</string>`).join('\n');
  const envBlock = o.env
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(o.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(o.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envBlock}  <key>StandardOutPath</key>
  <string>${esc(o.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.stderrPath)}</string>
</dict>
</plist>
`;
}
