import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createRefreshCoordinator,
  type RefreshCoordinatorDeps,
} from "./refresh-coordinator.ts"
import { refreshOAuthCredential, type OAuthDeps } from "./oauth-method.ts"
import { finishClaudeResponse, type AuthRecovery } from "./provider.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import { refreshViaOAuthDetailed, type RefreshOutcome } from "./credentials.ts"

// These tests exercise the exported callbacks, not real OAuth, CLI or keychain.
globalThis.fetch = async () => {
  throw new Error("network disabled in refresh recovery tests")
}

let fixtureID = 0
function fixture() {
  let now = 1_700_000_000_000
  const configDir = `/fixture/claude-${++fixtureID}`
  const initial = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: now - 1,
  }
  let stored: ClaudeCredentials | null = { ...initial }
  const refreshed = {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: now + 3_600_000,
  }
  let exchanges = 0
  let writes = 0
  let canWrite = true
  let canRead = true
  let held = false
  let exchange: RefreshCoordinatorDeps["exchange"] = async () => ({
    kind: "ok",
    creds: refreshed,
  })
  const tokens: string[] = []
  const deps: RefreshCoordinatorDeps = {
    read: () => {
      if (!canRead) throw new Error("store denied")
      return stored
    },
    write: (_source, creds, _dir, prior) => {
      writes++
      if (!canWrite || stored?.accessToken !== prior) return false
      stored = { ...creds }
      return true
    },
    exchange: async (token) => {
      exchanges++
      tokens.push(token)
      return exchange(token)
    },
    acquireLock: () => {
      if (held) return null
      held = true
      return {
        release() {
          held = false
        },
      }
    },
    log() {},
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
  const coordinator = createRefreshCoordinator(deps)
  const oauthDeps: OAuthDeps = {
    refreshAccountsList: () => [],
    loadPersistedAccountSource: () => null,
    getCachedCredentials: async () => null,
    setActiveAccountSource() {
      throw new Error("refresh must not switch accounts")
    },
    saveAccountSource() {},
    log() {},
    refreshCredential: coordinator.refresh,
  }
  const value = {
    type: "oauth" as const,
    access: initial.accessToken,
    refresh: initial.refreshToken,
    expires: initial.expiresAt,
    metadata: { source: "file", configDir },
  }
  return {
    value,
    refreshed,
    deps,
    coordinator,
    oauthDeps,
    refresh: () => refreshOAuthCredential(value, oauthDeps),
    setExchange: (fn: typeof exchange) => {
      exchange = fn
    },
    setStored: (creds: ClaudeCredentials | null) => {
      stored = creds
    },
    setWritable: (v: boolean) => {
      canWrite = v
    },
    setReadable: (v: boolean) => {
      canRead = v
    },
    setHeld: (v: boolean) => {
      held = v
    },
    counters: () => ({ exchanges, writes, tokens }),
  }
}

const ok = (creds: ClaudeCredentials): RefreshOutcome => ({ kind: "ok", creds })

describe("shared OAuth refresh and HTTP recovery", () => {
  it("recovers a temporary endpoint failure without requiring a manual CLI login", async () => {
    const f = fixture()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () =>
      ++calls === 1
        ? new Response('{"error":"temporarily_unavailable"}', {
            status: 503,
            headers: { "retry-after": "1" },
          })
        : new Response(
            '{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}',
          )
    f.setExchange(refreshViaOAuthDetailed)
    try {
      const result = await f.refresh()
      assert.equal(result.access, "new-access")
      assert.equal(result.refresh, "new-refresh")
      assert.equal(f.counters().exchanges, 2)
      assert.equal(f.counters().writes, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("collapses concurrent OpenCode integration callbacks into one exchange and write", async () => {
    const f = fixture()
    const values = await Promise.all(
      Array.from({ length: 10 }, () => f.refresh()),
    )
    assert.ok(values.every((value) => value.access === "new-access"))
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 1)
  })

  it("adopts credentials that the CLI rotates during an invalid_grant response", async () => {
    const f = fixture()
    f.setExchange(async () => {
      f.setStored({ ...f.refreshed, accessToken: "external-access" })
      return { kind: "terminal", status: 400, oauthError: "invalid_grant" }
    })
    assert.equal((await f.refresh()).access, "external-access")
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 0)
  })

  it("uses an externally rotated refresh token even when its access token expired", async () => {
    const f = fixture()
    f.setStored({
      accessToken: "expired-external",
      refreshToken: "external-refresh",
      expiresAt: 0,
    })
    assert.equal((await f.refresh()).access, "new-access")
    assert.deepEqual(f.counters().tokens, ["external-refresh"])
  })

  it("uses a newer stored refresh token even while OpenCode's old access token looks usable", async () => {
    const f = fixture()
    f.setStored({
      accessToken: "expired-external",
      refreshToken: "external-refresh",
      expiresAt: 0,
    })
    await refreshOAuthCredential(
      { ...f.value, expires: f.refreshed.expiresAt - 3_400_000 },
      f.oauthDeps,
    )
    assert.deepEqual(f.counters().tokens, ["external-refresh"])
  })

  it("retries within the callback's budget after joining a no-wait preflight", async () => {
    const f = fixture()
    f.setExchange(async () =>
      f.counters().exchanges === 1
        ? { kind: "transient", status: 503, retryAfterMs: 1000 }
        : ok(f.refreshed),
    )
    const preflight = f.coordinator.refresh({
      source: "file",
      configDir: f.value.metadata.configDir,
      credentials: {
        accessToken: f.value.access,
        refreshToken: f.value.refresh,
        expiresAt: f.value.expires,
      },
      maxWaitMs: 0,
    })
    const callback = f.refresh()
    assert.equal((await preflight).kind, "transient")
    assert.equal((await callback).access, "new-access")
    assert.equal(f.counters().exchanges, 2)
  })

  it("rechecks a newer expired refresh token arriving during a rejected exchange", async () => {
    const f = fixture()
    f.setExchange(async () => {
      if (f.counters().exchanges === 1) {
        f.setStored({
          accessToken: "expired-external",
          refreshToken: "external-refresh",
          expiresAt: 0,
        })
        return { kind: "terminal", status: 400, oauthError: "invalid_grant" }
      }
      return ok(f.refreshed)
    })
    assert.equal((await f.refresh()).access, "new-access")
    assert.deepEqual(f.counters().tokens, ["old-refresh", "external-refresh"])
  })

  it("rereads the source after acquiring the cross-process lock", async () => {
    const f = fixture()
    f.deps.acquireLock = () => {
      f.setStored(f.refreshed)
      return { release() {} }
    }
    assert.equal((await f.refresh()).access, "new-access")
    assert.equal(f.counters().exchanges, 0)
  })

  it("waits for a lock holder and adopts its persisted result without exchanging", async () => {
    const f = fixture()
    f.setHeld(true)
    const sleep = f.deps.sleep
    f.deps.sleep = async (ms) => {
      await sleep(ms)
      f.setStored(f.refreshed)
    }
    assert.equal((await f.refresh()).access, "new-access")
    assert.equal(f.counters().exchanges, 0)
  })

  it("falls back to the saved OpenCode token when the store is temporarily unreadable", async () => {
    const f = fixture()
    f.setReadable(false)
    assert.equal((await f.refresh()).access, "new-access")
    assert.deepEqual(f.counters().tokens, ["old-refresh"])
  })

  it("retains a successful rotation and retries persistence instead of redeeming its consumed token", async () => {
    const f = fixture()
    f.setWritable(false)
    assert.equal((await f.refresh()).access, "new-access")
    f.setWritable(true)
    assert.equal((await f.refresh()).access, "new-access")
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 2)
  })

  it("preserves external account changes rather than writing a retained pair over them", async () => {
    const f = fixture()
    f.setWritable(false)
    await f.refresh()
    f.setStored({
      ...f.refreshed,
      accessToken: "switched-access",
      refreshToken: "switched-refresh",
    })
    f.setWritable(true)
    assert.equal((await f.refresh()).access, "switched-access")
    assert.equal(f.counters().writes, 1)
  })

  it("adopts a compare-and-swap winner before returning the integration credential", async () => {
    const f = fixture()
    f.deps.write = () => {
      f.setStored({
        ...f.refreshed,
        accessToken: "winner-access",
        refreshToken: "winner-refresh",
      })
      return false
    }
    assert.equal((await f.refresh()).access, "winner-access")
    assert.equal(f.counters().exchanges, 1)
  })

  it("does not lose the rotated pair when the storage adapter throws", async () => {
    const f = fixture()
    f.deps.write = () => {
      throw new Error("write denied")
    }
    assert.equal((await f.refresh()).access, "new-access")
    assert.equal((await f.refresh()).access, "new-access")
    assert.equal(f.counters().exchanges, 1)
  })

  it("honors a long Retry-After across subsequent callbacks without demanding login", async () => {
    const f = fixture()
    f.setExchange(async () => ({
      kind: "transient",
      status: 429,
      retryAfterMs: 3_600_000,
    }))
    await assert.rejects(f.refresh, /temporarily unavailable/)
    await assert.rejects(f.refresh, /temporarily unavailable/)
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 0)
  })

  it("still requires authentication for a genuinely invalid grant", async () => {
    const f = fixture()
    f.setExchange(async () => ({
      kind: "terminal",
      status: 400,
      oauthError: "invalid_grant",
    }))
    await assert.rejects(f.refresh, /Run `claude` to re-authenticate/)
    await assert.rejects(f.refresh, /Run `claude` to re-authenticate/)
    assert.equal(f.counters().exchanges, 1)
  })

  it("does not serialize file accounts from different config directories", async () => {
    const f = fixture()
    f.deps.read = () => null
    f.deps.write = () => true
    await Promise.all([
      f.refresh(),
      refreshOAuthCredential(
        {
          ...f.value,
          metadata: { source: "file", configDir: "/fixture/another-account" },
        },
        f.oauthDeps,
      ),
    ])
    assert.equal(f.counters().exchanges, 2)
  })

  it("lets one session cancel without abandoning another session's token rotation", async () => {
    const f = fixture()
    let complete!: () => void
    f.setExchange(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return ok(f.refreshed)
    })
    const controller = new AbortController()
    const request = {
      source: "file",
      configDir: f.value.metadata.configDir,
      credentials: {
        accessToken: f.value.access,
        refreshToken: f.value.refresh,
        expiresAt: f.value.expires,
      },
    }
    const cancelled = f.coordinator.refresh({
      ...request,
      signal: controller.signal,
    })
    const surviving = f.refresh()
    await Promise.resolve()
    controller.abort()
    assert.equal((await cancelled).kind, "transient")
    complete()
    assert.equal((await surviving).access, "new-access")
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 1)
  })

  it("shares a rotation between an integration callback and HTTP 401 recovery", async () => {
    const f = fixture()
    let complete!: () => void
    f.setExchange(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return ok(f.refreshed)
    })
    let failure: "transient" | "terminal" | null = null
    const recovery: AuthRecovery = {
      reload: () => null,
      refresh: async (_exchange, _account, rejectedAccessToken, signal) => {
        const result = await f.coordinator.refresh({
          source: "file",
          configDir: f.value.metadata.configDir,
          credentials: {
            accessToken: f.value.access,
            refreshToken: f.value.refresh,
            expiresAt: f.value.expires,
          },
          rejectedAccessToken,
          signal,
        })
        failure = result.kind === "ok" ? null : result.kind
        return result.kind === "ok" ? result.creds : null
      },
      failureKind: () => failure,
    }
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer old-access" },
      body: '{"model":"claude-sonnet-4-6"}',
    })
    const callback = f.refresh()
    const http = finishClaudeResponse(
      request,
      new Response("unauthorized", { status: 401 }),
      undefined,
      async (_input, init) => {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer new-access",
        )
        return new Response("ok")
      },
      recovery,
    )
    await Promise.resolve()
    complete()
    assert.equal((await callback).access, "new-access")
    assert.equal((await http).status, 200)
    assert.equal(f.counters().exchanges, 1)
    assert.equal(f.counters().writes, 1)
  })

  it("forces a rejected token after joining a preflight that still considered it usable", async () => {
    const f = fixture()
    const valid = {
      accessToken: f.value.access,
      refreshToken: f.value.refresh,
      expiresAt: f.refreshed.expiresAt,
    }
    f.setStored(valid)
    const preflight = refreshOAuthCredential(
      { ...f.value, expires: valid.expiresAt },
      f.oauthDeps,
    )
    const forced = f.coordinator.refresh({
      source: "file",
      configDir: f.value.metadata.configDir,
      credentials: valid,
      rejectedAccessToken: valid.accessToken,
    })
    assert.equal((await preflight).access, "old-access")
    const result = await forced
    assert.equal(result.kind, "ok")
    if (result.kind === "ok")
      assert.equal(result.creds.accessToken, "new-access")
    assert.equal(f.counters().exchanges, 1)
  })

  it("surfaces exhausted transient 401 recovery as retryable, not another invalid login", async () => {
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: "{}",
    })
    const result = await finishClaudeResponse(
      request,
      new Response("unauthorized", { status: 401 }),
      undefined,
      async () => {
        throw new Error("must not retry with the rejected token")
      },
      {
        reload: () => null,
        refresh: async () => null,
        failureKind: () => "transient",
      },
    )
    assert.equal(result.status, 503)
    assert.equal(result.headers.get("retry-after"), "5")
    assert.match(await result.text(), /temporarily unavailable/)
  })
})
