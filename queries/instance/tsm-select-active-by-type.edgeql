SELECT Instance { id, name, publicUrl }
FILTER .instanceType = <str>$instanceType AND .lifecycle = 'active'
ORDER BY .lastSeen DESC
