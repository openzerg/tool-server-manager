import type { DB } from "../db.js"
import type { PodClient } from "@openzerg/common-typescript/pod-client"
import { gelQuery } from "@openzerg/common-typescript/gel"
import * as queries from "../generated/queries.js"

const now = () => Number(BigInt(Date.now()))

export function registerContainerHandlers(db: DB, podClient: PodClient) {
  return {
    async startToolServer(req: { type: string; image: string; env: Array<{ key: string; value: string }>; command?: string[] }) {
      const podName = `tool-${req.type}-${Date.now().toString(36)}`
      const ts = now()
      const envMap: Record<string, string> = {}
      for (const e of req.env ?? []) envMap[e.key] = e.value
      await podClient.createPod({
        name: podName,
        labels: { "managed-by": "tsm", "tool-type": req.type },
        containers: [{
          name: podName,
          image: req.image,
          command: req.command,
          env: envMap,
        }],
      })
      await podClient.startPod(podName)
      const result = await gelQuery(() =>
        queries.tsmInsertInstance(db, { name: podName, instanceType: req.type, ts, metadata: JSON.stringify({ image: req.image }) })
      )
      const instanceId = result.isOk() ? result.value.id : ""
      return { containerName: podName, instanceId }
    },

    async stopToolServer(req: { type: string }) {
      const instances = await gelQuery(() =>
        queries.tsmSelectActiveByType(db, { instanceType: req.type })
      )
      if (instances.isErr()) return {}
      for (const inst of instances.value) {
        try {
          await podClient.stopPod(inst.name)
          await podClient.removePod(inst.name)
        } catch {}
      }
      await gelQuery(() =>
        queries.tsmSetStopped(db, { type: req.type, ts: now() })
      )
      return {}
    },

    async listToolServers() {
      const instances = await gelQuery(() =>
        queries.tsmListAllWithToolCount(db)
      )
      const servers = instances.isOk() ? instances.value.map((inst: any) => ({
        instanceId: inst.id,
        name: inst.name,
        type: inst.instanceType,
        url: inst.publicUrl,
        port: inst.port,
        lifecycle: inst.lifecycle,
        toolCount: inst.toolCount,
        containerName: inst.name,
      })) : []
      return { servers }
    },
  }
}
