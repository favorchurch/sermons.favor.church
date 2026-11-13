// In-memory D1 stand-in over node:sqlite. Applies every migration in order, so new
// migrations are picked up without editing test files.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const migrationsDir = new URL('../../migrations/', import.meta.url);

export class DatabaseMock {
  constructor() {
    this.connection = new DatabaseSync(':memory:');
    this.connection.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
      this.connection.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
    }
  }
  prepare(sql) {
    const db = this.connection;
    return {
      bind(...args) {
        return {
          async first() { return db.prepare(sql).get(...args) ?? null; },
          async all() { return { results: db.prepare(sql).all(...args) }; },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; }
        };
      }
    };
  }
  async batch(statements) {
    this.connection.exec('BEGIN');
    try {
      const responses = [];
      for (const statement of statements) responses.push(await statement.run());
      this.connection.exec('COMMIT');
      return responses;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
  execute(sql, args = []) { return this.connection.prepare(sql).run(...args); }
  query(sql, args = []) { return this.connection.prepare(sql).all(...args); }
  close() { this.connection.close(); }
}
