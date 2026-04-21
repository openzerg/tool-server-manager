SELECT CachedTool { serviceId := .service.id }
FILTER .toolName = <str>$toolName
LIMIT 1
