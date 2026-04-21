SELECT CachedTool {
  toolName, description, inputSchemaJson, outputSchemaJson,
  `group`, priority
}
FILTER .service.id IN {array_unpack(<array<uuid>>$ids)}
ORDER BY .priority DESC
