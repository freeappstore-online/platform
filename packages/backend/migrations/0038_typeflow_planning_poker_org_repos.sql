-- typeflow and planning-poker are deployed from their freeappstore-online
-- repositories (registry.json lists them there), but apps.repo still names the
-- outside creator repositories they were first submitted from, so their first
-- keyless deploy was refused (#460, #523). Old values, for the record:
--   typeflow       https://github.com/abid8195/TypeFlow
--   planning-poker https://github.com/ChaoLIUqaq/planning-poker
UPDATE apps SET repo = 'https://github.com/freeappstore-online/typeflow'
 WHERE id = 'typeflow' AND lower(repo) = 'https://github.com/abid8195/typeflow';
UPDATE apps SET repo = 'https://github.com/freeappstore-online/planning-poker'
 WHERE id = 'planning-poker' AND lower(repo) = 'https://github.com/chaoliuqaq/planning-poker';
