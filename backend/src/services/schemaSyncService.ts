import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Idempotent schema bootstrap for volumes created before recurring templates existed.
 * docker-compose only runs database/init.sql on an empty data dir, so existing
 * deployments need these additive DDL statements at boot.
 *
 * MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, so every ALTER is gated on an
 * INFORMATION_SCHEMA lookup. DDL implicitly commits, therefore it all runs
 * outside any transaction and before Nest starts accepting traffic
 * (onModuleInit resolves before app.listen).
 */
@Injectable()
export class SchemaSyncService implements OnModuleInit {
  private readonly logger = new Logger('SchemaSyncService');

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      this.logger.error(`Recurrence schema sync failed: ${String(error)}`);
      throw error;
    }
  }

  private async sync(): Promise<void> {
    await this.dataSource.query(`CREATE TABLE IF NOT EXISTS activity_templates (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  name VARCHAR(128) NOT NULL,
  category ENUM('transport','energy','food','shopping') NOT NULL,
  sub_type VARCHAR(64) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  frequency ENUM('daily','weekly','monthly') NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  anchor_date DATE NOT NULL,
  effective_date DATE NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  paused_at DATE NULL,
  last_synced_date DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_templates_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_template_user_enabled (user_id, enabled)
)`);

    await this.dataSource.query(`CREATE TABLE IF NOT EXISTS activity_template_generations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  template_id BIGINT NOT NULL,
  activity_id BIGINT NULL,
  occurrence_date DATE NOT NULL,
  status ENUM('generated','adjusted','detached','deleted') NOT NULL DEFAULT 'generated',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_generations_template FOREIGN KEY (template_id) REFERENCES activity_templates(id) ON DELETE CASCADE,
  CONSTRAINT fk_generations_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE SET NULL,
  UNIQUE KEY uk_generation_template_date (template_id, occurrence_date),
  KEY idx_generation_activity (activity_id)
)`);

    const dbName = (await this.dataSource.query('SELECT DATABASE() AS db'))[0].db as string;

    if (!(await this.columnExists(dbName, 'activities', 'template_id'))) {
      await this.dataSource.query('ALTER TABLE activities ADD COLUMN template_id BIGINT NULL');
      await this.dataSource.query('ALTER TABLE activities ADD CONSTRAINT fk_activities_template FOREIGN KEY (template_id) REFERENCES activity_templates(id) ON DELETE SET NULL');
      await this.dataSource.query('ALTER TABLE activities ADD KEY idx_activity_template (template_id)');
      this.logger.log('Added activities.template_id');
    }
    if (!(await this.columnExists(dbName, 'activities', 'is_generated'))) {
      await this.dataSource.query('ALTER TABLE activities ADD COLUMN is_generated TINYINT(1) NOT NULL DEFAULT 0');
      this.logger.log('Added activities.is_generated');
    }
    if (!(await this.columnExists(dbName, 'activities', 'manually_adjusted'))) {
      await this.dataSource.query('ALTER TABLE activities ADD COLUMN manually_adjusted TINYINT(1) NOT NULL DEFAULT 0');
      this.logger.log('Added activities.manually_adjusted');
    }
  }

  private async columnExists(dbName: string, table: string, column: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [dbName, table, column]
    );
    return Array.isArray(rows) && rows.length > 0;
  }
}
