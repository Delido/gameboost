// Normalizes the process environment. Launchers like Raycast start processes with a stripped
// environment; without PATHEXT, PowerShell resolves `powercfg` to powercfg.cpl and opens the
// Control Panel instead of running the tool. Must be imported before any other module.
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const root = env.SystemRoot || env.windir || "C:\\Windows";
const home = env.USERPROFILE || homedir();

env.SystemRoot ||= root;
env.windir ||= root;
env.ComSpec ||= join(root, "System32", "cmd.exe");
env.USERPROFILE ||= home;
env.LOCALAPPDATA ||= join(home, "AppData", "Local");
env.APPDATA ||= join(home, "AppData", "Roaming");
env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

const sys32 = join(root, "System32");
const required = [sys32, root, join(sys32, "Wbem"), join(sys32, "WindowsPowerShell", "v1.0")];
const path = (env.Path || env.PATH || "").split(";").filter(Boolean);
const missing = required.filter((p) => !path.some((x) => x.toLowerCase() === p.toLowerCase()));
if (missing.length) {
  const value = [...missing, ...path].join(";");
  env.Path = value;
  if (env.PATH !== undefined) env.PATH = value;
}
