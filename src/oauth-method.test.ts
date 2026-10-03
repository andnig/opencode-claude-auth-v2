import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ClaudeAccount } from "./keychain.ts"
import {
  authorizeOAuth,
  buildOAuthCredential,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  labelOAuthCredential,
  oauthMethodDescriptor,
  refreshOAuthCredential,
  resolveAuthorizeSource,
  type OAuthDeps,
} from "./oauth-method.ts"

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    label: "Claude Pro",
    source: "Claude Code-credentials",
    credentials: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<OAuthDeps> = {}): OAuthDeps & {
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {
    setActiveAccountSource: [],
    saveAccountSource: [],
    log: [],
  }
  return {
    calls,
    refreshAccountsList: () => [account()],
    loadPersistedAccountSource: () => null,
    getCachedCredentials: async () => null,
    setActiveAccountSource: (source) => {
      calls.setActiveAccountSource.push(source)
    },
    saveAccountSource: (source) => {
      calls.saveAccountSource.push(source)
    },
    refreshCredential: async () => ({ kind: "terminal", status: 400 }),
    log: (event, data) => {
      calls.log.push([event, data])
    },
    ...overrides,
  }
}

describe("oauthMethodDescriptor", () => {
  it("omits the chooser for a single account", () => {
    const descriptor = oauthMethodDescriptor([account()])
    assert.equal(descriptor.id, "claude-code")
    assert.equal(descriptor.type, "oauth")
    assert.equal(descriptor.label, "Import Claude Code subscription")
    assert.equal(descriptor.form, undefined)
  })

  it("omits the chooser for zero accounts", () => {
    assert.equal(oauthMethodDescriptor([]).form, undefined)
  })

  it("offers every account through a pick-list form field", () => {
    const descriptor = oauthMethodDescriptor([
      account({ label: "Claude Pro", source: "a" }),
      account({ label: "Claude Max", source: "b" }),
    ])
    // A chooser is a `string` field carrying `options`; OpenCode has no
    // `select` field type, and a field without `options` renders as free text.
    assert.equal(descriptor.form?.length, 1)
    const field = descriptor.form?.[0]
    assert.equal(field?.type, "string")
    assert.equal(field?.key, "account")
    assert.equal(field?.title, "Select a Claude Code account")
    assert.equal(field?.required, true)
    assert.deepEqual(field?.type === "string" ? field.options : undefined, [
      { value: "a", label: "Claude Pro", description: "a" },
      { value: "b", label: "Claude Max", description: "b" },
    ])
    // Without `custom` the host only accepts one of the listed accounts.
    assert.equal(field?.type === "string" ? field.custom : undefined, undefined)
  })

  it("collects the answer under the key resolveAuthorizeSource reads", () => {
    const accounts = [
      account({ label: "Claude Pro", source: "a" }),
      account({ label: "Claude Max", source: "b" }),
    ]
    const field = oauthMethodDescriptor(accounts).form?.[0]
    assert.ok(field)
    const answer = { [field.key]: "b" }
    assert.equal(
      resolveAuthorizeSource(answer, accounts, {
        refreshAccountsList: () => accounts,
        loadPersistedAccountSource: () => "a",
      }),
      "b",
    )
  })
})

describe("resolveAuthorizeSource", () => {
  it("prefers inputs.account over everything else", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      { account: "explicit" },
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "explicit")
  })

  it("falls back to the persisted account source", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "persisted")
  })

  it("falls back to the first freshly-listed account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "latest")
  })

  it("falls back to the first account from the original snapshot", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "fallback")
  })

  it("returns undefined when nothing is available", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({}, [], deps)
    assert.equal(source, undefined)
  })

  it("ignores a non-string inputs.account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({ account: 42 }, [], deps)
    assert.equal(source, "latest")
  })
})

describe("buildOAuthCredential", () => {
  it("builds a credential for the matching account", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", label: "A" }),
        account({ source: "b", label: "B" }),
      ],
    })
    const value = await buildOAuthCredential("b", deps)
    assert.equal(value.type, "oauth")
    assert.equal(value.methodID, "claude-code")
    assert.equal(value.metadata?.source, "b")
    assert.equal(value.metadata?.label, "B")
    assert.equal(
      value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
      CLAUDE_CODE_OAUTH_METADATA_VALUE,
    )
  })

  it("falls back to the first account when the source doesn't match any", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "only" })],
    })
    const value = await buildOAuthCredential("missing", deps)
    assert.equal(value.metadata?.source, "only")
  })

  it("throws when there are no accounts at all", async () => {
    const deps = makeDeps({ refreshAccountsList: () => [] })
    await assert.rejects(
      () => buildOAuthCredential("anything", deps),
      /Run `claude` to authenticate first/,
    )
  })

  it("prefers cached credentials over the account's stored credentials", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
      getCachedCredentials: async () => ({
        accessToken: "cached-access",
        refreshToken: "cached-refresh",
        expiresAt: 123,
      }),
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "cached-access")
    assert.equal(value.refresh, "cached-refresh")
    assert.equal(value.expires, 123)
  })

  it("falls back to the account's stored credentials when nothing is cached", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "stored-access",
            refreshToken: "stored-refresh",
            expiresAt: 456,
          },
        }),
      ],
      getCachedCredentials: async () => null,
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "stored-access")
    assert.equal(value.refresh, "stored-refresh")
    assert.equal(value.expires, 456)
  })

  it("includes configDir in metadata only when present", async () => {
    const withConfigDir = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", configDir: "/tmp/claude" }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withConfigDir)).metadata?.configDir,
      "/tmp/claude",
    )
    assert.equal(
      "configDir" in (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("includes subscriptionType in metadata only when present", async () => {
    const withType = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "x",
            refreshToken: "y",
            expiresAt: 1,
            subscriptionType: "team",
          },
        }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withType)).metadata?.subscriptionType,
      "team",
    )
    assert.equal(
      "subscriptionType" in
        (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("marks the resolved account as active and persists the selection", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "chosen" })],
    })
    await buildOAuthCredential("chosen", deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, ["chosen"])
    assert.deepEqual(deps.calls.saveAccountSource, ["chosen"])
  })
})

describe("authorizeOAuth", () => {
  it("builds a credential for the resolved source", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "resolved" })],
      loadPersistedAccountSource: () => "resolved",
    })
    const value = await authorizeOAuth({}, [], deps)
    assert.equal(value.metadata?.source, "resolved")
  })

  it("throws a clear error when no source can be resolved", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    await assert.rejects(
      () => authorizeOAuth({}, [], deps),
      /Run `claude` to authenticate first/,
    )
  })
})

describe("refreshOAuthCredential", () => {
  const value = {
    type: "oauth" as const,
    access: "old-access",
    refresh: "old-refresh",
    metadata: { source: "acct", configDir: "/tmp/claude" },
  }

  const refreshed = {
    accessToken: "refreshed-access",
    refreshToken: "refreshed-refresh",
    expiresAt: 333,
  }

  it("delegates refresh to the coordinator with the credential's explicit source", async () => {
    const deps = makeDeps({
      refreshCredential: async (request) => {
        assert.equal(request.source, "acct")
        assert.equal(request.configDir, "/tmp/claude")
        assert.equal(request.credentials.refreshToken, "old-refresh")
        assert.equal(request.credentials.expiresAt, 222)
        assert.equal(request.thresholdMs, 300_000)
        return { kind: "ok", creds: refreshed }
      },
    })
    const result = await refreshOAuthCredential(
      { ...value, expires: 222 },
      deps,
    )
    assert.equal(result.access, refreshed.accessToken)
    assert.equal(result.refresh, refreshed.refreshToken)
    assert.equal(result.expires, refreshed.expiresAt)
  })

  it("preserves the Claude Code OAuth marker across refresh", async () => {
    const deps = makeDeps({
      refreshCredential: async () => ({ kind: "ok", creds: refreshed }),
    })
    const result = await refreshOAuthCredential(
      {
        ...value,
        metadata: {
          ...value.metadata,
          [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
        },
      },
      deps,
    )
    assert.equal(
      result.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
      CLAUDE_CODE_OAUTH_METADATA_VALUE,
    )
  })

  it("requires login only when the coordinator reports a terminal failure", async () => {
    const deps = makeDeps({
      refreshCredential: async () => ({ kind: "terminal", status: 400 }),
    })
    await assert.rejects(
      () => refreshOAuthCredential(value, deps),
      /Run `claude` to re-authenticate/,
    )
  })

  it("does not tell the user to log in after a transient failure", async () => {
    const deps = makeDeps({
      refreshCredential: async () => ({ kind: "transient", status: 503 }),
    })
    await assert.rejects(
      () => refreshOAuthCredential(value, deps),
      (error: Error) => {
        assert.match(error.message, /temporarily unavailable/)
        assert.doesNotMatch(error.message, /Run `claude`/)
        return true
      },
    )
  })

  it("supports credentials without source metadata", async () => {
    const deps = makeDeps({
      refreshCredential: async (request) => {
        assert.equal(request.source, undefined)
        return { kind: "ok", creds: refreshed }
      },
    })
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      deps,
    )
  })

  it("does not change the active account while refreshing a connection", async () => {
    const successfulRefresh = {
      refreshCredential: async () => ({
        kind: "ok" as const,
        creds: refreshed,
      }),
    }
    const deps = makeDeps(successfulRefresh)
    await refreshOAuthCredential(value, deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, [])

    const depsNoSource = makeDeps(successfulRefresh)
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      depsNoSource,
    )
    assert.deepEqual(depsNoSource.calls.setActiveAccountSource, [])
  })
})

describe("labelOAuthCredential", () => {
  it("returns the label when it is a string", () => {
    assert.equal(
      labelOAuthCredential({ metadata: { label: "Claude Pro" } }),
      "Claude Pro",
    )
  })

  it("returns undefined when metadata is absent", () => {
    assert.equal(labelOAuthCredential({}), undefined)
  })

  it("returns undefined when the label is not a string", () => {
    assert.equal(labelOAuthCredential({ metadata: { label: 42 } }), undefined)
  })
})
