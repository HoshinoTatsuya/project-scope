-- migrate:up
CREATE TABLE IF NOT EXISTS oracle_log (id serial PRIMARY KEY, name text NOT NULL);
INSERT INTO oracle_log (name) VALUES ('20240101.sql');

-- migrate:down
