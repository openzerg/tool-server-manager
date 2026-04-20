import { randomUUID } from "node:crypto"
import type { DB } from "../db.js"
import type { PodClient } from "@openzerg/pod-client"

const now = () => BigInt(Date.now())

export function registerContainerHandlers(db: DB, podClient: PodClient) {
  return {
    async startToolServer(req: { type: string; image: string; env: Array<{ key: string; value: string }>; command?: string[] }) {
      const id = randomUUID()
      const podName = `tool-${req.type}-${id.slice(0, 8)}`
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
      await db.insertInto("registry_instances").values({
        id,
        name: podName,
        instanceType: req.type,
        ip: "0.0.0.0",
        port: 0,
        publicUrl: "",
        lifecycle: "active",
        lastSeen: ts,
        metadata: JSON.stringify({ image: req.image }),
        createdAt: ts,
        updatedAt: ts,
      }).execute()
      return { containerName: podName, instanceId: id }
    },

    async stopToolServer(req: { type: string }) {
      const instances = await db.selectFrom("registry_instances").selectAll()
        .where("instanceType", "=", req.type)
        .where("lifecycle", "=", "active")
        .execute()
      for (const inst of instances) {
        try {
          await podClient.stopPod(inst.name)
          await podClient.removePod(inst.name)
        } catch {}
        await db.updateTable("registry_instances").set({
          lifecycle: "stopped", updatedAt: now(),
        }).where("id", "=", inst.id).execute()
      }
      return {}
    },

    async listToolServers() {
      const instances = await db.selectFrom("registry_instances").selectAll()
        .where("instanceType", "!=", "")
        .orderBy("createdAt", "desc")
        .execute()

      const servers = []
      for (const inst of instances) {
        const toolCount = await db.selectFrom("cached_tools")
          .select(db.fn.countAll<number>().as("cnt"))
          .where("serviceId", "=", inst.id)
          .executeTakeFirst()
        servers.push({
          instanceId: inst.id,
          name: inst.name,
          type: inst.instanceType,
          url: inst.publicUrl,
          port: inst.port,
          lifecycle: inst.lifecycle,
          toolCount: Number(toolCount?.cnt ?? 0),
          containerName: inst.name,
        })
      }
      return { servers }
    },
  }
}
