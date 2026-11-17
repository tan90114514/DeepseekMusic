import fs from 'node:fs'
import path from 'node:path'
import type { Database, SqlJsStatic, SqlValue } from 'sql.js'

type Row = Record<string, SqlValue>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  path_key TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  artist_norm TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  genre TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  bvid TEXT,
  up_name TEXT NOT NULL DEFAULT '',
  metadata_locked INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_bvid ON songs(bvid) WHERE bvid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_songs_meta ON songs(title_norm, artist_norm, duration_ms);
CREATE INDEX IF NOT EXISTS idx_songs_path_key ON songs(path_key);
CREATE INDEX IF NOT EXISTS idx_songs_available ON songs(available);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  source_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  artist_norm TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  path_hint TEXT NOT NULL DEFAULT '',
  path_key TEXT NOT NULL DEFAULT '',
  match_status TEXT NOT NULL DEFAULT 'missing',
  match_method TEXT,
  match_score REAL NOT NULL DEFAULT 0,
  matched_song_id INTEGER,
  match_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_song_id) REFERENCES songs(id) ON DELETE SET NULL,
  UNIQUE (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, match_status);
CREATE INDEX IF NOT EXISTS idx_playlist_items_meta ON playlist_items(title_norm, artist_norm, duration_ms);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, source_key)
);

CREATE TABLE IF NOT EXISTS song_categories (
  category_id INTEGER NOT NULL,
  song_id INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (category_id, song_id),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_song_categories_song ON song_categories(song_id);

CREATE TABLE IF NOT EXISTS bili_favorites (
  media_id TEXT PRIMARY KEY,
  category_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',
  last_synced_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS download_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  media_id TEXT NOT NULL,
  category_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  current_title TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_download_jobs_media ON download_jobs(media_id, status);
CREATE INDEX IF NOT EXISTS idx_download_jobs_updated ON download_jobs(updated_at);

CREATE TABLE IF NOT EXISTS download_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  bvid TEXT NOT NULL,
  cid INTEGER,
  title TEXT NOT NULL,
  up_name TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  output_path TEXT NOT NULL DEFAULT '',
  song_id INTEGER,
  skip_reason TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES download_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL,
  UNIQUE (job_id, bvid)
);
CREATE INDEX IF NOT EXISTS idx_download_items_job ON download_items(job_id, status);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path TEXT NOT NULL,
  status TEXT NOT NULL,
  files_found INTEGER NOT NULL DEFAULT 0,
  files_indexed INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS lyrics_links (
  song_id INTEGER PRIMARY KEY,
  lrc_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
);
`

export class DatabaseStore {
  private db: Database
  private readonly filePath: string
  private closed = false

  private constructor(db: Database, filePath: string) {
    this.db = db
    this.filePath = filePath
  }

  static async open(filePath: string): Promise<DatabaseStore> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const sqlJsEntry = require.resolve('sql.js')
    const initSqlJs = require('sql.js') as (options: {
      wasmBinary: ArrayBuffer
    }) => Promise<SqlJsStatic>
    const wasmPath = path.join(path.dirname(sqlJsEntry), 'sql-wasm.wasm')
    const wasmBytes = new Uint8Array(fs.readFileSync(wasmPath))
    const SQL = await initSqlJs({ wasmBinary: wasmBytes.buffer as ArrayBuffer })

    let db: Database
    if (fs.existsSync(filePath)) {
      try {
        db = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)))
      } catch (error) {
        const backup = `${filePath}.corrupt-${Date.now()}`
        try {
          fs.copyFileSync(filePath, backup)
        } catch {
          // Best effort only; the original file stays in place.
        }
        throw new Error(
          `数据库无法读取，已停止启动以避免覆盖数据。备份路径：${backup}。原始错误：${(error as Error).message}`
        )
      }
    } else {
      db = new SQL.Database()
    }

    db.run('PRAGMA foreign_keys = ON')
    db.run(SCHEMA)
    const store = new DatabaseStore(db, filePath)
    store.save()
    return store
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params)
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  lastInsertId(): number {
    const row = this.get<{ id: number }>('SELECT last_insert_rowid() AS id')
    return Number(row?.id ?? 0)
  }

  getSetting(key: string): string | null {
    const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    )
  }

  save(): void {
    if (this.closed) return
    const data = Buffer.from(this.db.export())
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, this.filePath)
  }

  close(): void {
    if (this.closed) return
    this.save()
    this.db.close()
    this.closed = true
  }
}

export const now = (): number => Date.now()
