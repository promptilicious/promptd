import path from 'node:path';

import Database from 'better-sqlite3';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationResultSet } from 'kysely/migration';
import pg from 'pg';

import { ROOT } from './paths.js';

/** 0 or 1 in both dialects, so one schema serves SQLite and Postgres. */
type Flag = number;

interface JobColumns {
  id: string;
  name: string;
  description: string;
  workingDirectory: string;
  useWorktree: Flag;
  cleanupWorktree: Flag;
  model: string;
  effort: string;
  usageDelay: string;
  prompt: string;
  isActive: Flag;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunLog: string | null;
  lastRunDurationSeconds: number | null;
  lifetimeRuns: number | null;
  lifetimeCostUsd: number | null;
  lifetimeRuntimeSeconds: number | null;
}

export interface CronTable extends JobColumns {
  cron: string;
}

export interface ExecutionTable extends JobColumns {
  scheduledAt: string | null;
  status: string;
  firedAt: string | null;
  stoppedBy: string | null;
}

export interface NotificationTable {
  id: string;
  at: string;
  kind: string;
  message: string;
  read: Flag;
  cronId: string | null;
  cronName: string | null;
  jobKind: string;
}

export interface SettingTable {
  key: string;
  value: string;
}

export interface NodeTable {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  commit: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Tables {
  crons: CronTable;
  executions: ExecutionTable;
  notifications: NotificationTable;
  settings: SettingTable;
  nodes: NodeTable;
}

export type Db = Kysely<Tables>;

export const SQLITE_FILE = path.join(ROOT, 'promptd.sqlite');

function jobTable(db: Kysely<unknown>, name: string) {
  return db.schema
    .createTable(name)
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('working_directory', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('use_worktree', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('cleanup_worktree', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('model', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('effort', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('usage_delay', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('prompt', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('node_id', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addColumn('last_run_at', 'text')
    .addColumn('last_run_status', 'text')
    .addColumn('last_run_log', 'text')
    .addColumn('last_run_duration_seconds', 'double precision')
    .addColumn('lifetime_runs', 'integer')
    .addColumn('lifetime_cost_usd', 'double precision')
    .addColumn('lifetime_runtime_seconds', 'double precision');
}

// Kept in code rather than read from a folder, so the compiled build carries
// them. Column types stay to the set SQLite and Postgres both understand.
const MIGRATIONS: Record<string, Migration> = {
  '20260925_001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await jobTable(db, 'crons').addColumn('cron', 'text', (col) => col.notNull()).execute();
      await jobTable(db, 'executions')
        .addColumn('scheduled_at', 'text')
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('scheduled'))
        .addColumn('fired_at', 'text')
        .addColumn('stopped_by', 'text')
        .execute();
      await db.schema.createIndex('executions_scheduled_at').on('executions').column('scheduled_at').execute();
      await db.schema
        .createTable('notifications')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('at', 'text', (col) => col.notNull())
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('message', 'text', (col) => col.notNull())
        .addColumn('read', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('cron_id', 'text')
        .addColumn('cron_name', 'text')
        .addColumn('job_kind', 'text', (col) => col.notNull().defaultTo('cron'))
        .execute();
      await db.schema.createIndex('notifications_at').on('notifications').column('at').execute();
      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute();
      await db.schema
        .createTable('nodes')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('hostname', 'text')
        .addColumn('platform', 'text')
        .addColumn('commit', 'text')
        .addColumn('first_seen_at', 'text', (col) => col.notNull())
        .addColumn('last_seen_at', 'text', (col) => col.notNull())
        .execute();
    },
  },
};

export interface DatabaseTarget {
  dialect: 'postgres' | 'sqlite';
  /** A file path for SQLite; the URL with its password hidden for Postgres. */
  location: string;
}

let instance: Db | null = null;
let target: DatabaseTarget | null = null;

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

/** Opens the database once. `url` defaults to DATABASE_URL; unset, it is the SQLite file under the storage root. */
export function openDatabase(url = process.env.DATABASE_URL ?? ''): Db {
  if (instance) return instance;
  if (/^postgres(ql)?:\/\//.test(url)) {
    target = { dialect: 'postgres', location: redact(url) };
    instance = new Kysely<Tables>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
      plugins: [new CamelCasePlugin()],
    });
    return instance;
  }
  const file = url.replace(/^sqlite:/, '') || SQLITE_FILE;
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  target = { dialect: 'sqlite', location: file };
  instance = new Kysely<Tables>({ dialect: new SqliteDialect({ database: sqlite }), plugins: [new CamelCasePlugin()] });
  return instance;
}

export function db(): Db {
  return instance ?? openDatabase();
}

export function databaseTarget(): DatabaseTarget {
  db();
  if (!target) throw new Error('the database has not been opened');
  return target;
}

export async function migrate(): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db: db(),
    provider: { getMigrations: async () => MIGRATIONS },
  });
  const result = await migrator.migrateToLatest();
  for (const step of result.results ?? []) {
    console.log(`[db] migration ${step.migrationName}: ${step.status}`);
  }
  if (result.error) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result;
}

export async function closeDatabase(): Promise<void> {
  const open = instance;
  instance = null;
  target = null;
  await open?.destroy();
}
