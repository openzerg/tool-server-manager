import { randomUUID } from "node:crypto"
import type { DB } from "../db.js"
import { ToolServiceClient } from "@openzerg/common"

const now = () => BigInt(Date.now())

export function registerToolHandlers(db: DB) {
  return {
    async refreshToolCache(req: { instanceType: string }) {
      const instances = await db.selectFrom("registry_instances").selectAll()
        .where("instanceType", "=", req.instanceType)
        .where("lifecycle", "=", "active")
        .execute()

      let totalTools = 0
      for (const inst of instances) {
        await db.deleteFrom("cached_tools")
          .where("serviceId", "=", inst.id).execute()

        const client = new ToolServiceClient({ baseURL: inst.publicUrl })
        const result = await client.listTools()
        if (result.isErr()) continue

        const ts = now()
        for (const tool of result.value.tools) {
          await db.insertInto("cached_tools").values({
            id: randomUUID(),
            serviceId: inst.id,
            toolName: tool.name,
            description: tool.description,
            inputSchemaJson: tool.inputSchemaJson,
            outputSchemaJson: tool.outputSchemaJson,
            group: tool.group,
            priority: tool.priority,
            dependencies: JSON.stringify(tool.dependencies ?? []),
            createdAt: ts,
            updatedAt: ts,
          }).execute()
        }
        totalTools += result.value.tools.length
      }
      return { toolCount: totalTools }
    },

    async resolveTools(req: { sessionId: string; toolServerTypes: string[] }) {
      const types = req.toolServerTypes
      if (!types.length) return { tools: [], systemContext: "", toolServerUrls: [] }

      const instances = await db.selectFrom("registry_instances").selectAll()
        .where("instanceType", "in", types)
        .where("lifecycle", "=", "active")
        .execute()

      const seen = new Set<string>()
      const toolServerUrls: Array<{ name: string; url: string; config: Record<string, string> }> = []
      const serviceIds: string[] = []

      for (const inst of instances) {
        if (seen.has(inst.instanceType)) continue
        seen.add(inst.instanceType)
        toolServerUrls.push({
          name: inst.instanceType,
          url: inst.publicUrl,
          config: (typeof inst.metadata === "string" ? JSON.parse(inst.metadata || "{}") : inst.metadata ?? {}) as Record<string, string>,
        })
        serviceIds.push(inst.id)
      }

      if (serviceIds.length === 0) return { tools: [], systemContext: "", toolServerUrls }

      const cachedTools = await db.selectFrom("cached_tools").selectAll()
        .where("serviceId", "in", serviceIds)
        .orderBy("priority", "desc")
        .execute()

      const toolNames = new Set<string>()
      const tools: Array<{ name: string; description: string; inputSchemaJson: string; outputSchemaJson: string; group: string; priority: number }> = []
      for (const ct of cachedTools) {
        if (!toolNames.has(ct.toolName)) {
          toolNames.add(ct.toolName)
          tools.push({
            name: ct.toolName,
            description: ct.description,
            inputSchemaJson: ct.inputSchemaJson,
            outputSchemaJson: ct.outputSchemaJson,
            group: ct.group,
            priority: ct.priority,
          })
        }
      }

      return { tools, systemContext: "", toolServerUrls }
    },

    async executeTool(req: { sessionId: string; toolName: string; argsJson: string; sessionToken: string }) {
      const cached = await db.selectFrom("cached_tools").select(["serviceId"])
        .where("toolName", "=", req.toolName)
        .executeTakeFirst()

      if (!cached) {
        return { resultJson: "", success: false, error: `Tool not found: ${req.toolName}`, metadata: {} }
      }

      const inst = await db.selectFrom("registry_instances").select(["publicUrl"])
        .where("id", "=", cached.serviceId)
        .where("lifecycle", "=", "active")
        .executeTakeFirst()

      if (!inst) {
        return { resultJson: "", success: false, error: `Service offline for tool: ${req.toolName}`, metadata: {} }
      }

      const client = new ToolServiceClient({ baseURL: inst.publicUrl })
      const result = await client.executeTool(req.toolName, req.argsJson, req.sessionToken)

      if (result.isErr()) {
        return { resultJson: "", success: false, error: result.error.message, metadata: {} }
      }

      const r = result.value
      const md: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.metadata ?? {})) md[k] = v
      return { resultJson: r.resultJson, success: r.success, error: r.error, metadata: md }
    },
  }
}
