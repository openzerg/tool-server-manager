INSERT CachedTool {
  service := (SELECT Instance FILTER .id = <uuid>$instanceId LIMIT 1),
  toolName := <str>$toolName,
  description := <str>$description,
  inputSchemaJson := <str>$inputSchemaJson,
  outputSchemaJson := <str>$outputSchemaJson,
  `group` := <str>$group,
  priority := <int32>$priority,
  dependencies := <str>$dependencies,
  createdAt := <int64>$ts,
  updatedAt := <int64>$ts,
}
