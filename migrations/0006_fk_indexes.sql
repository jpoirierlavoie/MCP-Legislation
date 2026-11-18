-- Migration 0006 — index sur les clés étrangères entrantes de `articles` et `article_numbers`.
--
-- En production (`PRAGMA foreign_keys = 1`), `DELETE FROM divisions WHERE law_id = ? AND lang = ?`
-- vérifie `articles.division_id REFERENCES divisions(id)` pour chaque division supprimée : sans
-- index sur `articles(division_id)`, supprimer les 680 divisions du C.c.Q. déclenchait 680
-- balayages complets des ~56 000 lignes de `articles` (~63 s CPU) et dépassait le plafond CPU de
-- 30 s de Cloudflare D1. Idem pour `article_numbers(article_id)` (`REFERENCES articles(id)`).

CREATE INDEX IF NOT EXISTS idx_art_division_id ON articles(division_id);
CREATE INDEX IF NOT EXISTS idx_art_num_article_id ON article_numbers(article_id);
