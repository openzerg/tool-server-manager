import postgres from "postgres"
import { Kysely } from "kysely"
import { PostgresJSDialect } from "kysely-postgres-js"
import type { Database } from "@openzerg/common/entities/kysely-database"

export type DB = Kysely<Database>

export function openDB(databaseURL: string): DB {
  const pg = postgres(databaseURL)
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  })
}

export async function autoMigrate(databaseURL: string): Promise<void> {
  const db = openDB(databaseURL)
  try {
    await db.schema.createTable("registry_instances")
      .ifNotExists()
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

    await db.schema.createIndex("idx_registry_instances_instanceType")
      .ifNotExists()
      .on("registry_instances")
      .column("instanceType")
      .execute()

    await db.schema.createTable("cached_tools")
      .ifNotExists()
      .addColumn("id", "text", c => c.notNull().primaryKey())
      .addColumn("serviceId", "text", c => c.notNull())
      .addColumn("toolName", "text", c => c.notNull())
      .addColumn("description", "text", c => c.notNull().defaultTo(""))
      .addColumn("inputSchemaJson", "text", c => c.notNull().defaultTo(""))
      .addColumn("outputSchemaJson", "text", c => c.notNull().defaultTo(""))
      .addColumn("group", "text", c => c.notNull().defaultTo(""))
      .addColumn("priority", "integer", c => c.notNull().defaultTo(0))
      .addColumn("dependencies", "text", c => c.notNull().defaultTo("[]"))
      .addColumn("createdAt", "bigint", c => c.notNull())
      .addColumn("updatedAt", "bigint", c => c.notNull())
      .execute()

    await db.schema.createIndex("idx_cached_tools_serviceId").ifNotExists()
      .on("cached_tools").column("serviceId").execute()
    await db.schema.createIndex("idx_cached_tools_toolName").ifNotExists()
      .on("cached_tools").column("toolName").execute()

    console.log("[tool-server-manager] database ready")
  } finally {
    await db.destroy()
  }
}
