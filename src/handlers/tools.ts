import type { DB } from "../db.js"
import { ToolServiceClient } from "@openzerg/common-typescript"
import { gelQuery } from "@openzerg/common-typescript/gel"
import * as queries from "../generated/queries.js"

export function registerToolHandlers(db: DB) {
  return {
    async refreshToolCache(req: { instanceType: string }) {
      const instancesResult = await gelQuery(() =>
        queries.tsmSelectActiveByType(db, { instanceType: req.instanceType })
      )
      if (instancesResult.isErr()) return { toolCount: 0 }
      const instances = instancesResult.value

      let totalTools = 0
      for (const inst of instances) {
        await gelQuery(() =>
          queries.tsmDeleteByService(db, { instanceId: inst.id })
        )

        const client = new ToolServiceClient({ baseURL: inst.publicUrl })
        const result = await client.listTools()
        if (result.isErr()) continue

        const ts = Number(BigInt(Date.now()))
        for (const tool of result.value.tools) {
          await gelQuery(() =>
            queries.tsmInsertCachedTool(db, {
              instanceId: inst.id,
              toolName: tool.name,
              description: tool.description,
              inputSchemaJson: tool.inputSchemaJson,
              outputSchemaJson: tool.outputSchemaJson,
              group: tool.group,
              priority: tool.priority,
              dependencies: JSON.stringify(tool.dependencies ?? []),
              ts,
            })
          )
        }
        totalTools += result.value.tools.length
      }
      return { toolCount: totalTools }
    },

    async resolveTools(req: { sessionId: string; toolServerTypes: string[] }) {
      const types = req.toolServerTypes
      if (!types.length) return { tools: [], systemContext: "", toolServerUrls: [] }

      const instancesResult = await gelQuery(() =>
        queries.tsmSelectActiveByType(db, { instanceType: types[0] })
      )
      if (instancesResult.isErr()) return { tools: [], systemContext: "", toolServerUrls: [] }

      const allInstances: any[] = []
      for (const t of types) {
        const r = await gelQuery(() =>
          queries.tsmSelectActiveByType(db, { instanceType: t })
        )
        if (r.isOk()) allInstances.push(...r.value)
      }

      const seen = new Set<string>()
      const toolServerUrls: Array<{ name: string; url: string; config: Record<string, string> }> = []
      const serviceIds: string[] = []

      for (const inst of allInstances) {
        if (seen.has(inst.instanceType)) continue
        seen.add(inst.instanceType)
        toolServerUrls.push({
          name: inst.instanceType,
          url: inst.publicUrl,
          config: {} as Record<string, string>,
        })
        serviceIds.push(inst.id)
      }

      if (serviceIds.length === 0) return { tools: [], systemContext: "", toolServerUrls }

      const cachedToolsResult = await gelQuery(() =>
        queries.tsmSelectByServices(db, { ids: serviceIds })
      )
      if (cachedToolsResult.isErr()) return { tools: [], systemContext: "", toolServerUrls }

      const toolNames = new Set<string>()
      const tools = []
      for (const ct of cachedToolsResult.value) {
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
      const cachedResult = await gelQuery(() =>
        queries.tsmSelectByToolName(db, { toolName: req.toolName })
      )
      if (cachedResult.isErr() || !cachedResult.value) {
        return { resultJson: "", success: false, error: `Tool not found: ${req.toolName}`, metadata: {} }
      }
      const cached = cachedResult.value as any

      const instResult = await gelQuery(() =>
        queries.tsmSelectPublicUrlById(db, { id: cached.serviceId })
      )
      if (instResult.isErr() || !instResult.value) {
        return { resultJson: "", success: false, error: `Service offline for tool: ${req.toolName}`, metadata: {} }
      }

      const client = new ToolServiceClient({ baseURL: instResult.value.publicUrl })
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
