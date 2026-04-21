import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { ToolServerManagerClient } from "@openzerg/common-typescript"
import { openDB, autoMigrate } from "../src/db.js"
import { createTSMRouter } from "../src/router.js"
import { PodmanPodClient, type PodClient } from "@openzerg/common-typescript/pod-client"
import { randomUUID } from "node:crypto"

const PG_PORT = 15435
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_tsm`
const TSM_PORT = 25080
const CONTAINER_URL = process.env.CONTAINER_URL || "http://127.0.0.1:8888"

let client: ToolServerManagerClient
let server: Server
let podClient: PodClient
let db: any
const createdContainers: string[] = []

async function fullMigrate(databaseURL: string) {
  await autoMigrate(databaseURL)

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
  let migrated = false
  for (let i = 0; i < 10; i++) {
    try {
      db = openDB(PG_URL)
      await fullMigrate(PG_URL)
      migrated = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!migrated) throw new Error("autoMigrate failed after 10 retries")

  podClient = new PodmanPodClient(CONTAINER_URL)

  const handler = connectNodeAdapter({
    routes: createTSMRouter(db, podClient),
  })

  server = createServer(handler)
  server.listen(TSM_PORT)
  await new Promise(r => setTimeout(r, 100))

  client = new ToolServerManagerClient({
    baseURL: `http://localhost:${TSM_PORT}`,
    token: "",
  })
}, 30_000)

afterAll(async () => {
  for (const name of createdContainers) {
    try { await podClient.stopPod(name) } catch {}
    try { await podClient.removePod(name) } catch {}
  }
  server?.close()
  await db?.destroy()
}, 30_000)

describe("Tool Server Manager E2E — Real Podman", () => {
  test("startToolServer creates and starts real container", async () => {
    const result = await client.startToolServer({
      type: "test-tool",
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: { MODE: "test" },
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.containerName).toBeTruthy()
    expect(result.value.instanceId).toBeTruthy()
    createdContainers.push(result.value.containerName)

    console.log(`[e2e] tool server container ${result.value.containerName} started`)

    const info = await podClient.inspectPod(result.value.containerName)
    expect(info.state).toBe("running")
  }, 30_000)

  test("listToolServers shows running instance", async () => {
    const ts = BigInt(Date.now())
    const instanceId = randomUUID()
    await db.insertInto("registry_instances").values({
      id: instanceId,
      name: "tool-test-real",
      instanceType: "tool-test-real",
      ip: "127.0.0.1",
      port: 25999,
      publicUrl: "http://localhost:25999",
      lifecycle: "active",
      lastSeen: ts,
      metadata: "{}",
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    const result = await client.listToolServers()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const found = result.value.servers.find(s => s.instanceId === instanceId)
    expect(found).toBeDefined()
    expect(found!.type).toBe("tool-test-real")
    expect(found!.lifecycle).toBe("active")
  }, 30_000)

  test("stopToolServer stops running containers by type", async () => {
    const ts = BigInt(Date.now())
    const instanceId = randomUUID()
    await db.insertInto("registry_instances").values({
      id: instanceId,
      name: "tool-stop-test",
      instanceType: "tool-stop-test",
      ip: "127.0.0.1",
      port: 25998,
      publicUrl: "http://localhost:25998",
      lifecycle: "active",
      lastSeen: ts,
      metadata: "{}",
      createdAt: ts,
      updatedAt: ts,
    }).execute()

    const startResult = await client.startToolServer({
      type: "tool-stop-test",
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: {},
    })
    expect(startResult.isOk()).toBe(true)
    if (!startResult.isOk()) return
    createdContainers.push(startResult.value.containerName)

    const infoBefore = await podClient.inspectPod(startResult.value.containerName)
    expect(infoBefore.state).toBe("running")

    const stopResult = await client.stopToolServer("tool-stop-test")
    expect(stopResult.isOk()).toBe(true)

    const row = await db.selectFrom("registry_instances").select(["lifecycle"])
      .where("instanceType", "=", "tool-stop-test").executeTakeFirst()
    expect(row?.lifecycle).toBe("stopped")

    console.log(`[e2e] tool server tool-stop-test stopped`)
  }, 30_000)
})
