// @appliqation/automation-sdk publishes types for its "./login" subpath
// export but not "./utils" (confirmed by reading the installed package —
// src/utils/ has no .d.ts anywhere), so TypeScript can't resolve it under
// this repo's NodeNext module resolution. Minimal ambient shim for just the
// functions this repo actually calls, kept in sync with
// node_modules/@appliqation/automation-sdk/src/utils/setupAuth.js's real
// exports — not a guess, that file was read directly.
declare module '@appliqation/automation-sdk/utils' {
  export function setupAuth(options: { project_id: number | string; role?: string }): string;
  export function authStatePath(options: { project_id: number | string; role?: string }): string;
  export function authStateDir(): string;
  export function envVarNames(options: { project_id: number | string; role: string }): {
    username: string;
    password: string;
  };
  export function sanitizeRole(role: string): string;
}
