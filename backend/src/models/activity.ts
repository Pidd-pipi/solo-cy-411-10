import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { ActivityTemplate } from './activityTemplate';
import { CarbonFactor } from './carbonFactor';
import { User } from './user';

@Entity('activities')
export class Activity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: number;

  @Column({ name: 'factor_id', type: 'bigint', nullable: true })
  factorId!: number | null;

  @Column({ type: 'enum', enum: ActivityCategory })
  category!: ActivityCategory;

  @Column({ name: 'sub_type', length: 64 })
  subType!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: string;

  @Column({ length: 32 })
  unit!: string;

  @Column({ name: 'carbon_value', type: 'decimal', precision: 12, scale: 2 })
  carbonValue!: string;

  @Column({ name: 'record_date', type: 'date' })
  recordDate!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  @Column({ name: 'template_id', type: 'bigint', nullable: true })
  templateId!: number | null;

  @Column({ name: 'is_generated', type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => !!v } })
  isGenerated!: boolean;

  @Column({ name: 'manually_adjusted', type: 'tinyint', width: 1, default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => !!v } })
  manuallyAdjusted!: boolean;

  @ManyToOne(() => User, (user) => user.activities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => CarbonFactor, (factor) => factor.activities, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'factor_id' })
  factor!: CarbonFactor | null;

  @ManyToOne(() => ActivityTemplate, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'template_id' })
  template!: ActivityTemplate | null;
}
