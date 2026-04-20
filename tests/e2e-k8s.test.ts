import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { ToolServerManagerClient } from "@openzerg/common"
import { openDB, autoMigrate } from "../src/db.js"
import { createTSMRouter } from "../src/router.js"
import { KubernetesClient } from "@openzerg/common/pod-client"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"

const PG_PORT = 15438
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_tsm_k8s`
const TSM_PORT = 25082

let client: ToolServerManagerClient
let server: Server
let k8s: KubernetesClient
let db: any
const createdPods: string[] = []

beforeAll(async () => {
  try {
    execSync(
      `podman run -d --name e2e-tsm-k8s-pg -p ${PG_PORT}:5432 ` +
      `-e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=e2e_tsm_k8s ` +
      `docker.io/library/postgres:17-alpine`,
      { stdio: "pipe" },
    )
  } catch {}

  let ok = false
  for (let i = 0; i < 15; i++) {
    try {
      db = openDB(PG_URL)
      await autoMigrate(PG_URL)
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
      ok = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!ok) throw new Error("DB setup failed")

  k8s = new KubernetesClient()

  const handler = connectNodeAdapter({
    routes: createTSMRouter(db, k8s),
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
  for (const name of createdPods) {
    try { await k8s.removePod(name) } catch {}
  }
  try { execSync("podman rm -f e2e-tsm-k8s-pg", { stdio: "pipe" }) } catch {}
  server?.close()
  await db?.destroy()
}, 30_000)

describe("Tool Server Manager E2E — k3s Kubernetes", () => {
  test("health check", async () => {
    const result = await client.health()
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.status).toBe("ok")
    }
  }, 30_000)

  test("startToolServer creates k8s Pod", async () => {
    const result = await client.startToolServer({
      type: "tool-fs-k8s",
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "300"],
      env: { MODE: "k8s-test" },
    })
    if (result.isErr()) console.error("startToolServer ERR:", result.error)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.containerName).toBeTruthy()
    expect(result.value.instanceId).toBeTruthy()
    createdPods.push(result.value.containerName)

    console.log(`[k8s-e2e] tool server pod ${result.value.containerName} created`)
  }, 30_000)

  test("listToolServers shows running instance", async () => {
    const result = await client.listToolServers()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const found = result.value.servers.find(s => s.type === "tool-fs-k8s")
    expect(found).toBeDefined()
    expect(found!.lifecycle).toBe("active")
  }, 30_000)

  test("stopToolServer deletes k8s Pod", async () => {
    const result = await client.startToolServer({
      type: "tool-stop-k8s",
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "300"],
      env: {},
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    createdPods.push(result.value.containerName)

    const stopResult = await client.stopToolServer("tool-stop-k8s")
    expect(stopResult.isOk()).toBe(true)

    const row = await db.selectFrom("registry_instances").select(["lifecycle"])
      .where("instanceType", "=", "tool-stop-k8s").executeTakeFirst()
    expect(row?.lifecycle).toBe("stopped")

    console.log(`[k8s-e2e] tool server tool-stop-k8s stopped`)
  }, 30_000)
})
