import { forceRefreshActiveAccount, getActiveRefreshFailureKind, reloadCredentialsFromSource } from "./credentials.ts";
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export { fetchWithRetry } from "./http.ts";
export declare function buildRequestHeaders(input: RequestInfo | URL, init: RequestInit, accessToken: string, modelID?: string, excludedBetas?: Set<string>): Headers;
/** Prepare the native Anthropic request for Claude Code subscription billing. */
export declare function prepareClaudeRequest(request: Request, accessToken: string, source?: string): Promise<Request>;
/** Handle subscription recovery after OpenCode sends the first HTTP request. */
export interface AuthRecovery {
    reload: typeof reloadCredentialsFromSource;
    refresh: typeof forceRefreshActiveAccount;
    failureKind: typeof getActiveRefreshFailureKind;
}
export declare function finishClaudeResponse(request: Request, initial: Response, source?: string, send?: Fetch, recovery?: AuthRecovery): Promise<Response>;
/** Standalone transport used by existing integration checks. */
export declare function claudeSubscriptionFetch(accessToken: string, upstream?: Fetch, source?: string): Fetch;
//# sourceMappingURL=provider.d.ts.map