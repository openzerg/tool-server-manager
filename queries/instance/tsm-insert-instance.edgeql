SELECT (INSERT Instance {
  name := <str>$name,
  instanceType := <str>$instanceType,
  ip := '0.0.0.0',
  port := 0,
  publicUrl := '',
  lifecycle := 'active',
  lastSeen := <int64>$ts,
  metadata := <str>$metadata,
  createdAt := <int64>$ts,
  updatedAt := <int64>$ts,
}) { id }
