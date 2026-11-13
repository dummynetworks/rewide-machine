CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title,
  description,
  text,
  content='documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS documents_fts_ai
AFTER INSERT ON documents
BEGIN
  INSERT INTO documents_fts (rowid, title, description, text)
  VALUES (new.rowid, new.title, new.description, new.text);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_ad
AFTER DELETE ON documents
BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, description, text)
  VALUES ('delete', old.rowid, old.title, old.description, old.text);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_au
AFTER UPDATE ON documents
BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, description, text)
  VALUES ('delete', old.rowid, old.title, old.description, old.text);

  INSERT INTO documents_fts (rowid, title, description, text)
  VALUES (new.rowid, new.title, new.description, new.text);
END;

INSERT INTO documents_fts (documents_fts) VALUES ('rebuild');
