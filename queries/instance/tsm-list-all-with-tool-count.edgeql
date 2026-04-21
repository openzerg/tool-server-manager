SELECT Instance {
  id, name, instanceType, publicUrl, port, lifecycle, createdAt,
  toolCount := count(.<service[is CachedTool])
}
ORDER BY .createdAt DESC
