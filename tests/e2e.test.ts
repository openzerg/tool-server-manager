import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { ToolServerManagerClient } from "@openzerg/common-typescript"
import { PodmanCompose, waitForPort } from "../../openzerg/e2e/compose-helper.js"
import { openDB, autoMigrate } from "../src/db.js"
import { createTSMRouter } from "../src/router.js"
import type { PodClient } from "@openzerg/common-typescript/pod-client"
import { randomUUID } from "node:crypto"

const PG_PORT = 15435
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_tsm`
const TSM_PORT = 25080

const compose = new PodmanCompose({
  projectName: "tsm",
  composeFile: import.meta.dir + "/compose.yaml",
})

let client: ToolServerManagerClient
let server: Server
let db: any

function createMockPodClient(): PodClient {
  const pods = new Map<string, { name: string; state: string }>()
  return {
    createPod: async (spec) => {
      const id = randomUUID()
      pods.set(spec.name, { name: spec.name, state: "created" })
      return id
    },
    startPod: async (name: string) => {
      const p = pods.get(name)
      if (p) p.state = "running"
    },
    stopPod: async (name: string) => {
      const p = pods.get(name)
      if (p) p.state = "stopped"
    },
    removePod: async (name: string) => {
      pods.delete(name)
    },
    inspectPod: async (nameOrId: string) => ({
      id: nameOrId,
      name: nameOrId,
      state: "running",
      containers: [],
    }),
    listPods: async () => [],
    createVolume: async () => {},
    removeVolume: async () => {},
  }
}

async function fullMigrate(db: any) {
  await autoMigrate(PG_URL)

  const ts = BigInt(Date.now())

  await db.schema.createTable("registry_instances").ifNotExists()
    .addColumn("id", "text", c => c.notNull().primaryKey())
    .addColumn("name", "text", c => c.notNull())
    .addColumn("instanceType", "text", c => c.notNull())
    .addColumn("ip", "text", c => c.notNull())
    .addColumn("port", "integer", c => c.notNull())
    .addColumn("publicUrl", "text", c => c.notNull())
    .addColumn("lifecycle", "text", c => c.notNull().defaultTo("active"))
    .addColumn("lastSeen", "bigint", c => c.notNull().defaultTo(0n))
    .addColumn("metadata", "text", c => c.notNull().defaultTo("{}"))
    .addColumn("createdAt", "bigint", c => c.notNull())
    .addColumn("updatedAt", "bigint", c => c.notNull())
    .execute()
}

beforeAll(async () => {
  await compose.up(["postgres"])
  await waitForPort(PG_PORT, 30_000)

  let migrated = false
  for (let i = 0; i < 10; i++) {
    try {
      db = openDB(PG_URL)
      await fullMigrate(db)
      migrated = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!migrated) throw new Error("autoMigrate failed after 10 retries")

  const podman = createMockPodClient()

  const handler = connectNodeAdapter({
    routes: createTSMRouter(db, podman),
  })

  server = createServer(handler)
  server.listen(TSM_PORT)
  await new Promise(r => setTimeout(r, 100))

  client = new ToolServerManagerClient({
    baseURL: `http://localhost:${TSM_PORT}`,
    token: "",
  })
}, 60_000)

afterAll(async () => {
  server?.close()
  await db?.destroy()
  await compose.down()
})

describe("Tool Server Manager E2E", () => {
  test("health check", async () => {
    const result = await client.health()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("ok")
    }
  })

  test("listToolServers returns empty initially", async () => {
    const result = await client.listToolServers()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.servers.length).toBe(0)
  })

  test("register a tool server instance then list servers", async () => {
    const ts = BigInt(Date.now())
    const instanceId = randomUUID()
    await db.insertInto("registry_instances").values({
      id: instanceId,
      name: "tool-fs-test",
      instanceType: "tool-fs",
      ip: "127.0.0.1",
      port: 25310,
      publicUrl: "http://localhost:25310",
      lifecycle: "active",
      lastSeen: ts,
      metadata: "{}",
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    const result = await client.listToolServers()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.servers.length).toBe(1)
    expect(result.value.servers[0].instanceId).toBe(instanceId)
    expect(result.value.servers[0].type).toBe("tool-fs")
  })

  test("resolveTools returns empty when no cached tools", async () => {
    const result = await client.resolveTools(randomUUID(), ["tool-fs"])
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.tools.length).toBe(0)
    expect(result.value.toolServerUrls.length).toBe(1)
    expect(result.value.toolServerUrls[0].name).toBe("tool-fs")
  })

  test("resolveTools returns empty for unknown types", async () => {
    const result = await client.resolveTools(randomUUID(), ["unknown-type"])
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.tools.length).toBe(0)
    expect(result.value.toolServerUrls.length).toBe(0)
  })

  test("executeTool returns error for unknown tool", async () => {
    const result = await client.executeTool({
      sessionId: randomUUID(),
      toolName: "nonexistent",
      argsJson: "{}",
      sessionToken: "fake",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.success).toBe(false)
    expect(result.value.error).toContain("Tool not found")
  })

  test("seed cached tools and resolve them", async () => {
    const ts = BigInt(Date.now())
    const instanceId = randomUUID()
    await db.insertInto("registry_instances").values({
      id: instanceId,
      name: "tool-memory-test",
      instanceType: "tool-memory",
      ip: "127.0.0.1",
      port: 25312,
      publicUrl: "http://localhost:25312",
      lifecycle: "active",
      lastSeen: ts,
      metadata: "{}",
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    await db.insertInto("cached_tools").values({
      id: randomUUID(),
      serviceId: instanceId,
      toolName: "memory-read",
      description: "Read from memory",
      inputSchemaJson: '{"type":"object","properties":{"key":{"type":"string"}}}',
      outputSchemaJson: "",
      group: "memory",
      priority: 10,
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    await db.insertInto("cached_tools").values({
      id: randomUUID(),
      serviceId: instanceId,
      toolName: "memory-write",
      description: "Write to memory",
      inputSchemaJson: '{"type":"object","properties":{"key":{"type":"string"},"value":{"type":"string"}}}',
      outputSchemaJson: "",
      group: "memory",
      priority: 10,
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    const result = await client.resolveTools(randomUUID(), ["tool-memory"])
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.tools.length).toBe(2)
    const names = result.value.tools.map(t => t.name)
    expect(names).toContain("memory-read")
    expect(names).toContain("memory-write")
  })
})
