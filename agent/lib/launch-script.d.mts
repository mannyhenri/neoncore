// Types for launch-script.mjs (plain ESM shared by the runner and the server).
export declare function shQuote(value: string): string;
export declare function cmdPath(value: string): string;
export declare function posixLaunchScript(o: { cwd: string; env: Record<string, string>; argv: string[] }): string;
export declare function windowsLaunchScript(o: { cwd: string; env: Record<string, string>; argv: string[]; envFile: string }): string;
export declare function launchTempPath(ext: string): string;
