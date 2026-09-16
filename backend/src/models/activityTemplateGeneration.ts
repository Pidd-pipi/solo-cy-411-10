import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { GenerationStatus } from '../constants/recurrence';
import { Activity } from './activity';
import { ActivityTemplate } from './activityTemplate';

@Entity('activity_template_generations')
export class ActivityTemplateGeneration {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ name: 'template_id', type: 'bigint' })
  templateId!: number;

  @Column({ name: 'activity_id', type: 'bigint', nullable: true })
  activityId!: number | null;

  @Column({ name: 'occurrence_date', type: 'date' })
  occurrenceDate!: string;

  @Column({ type: 'enum', enum: GenerationStatus, default: GenerationStatus.GENERATED })
  status!: GenerationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;

  @ManyToOne(() => ActivityTemplate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template!: ActivityTemplate;

  @ManyToOne(() => Activity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'activity_id' })
  activity!: Activity | null;
}
