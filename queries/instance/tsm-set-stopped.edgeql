UPDATE Instance
FILTER .instanceType = <str>$type AND .lifecycle = 'active'
SET { lifecycle := 'stopped', updatedAt := <int64>$ts }
