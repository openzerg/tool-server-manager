import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { openDB } from "./db.js"
import { createTSMRouter } from "./router.js"
import { PodmanPodClient } from "@openzerg/common-typescript/pod-client"

const PORT = Number(process.env.PORT || 25021)
const GEL_DSN = process.env.GEL_DSN || "gel://admin@localhost/main?tls_security=insecure"
const POD_CLIENT_URL = process.env.POD_CLIENT_URL || process.env.CONTAINER_URL || process.env.PODMAN_SOCKET

async function main() {
  console.log("[tool-server-manager] starting...")
  const db = openDB(GEL_DSN)
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
