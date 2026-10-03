import type { ClaudeCredentials } from "./keychain.ts";
import type { RefreshOutcome } from "./credentials.ts";
import type { RefreshLock } from "./refresh-lock.ts";
export interface RefreshRequest {
    source?: string;
    configDir?: string;
    credentials: ClaudeCredentials;
    thresholdMs?: number;
    /** A 401 means this token must not be served even if its expiry looks valid. */
    rejectedAccessToken?: string;
    maxWaitMs?: number;
    signal?: AbortSignal;
}
export interface RefreshCoordinatorDeps {
    read: (source: string, configDir?: string) => ClaudeCredentials | null;
    write: (source: string, creds: ClaudeCredentials, configDir: string | undefined, priorAccessToken: string) => boolean;
    exchange: (refreshToken: string) => Promise<RefreshOutcome>;
    acquireLock: (key: string) => RefreshLock | null;
    log: (event: string, data?: Record<string, unknown>) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}
export declare function credentialSourceKey(source: string, configDir?: string): string;
/** One coordinator is shared by integration refresh, request preflight and 401s.
 * The lock coordinates this plugin's processes, not the unmodified Claude CLI.
 */
export declare function createRefreshCoordinator(deps: RefreshCoordinatorDeps): {
    refresh: (request: RefreshRequest, exchange?: (refreshToken: string) => Promise<RefreshOutcome>) => Promise<RefreshOutcome>;
    current(request: RefreshRequest): ClaudeCredentials;
};
//# sourceMappingURL=refresh-coordinator.d.ts.map