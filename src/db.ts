import { createGelClient, type GelClient } from "@openzerg/common-typescript/gel"

export type DB = GelClient

export function openDB(dsn: string): DB {
  return createGelClient(dsn)
}
