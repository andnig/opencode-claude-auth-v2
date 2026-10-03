import { Credential, Integration } from "@opencode/plugin";
import type { IntegrationOAuthMethod } from "@opencode/plugin/promise/integration";
import type { RefreshOutcome } from "./credentials.ts";
import type { RefreshRequest } from "./refresh-coordinator.ts";
import type { ClaudeAccount, ClaudeCredentials } from "./keychain.ts";
export declare const INTEGRATION_ID: Integration.ID;
export declare const METHOD_ID: Integration.MethodID;
/** Identifies credentials created by this plugin when OpenCode builds provider options. */
export declare const CLAUDE_CODE_OAUTH_METADATA_KEY = "opencode-claude-auth/claude-code-oauth";
export declare const CLAUDE_CODE_OAUTH_METADATA_VALUE = "v1";
/**
 * Everything this module needs from credentials.ts/keychain.ts/logger.ts,
 * injected rather than imported directly. Keeps this file framework-agnostic
 * (no Effect, no Promise-specific wrapping) and trivially testable with plain
 * fakes - both the Effect-based and Promise-based plugin entrypoints wire in
 * the same real implementations at the top level.
 */
export interface OAuthDeps {
    refreshAccountsList: () => ClaudeAccount[];
    loadPersistedAccountSource: () => string | null;
    getCachedCredentials: () => Promise<ClaudeCredentials | null>;
    setActiveAccountSource: (source: string) => void;
    saveAccountSource: (source: string) => void;
    refreshCredential: (request: RefreshRequest) => Promise<RefreshOutcome>;
    log: (event: string, data?: Record<string, unknown>) => void;
}
/** A `Form.Answer` as the host collected it from {@link oauthMethodDescriptor}. */
export interface AuthorizeInputs {
    readonly account?: unknown;
}
/**
 * `/connect` shows this when the user picks the Claude Code method. With more
 * than one account on the machine it carries a chooser: OpenCode renders a
 * `string` field that has `options` as a pick list (no `custom`, so only a
 * listed account can be chosen) and hands the selection back to `authorize`
 * under the field's key. Each option is described by its credential source,
 * which is what tells two accounts on the same subscription tier apart.
 */
export declare function oauthMethodDescriptor(accounts: readonly ClaudeAccount[]): IntegrationOAuthMethod;
export declare function resolveAuthorizeSource(inputs: AuthorizeInputs, fallbackAccounts: readonly ClaudeAccount[], deps: Pick<OAuthDeps, "refreshAccountsList" | "loadPersistedAccountSource">): string | undefined;
export declare function buildOAuthCredential(source: string, deps: OAuthDeps): Promise<Credential.OAuth>;
export declare function authorizeOAuth(inputs: AuthorizeInputs, fallbackAccounts: readonly ClaudeAccount[], deps: OAuthDeps): Promise<Credential.OAuth>;
export interface RefreshableCredential {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires?: number;
    readonly metadata?: Record<string, unknown>;
}
export declare function refreshOAuthCredential(value: RefreshableCredential, deps: OAuthDeps): Promise<Credential.OAuth>;
export declare function labelOAuthCredential(value: {
    metadata?: Record<string, unknown>;
}): string | undefined;
/** The real, non-test wiring - shared by both the Effect and Promise plugin entrypoints. */
export declare const realOAuthDeps: OAuthDeps;
//# sourceMappingURL=oauth-method.d.ts.map