-- Add link_type and normalize wiki_path to store only the Wikipedia ID

-- 1) Add the new column with default 'active'
ALTER TABLE deaths ADD COLUMN link_type TEXT NOT NULL DEFAULT 'active';

-- 2) Populate link_type for existing redlinks
UPDATE deaths
SET link_type = CASE
  WHEN wiki_path LIKE '/w/index.php?title=%' AND wiki_path LIKE '%redlink=1%'
    THEN 'edit'
  ELSE 'active'
END
WHERE link_type IS NULL OR link_type NOT IN ('active','edit');

-- 3) Normalize wiki_path to only the article ID
--    a) Convert '/wiki/Foo' -> 'Foo'
UPDATE deaths
SET wiki_path = SUBSTR(wiki_path, 7)
WHERE wiki_path LIKE '/wiki/%';

--    b) Convert '/w/index.php?title=Foo&action=edit&redlink=1' -> 'Foo'
UPDATE deaths
SET wiki_path = (
  CASE
    WHEN INSTR(wiki_path, 'title=') > 0 THEN
      CASE
        WHEN INSTR(SUBSTR(wiki_path, INSTR(wiki_path,'title=') + 6), '&') > 0 THEN
          SUBSTR(
            SUBSTR(wiki_path, INSTR(wiki_path,'title=') + 6),
            1,
            INSTR(SUBSTR(wiki_path, INSTR(wiki_path,'title=') + 6), '&') - 1
          )
        ELSE SUBSTR(wiki_path, INSTR(wiki_path,'title=') + 6)
      END
    ELSE wiki_path
  END
)
WHERE wiki_path LIKE '/w/index.php?title=%';

-- 4) In the unlikely event that normalization created duplicate wiki_path values,
--    keep a single row per wiki_path (prefer 'active' over 'edit', otherwise the lowest id)
WITH groups AS (
  SELECT wiki_path,
         MIN(id) AS min_id,
         MIN(CASE WHEN link_type = 'active' THEN id END) AS active_id
  FROM deaths
  GROUP BY wiki_path
), keepers AS (
  SELECT COALESCE(active_id, min_id) AS id FROM groups
)
DELETE FROM deaths WHERE id NOT IN (SELECT id FROM keepers);

-- 5) Ensure uniqueness still holds after normalization
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deaths_wiki_path ON deaths(wiki_path);

