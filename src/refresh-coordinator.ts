import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import type { ClaudeCredentials } from "./keychain.ts"
import type { RefreshOutcome } from "./credentials.ts"
import {
  clearRefreshOutcome,
  noteRefreshTerminal,
  noteRefreshTransient,
} from "./refresh-backoff.ts"
import type { RefreshLock } from "./refresh-lock.ts"

export interface RefreshRequest {
  source?: string
  configDir?: string
  credentials: ClaudeCredentials
  thresholdMs?: number
  /** A 401 means this token must not be served even if its expiry looks valid. */
  rejectedAccessToken?: string
  maxWaitMs?: number
  signal?: AbortSignal
}

export interface RefreshCoordinatorDeps {
  read: (source: string, configDir?: string) => ClaudeCredentials | null
  write: (
    source: string,
    creds: ClaudeCredentials,
    configDir: string | undefined,
    priorAccessToken: string,
  ) => boolean
  exchange: (refreshToken: string) => Promise<RefreshOutcome>
  acquireLock: (key: string) => RefreshLock | null
  log: (event: string, data?: Record<string, unknown>) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export function credentialSourceKey(
  source: string,
  configDir?: string,
): string {
  return source === "file"
    ? `file:${resolvePath(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")}`
    : source
}

type RetainedRotation = {
  creds: ClaudeCredentials
  prior: ClaudeCredentials
  persisted: boolean
}

const transient = (): Extract<RefreshOutcome, { kind: "transient" }> => ({
  kind: "transient",
  status: 0,
})

/** One coordinator is shared by integration refresh, request preflight and 401s.
 * The lock coordinates this plugin's processes, not the unmodified Claude CLI.
 */
export function createRefreshCoordinator(deps: RefreshCoordinatorDeps) {
  const inFlight = new Map<string, Promise<RefreshOutcome>>()
  const rotations = new Map<string, RetainedRotation>()
  const retryAt = new Map<string, number>()
  const failedTokens = new Map<string, string>()
  const terminalFailures = new Map<
    string,
    Extract<RefreshOutcome, { kind: "terminal" }>
  >()

  const usable = (creds: ClaudeCredentials, request: RefreshRequest) =>
    creds.accessToken.trim() !== "" &&
    creds.expiresAt > deps.now() + 60_000 &&
    creds.accessToken !== request.rejectedAccessToken

  function read(request: RefreshRequest): ClaudeCredentials | null {
    if (!request.source) return null
    try {
      return deps.read(request.source, request.configDir)
    } catch {
      deps.log("source_reread_failed", { source: request.source })
      return null
    }
  }

  function write(
    request: RefreshRequest,
    creds: ClaudeCredentials,
    prior: string,
  ): boolean {
    if (!request.source) return true
    try {
      return deps.write(request.source, creds, request.configDir, prior)
    } catch {
      return false
    }
  }

  function select(
    request: RefreshRequest,
    key: string,
    persist = false,
  ): ClaudeCredentials {
    const stored = read(request)
    const retained = rotations.get(key)
    if (retained) {
      const stillPrior =
        stored?.accessToken === retained.prior.accessToken &&
        stored.refreshToken === retained.prior.refreshToken
      // Never resurrect a token our successful exchange has already consumed.
      // Retry persistence, not OAuth, when its original store is still stale.
      if (
        !stored ||
        stillPrior ||
        (stored.accessToken === retained.creds.accessToken &&
          stored.refreshToken === retained.creds.refreshToken)
      ) {
        if (persist && !retained.persisted && stillPrior && request.source) {
          retained.persisted = write(
            request,
            retained.creds,
            retained.prior.accessToken,
          )
        }
        return retained.creds
      }
      // An independent writer changed the source. Do not overwrite its account.
      rotations.delete(key)
    }
    if (
      stored &&
      (stored.refreshToken !== request.credentials.refreshToken ||
        usable(stored, request) ||
        !usable(request.credentials, request))
    ) {
      return stored
    }
    return request.credentials
  }

  const freshEnough = (creds: ClaudeCredentials, request: RefreshRequest) =>
    usable(creds, request) &&
    (creds.accessToken !== request.credentials.accessToken ||
      request.rejectedAccessToken !== undefined ||
      creds.expiresAt > deps.now() + (request.thresholdMs ?? 60_000))

  async function attempt(
    request: RefreshRequest,
    key: string,
    exchange: RefreshCoordinatorDeps["exchange"],
  ): Promise<RefreshOutcome> {
    let current = select(request, key)
    if (
      failedTokens.has(key) &&
      failedTokens.get(key) !== current.refreshToken
    ) {
      retryAt.delete(key)
      failedTokens.delete(key)
      terminalFailures.delete(key)
      clearRefreshOutcome(key)
    }
    if (
      freshEnough(current, request) &&
      rotations.get(key)?.persisted !== false
    )
      return { kind: "ok", creds: current }
    const terminal = terminalFailures.get(key)
    if (terminal) return terminal
    if ((retryAt.get(key) ?? 0) > deps.now()) return transient()
    const lock = deps.acquireLock(key)
    if (!lock) {
      deps.log("refresh_lock_busy", { source: request.source })
      // Even no-wait callers get one chance to adopt the holder's result.
      current = select(request, key)
      return freshEnough(current, request)
        ? { kind: "ok", creds: current }
        : transient()
    }
    try {
      // The source may have rotated between the first read and lock acquisition.
      current = select(request, key, true)
      if (freshEnough(current, request)) return { kind: "ok", creds: current }
      for (let generation = 0; generation < 2; generation++) {
        if (!current.refreshToken) {
          noteRefreshTerminal(key)
          return { kind: "terminal", status: 400 }
        }
        let outcome: RefreshOutcome
        try {
          outcome = await exchange(current.refreshToken)
        } catch {
          outcome = transient()
        }
        if (outcome.kind === "ok") {
          if (!usable(outcome.creds, request)) outcome = transient()
          else {
            const persisted = write(request, outcome.creds, current.accessToken)
            rotations.set(key, {
              creds: outcome.creds,
              prior: current,
              persisted,
            })
            if (!persisted)
              deps.log("refresh_writeback_failed", { source: request.source })
            retryAt.delete(key)
            failedTokens.delete(key)
            terminalFailures.delete(key)
            clearRefreshOutcome(key)
            if (!persisted) {
              const winner = read(request)
              if (
                winner &&
                winner.accessToken !== current.accessToken &&
                winner.accessToken !== outcome.creds.accessToken &&
                usable(winner, request)
              ) {
                rotations.delete(key)
                return { kind: "ok", creds: winner }
              }
            }
            return outcome
          }
        }
        // Both transient failures and invalid_grant can be a concurrent rotation.
        // Adopt first; if only the refresh token is newer, exchange that once.
        const external = read(request)
        if (
          external &&
          (external.accessToken !== current.accessToken ||
            external.refreshToken !== current.refreshToken)
        ) {
          if (usable(external, request)) {
            retryAt.delete(key)
            clearRefreshOutcome(key)
            deps.log("refresh_adopted_from_source", { source: request.source })
            return { kind: "ok", creds: external }
          }
          if (
            external.refreshToken !== current.refreshToken &&
            generation === 0
          ) {
            current = external
            continue
          }
        }
        if (outcome.kind === "terminal") {
          noteRefreshTerminal(key)
          failedTokens.set(key, current.refreshToken)
          terminalFailures.set(key, outcome)
          return outcome
        }
        const cooldown = noteRefreshTransient(key, {
          now: deps.now(),
          retryAfterMs: outcome.retryAfterMs,
        })
        // Honor Retry-After even when it exceeds the legacy cooldown cap.
        retryAt.set(
          key,
          deps.now() + Math.max(cooldown, outcome.retryAfterMs ?? 0),
        )
        failedTokens.set(key, current.refreshToken)
        return outcome
      }
      return transient()
    } finally {
      lock.release()
    }
  }

  async function run(
    request: RefreshRequest,
    key: string,
    exchange: RefreshCoordinatorDeps["exchange"],
  ) {
    const deadline = deps.now() + (request.maxWaitMs ?? 45_000)
    let outcome = await attempt(request, key, exchange)
    while (outcome.kind === "transient" && deps.now() < deadline) {
      const until = retryAt.get(key) ?? deps.now() + 250
      // Poll the source during cooldown: another process can repair it earlier.
      await deps.sleep(
        Math.min(250, Math.max(1, until - deps.now()), deadline - deps.now()),
      )
      outcome = await attempt(request, key, exchange)
    }
    return outcome
  }

  async function refresh(
    request: RefreshRequest,
    exchange = deps.exchange,
  ): Promise<RefreshOutcome> {
    if (request.signal?.aborted) return transient()
    const deadline = deps.now() + (request.maxWaitMs ?? 45_000)
    const key = request.source
      ? credentialSourceKey(request.source, request.configDir)
      : `oauth:${createHash("sha256").update(request.credentials.refreshToken).digest("hex")}`
    let pending = inFlight.get(key)
    if (!pending) {
      // Install the promise before any injected work can re-enter the coordinator.
      pending = Promise.resolve().then(() => run(request, key, exchange))
      inFlight.set(key, pending)
      void pending
        .finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key)
        })
        .catch(() => {})
    } else deps.log("refresh_joined", { source: request.source })

    // Cancelling a waiter must not abandon a rotating grant midway through
    // persistence or cancel another session that joined the same refresh.
    const outcome = await new Promise<RefreshOutcome>((resolve, reject) => {
      const abort = () => resolve(transient())
      request.signal?.addEventListener("abort", abort, { once: true })
      pending!
        .then(resolve, reject)
        .finally(() => request.signal?.removeEventListener("abort", abort))
        .catch(() => {})
      if (request.signal?.aborted) abort()
    })
    if (
      !request.signal?.aborted &&
      outcome.kind === "transient" &&
      deps.now() < deadline
    ) {
      // A waiting integration callback may have joined a no-wait preflight.
      // It still owns its retry budget; the first caller's policy must not
      // turn a single recoverable failure into an immediate callback error.
      if (inFlight.get(key) === pending) inFlight.delete(key)
      return refresh({ ...request, maxWaitMs: deadline - deps.now() }, exchange)
    }
    if (
      !request.signal?.aborted &&
      outcome.kind === "ok" &&
      outcome.creds.accessToken === request.rejectedAccessToken
    ) {
      // A forced refresh joined a preflight which still served this rejected
      // token. Once that preflight completes, perform the actual forced exchange.
      if (inFlight.get(key) === pending) inFlight.delete(key)
      return refresh(request, exchange)
    }
    return outcome
  }
  return {
    refresh,
    current(request: RefreshRequest): ClaudeCredentials {
      return request.source
        ? select(
            request,
            credentialSourceKey(request.source, request.configDir),
          )
        : request.credentials
    },
  }
}
