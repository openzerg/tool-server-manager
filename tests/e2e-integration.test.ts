import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { createConnectTransport } from "@connectrpc/connect-node"
import { createClient } from "@connectrpc/connect"
import { randomUUID } from "node:crypto"
import { openDB, autoMigrate } from "../src/db.js"
import { createTSMRouter } from "../src/router.js"
import { PodmanPodClient } from "@openzerg/common/pod-client"
import { ToolServerManagerService } from "@openzerg/common/gen/toolservermanager/v1_pb.js"
import { WorkspaceManagerService } from "@openzerg/common/gen/workspacemanager/v1_pb.js"
import { create } from "@bufbuild/protobuf"
import { EmptySchema } from "@bufbuild/protobuf/wkt"
import {
  StartToolServerRequestSchema,
  StopToolServerRequestSchema,
  ListToolServersRequestSchema,
} from "@openzerg/common/gen/toolservermanager/v1_pb.js"
import {
  CreateWorkspaceRequestSchema,
  StartWorkerRequestSchema,
  StopWorkerRequestSchema,
  GetWorkerStatusRequestSchema,
} from "@openzerg/common/gen/workspacemanager/v1_pb.js"
import { execSync } from "node:child_process"

const PG_PORT = 15436
const PG_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/e2e_integration`
const TSM_PORT = 25083
const WM_PORT = 25084
const CONTAINER_URL = process.env.CONTAINER_URL || "http://127.0.0.1:8888"

let podClient: PodClient
let tsmClient: any
let wmClient: any
let db: any
let tsmServer: Server
let wmServer: Server

const tsmContainers: string[] = []
const wmContainers: string[] = []
const wmVolumes: string[] = []
let lastWorkerId = ""

beforeAll(async () => {
  podClient = new PodmanPodClient(CONTAINER_URL)

  try {
    execSync(
      `podman run -d --name e2e-integration-pg -p ${PG_PORT}:5432 ` +
      `-e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=e2e_integration ` +
      `docker.io/library/postgres:16-alpine`,
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
        .addColumn("lastSeen", "bigint", c => c.notNull())
        .addColumn("metadata", "text", c => c.defaultTo("{}"))
        .addColumn("createdAt", "bigint", c => c.notNull())
        .addColumn("updatedAt", "bigint", c => c.notNull())
        .execute()

      const { openDB: openWMDB, autoMigrate: migrateWM } = await import("../../workspace-manager/src/db.js")
      await migrateWM(PG_URL)

      ok = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (!ok) throw new Error("DB setup failed")

  const tsmHandler = connectNodeAdapter({ routes: createTSMRouter(db, podClient) })
  tsmServer = createServer(tsmHandler)
  tsmServer.listen(TSM_PORT)

  const { createWorkspaceManagerRouter } = await import("../../workspace-manager/src/router.js")
  const wmDb = (await import("../../workspace-manager/src/db.js")).openDB(PG_URL)
  const wmHandler = connectNodeAdapter({ routes: createWorkspaceManagerRouter(wmDb, podClient) })
  wmServer = createServer(wmHandler)
  wmServer.listen(WM_PORT)

  await new Promise(r => setTimeout(r, 200))

  const tsmTransport = createConnectTransport({ baseUrl: `http://localhost:${TSM_PORT}`, httpVersion: "1.1" })
  tsmClient = createClient(ToolServerManagerService, tsmTransport)

  const wmTransport = createConnectTransport({ baseUrl: `http://localhost:${WM_PORT}`, httpVersion: "1.1" })
  wmClient = createClient(WorkspaceManagerService, wmTransport)
}, 60_000)

afterAll(async () => {
  for (const c of [...tsmContainers, ...wmContainers]) {
    try { await podClient.stopPod(c) } catch {}
    try { await podClient.removePod(c) } catch {}
  }
  try { execSync("podman rm -f e2e-integration-pg", { stdio: "pipe" }) } catch {}
  tsmServer?.close()
  wmServer?.close()
  await db?.destroy()
}, 30_000)

describe("TSM: start/list/stop tool-fs container", () => {
  test("startToolServer creates tool-fs container", async () => {
    const resp = await tsmClient.startToolServer(create(StartToolServerRequestSchema, {
      type: "tool-fs",
      image: "docker.io/oven/bun:latest",
      command: ["sleep", "300"],
      env: [],
    }))
    expect(resp.containerName).toBeTruthy()
    expect(resp.instanceId).toBeTruthy()
    tsmContainers.push(resp.containerName)
    console.log(`[tsm] tool-fs container: ${resp.containerName}`)
  }, 30_000)

  test("listToolServers shows tool-fs", async () => {
    const resp = await tsmClient.listToolServers(create(ListToolServersRequestSchema))
    const fs = resp.servers.find((s: any) => s.type === "tool-fs")
    expect(fs).toBeDefined()
  }, 30_000)

  test("pod is running via PodClient", async () => {
    const info = await podClient.inspectPod(tsmContainers[tsmContainers.length - 1])
    expect(info.state).toMatch(/running|Running/)
    console.log(`[tsm] verified: ${info.name} running`)
  }, 30_000)

  test("stopToolServer removes tool-fs container", async () => {
    await tsmClient.stopToolServer(create(StopToolServerRequestSchema, { type: "tool-fs" }))
    await new Promise(r => setTimeout(r, 500))
    const info = await podClient.inspectPod(tsmContainers[tsmContainers.length - 1])
    expect(info.state).not.toBe("running")
    console.log(`[tsm] tool-fs stopped (state=${info.state})`)
  }, 30_000)
})

describe("WM: workspace volume + worker container lifecycle", () => {
  test("createWorkspace creates Podman volume", async () => {
    const resp = await wmClient.createWorkspace(create(CreateWorkspaceRequestSchema, {
      sessionId: randomUUID(),
    }))
    expect(resp.workspaceId).toBeTruthy()
    expect(resp.volumeName).toBeTruthy()
    wmVolumes.push(resp.volumeName)
    console.log(`[wm] workspace: volume=${resp.volumeName}`)
  }, 30_000)

  test("startWorker creates running container with volume mount", async () => {
    const ws = await wmClient.createWorkspace(create(CreateWorkspaceRequestSchema, {
      sessionId: randomUUID(),
    }))
    wmVolumes.push(ws.volumeName)

    const resp = await wmClient.startWorker(create(StartWorkerRequestSchema, {
      sessionId: randomUUID(),
      image: "docker.io/library/alpine:latest",
      command: ["sleep", "infinity"],
      env: {},
      volumes: [{ name: ws.volumeName, destination: "/data/workspace" }],
    }))
    expect(resp.workerId).toBeTruthy()
    expect(resp.containerName).toBeTruthy()
    wmContainers.push(resp.containerName)
    lastWorkerId = resp.workerId
    console.log(`[wm] worker: ${resp.containerName} (id=${resp.workerId})`)
  }, 30_000)

  test("worker pod is running via PodClient", async () => {
    const info = await podClient.inspectPod(wmContainers[wmContainers.length - 1])
    expect(info.state).toMatch(/running|Running/)
    console.log(`[wm] verified: ${info.name} running`)
  }, 30_000)

  test("stopWorker stops container", async () => {
    const resp = await wmClient.stopWorker(create(StopWorkerRequestSchema, {
      workerId: lastWorkerId,
    }))
    await new Promise(r => setTimeout(r, 500))

    const status = await wmClient.getWorkerStatus(create(GetWorkerStatusRequestSchema, {
      workerId: lastWorkerId,
    }))
    expect(status.state).toBe("stopped")
    console.log(`[wm] worker stopped`)
  }, 30_000)
})
