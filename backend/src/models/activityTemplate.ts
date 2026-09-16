import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { RecurrenceFrequency } from '../constants/recurrence';
import { User } from './user';

@Entity('activity_templates')
export class ActivityTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: number;

  @Column({ length: 128 })
  name!: string;

  @Column({ type: 'enum', enum: ActivityCategory })
  category!: ActivityCategory;

  @Column({ name: 'sub_type', length: 64 })
  subType!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: string;

  @Column({ length: 32 })
  unit!: string;

  @Column({ type: 'enum', enum: RecurrenceFrequency })
  frequency!: RecurrenceFrequency;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  @Column({ name: 'anchor_date', type: 'date' })
  anchorDate!: string;

  @Column({ name: 'effective_date', type: 'date' })
  effectiveDate!: string;

  @Column({ type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => !!v } })
  enabled!: boolean;

  @Column({ name: 'paused_at', type: 'date', nullable: true })
  pausedAt!: string | null;

  @Column({ name: 'last_synced_date', type: 'date', nullable: true })
  lastSyncedDate!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
