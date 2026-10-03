import { Plugin } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
export * from "./betas.ts";
export * from "./credentials.ts";
export * from "./oauth-method.ts";
export * from "./provider.ts";
export * from "./signing.ts";
export * from "./transforms.ts";
/**
 * Session request kinds that reach the model and are billed to the connected
 * subscription. OpenCode 2 dispatches one hook per kind - `context` drives the
 * agent loop, and compaction, generation and title are issued alongside it - so
 * a hook registered for only one of them leaves the rest without the identity
 * Claude Code requests are expected to carry.
 */
export declare const IDENTITY_REQUEST_HOOKS: readonly ["context", "compaction", "generate", "title"];
/** Prepends the Claude Code identity to an Anthropic request, once. */
export declare function injectClaudeIdentity(event: SessionRequest): void;
export declare const ClaudeAuthPlugin: Plugin.Plugin;
export default ClaudeAuthPlugin;
//# sourceMappingURL=index.d.ts.map