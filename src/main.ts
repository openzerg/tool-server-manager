import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { autoMigrate, openDB } from "./db.js"
import { createTSMRouter } from "./router.js"
import { PodmanPodClient } from "@openzerg/common/pod-client"

const PORT = Number(process.env.PORT || 25021)
const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/tsm"
const POD_CLIENT_URL = process.env.POD_CLIENT_URL || process.env.CONTAINER_URL || process.env.PODMAN_SOCKET

async function main() {
  console.log("[tool-server-manager] starting...")
  await autoMigrate(DATABASE_URL)
  const db = openDB(DATABASE_URL)
  const podClient = new PodmanPodClient(POD_CLIENT_URL)
  const routes = createTSMRouter(db, podClient)

  const server = createServer(connectNodeAdapter({ routes }))
  server.listen(PORT, () => {
    console.log(`[tool-server-manager] listening on :${PORT}`)
  })
}

main().catch(e => {
  console.error("[tool-server-manager] fatal:", e)
  process.exit(1)
})
