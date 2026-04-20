import type { ConnectRouter } from "@connectrpc/connect"
import { ToolServerManagerService } from "@openzerg/common/gen/toolservermanager/v1_pb.js"
import type { DB } from "./db.js"
import type { PodClient } from "@openzerg/pod-client"
import { registerContainerHandlers } from "./handlers/containers.js"
import { registerToolHandlers } from "./handlers/tools.js"

export function createTSMRouter(db: DB, podClient: PodClient): (router: ConnectRouter) => void {
  return (router: ConnectRouter) => {
    const containers = registerContainerHandlers(db, podClient)
    const tools = registerToolHandlers(db)

    router.service(ToolServerManagerService, {
      ...containers,
      ...tools,
      health: async () => ({ status: "ok" }),
    })
  }
}
