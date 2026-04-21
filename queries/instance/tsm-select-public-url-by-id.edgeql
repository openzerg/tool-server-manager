SELECT Instance { publicUrl }
FILTER .id = <uuid>$id AND .lifecycle = 'active'
LIMIT 1
