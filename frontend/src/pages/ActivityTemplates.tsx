import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { CategoryBadge } from '../components/common/CategoryBadge';
import { EmptyState } from '../components/common/EmptyState';
import { ActivityCategory, ACTIVITY_CATEGORY_LABELS } from '../constants/activity';
import { Messages } from '../constants/messages';
import { RecurrenceFrequency, RECURRENCE_FREQUENCY_LABELS, RecomputeMode, RECOMPUTE_MODE_LABELS } from '../constants/recurrence';
import { useAuth } from '../hooks/useAuth';
import { useActivityTemplateStore } from '../stores/activityTemplateStore';
import { ActivityTemplate } from '../types/entities';
import { formatDateRange, formatFrequency, formatTemplateState } from '../utils/formatters';

interface TemplateFormValues {
  name: string;
  category: ActivityCategory;
  subType: string;
  amount: number;
  unit: string;
  frequency: RecurrenceFrequency;
  range: [Dayjs, Dayjs | null];
  enabled?: boolean;
  recomputeMode?: RecomputeMode;
}

const stateColor = (template: ActivityTemplate) => {
  if (!template.enabled) return 'default';
  return template.pausedAt ? 'warning' : 'processing';
};

export function ActivityTemplates() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ActivityTemplate | null>(null);
  const [formKey, setFormKey] = useState(0);
  const templates = useActivityTemplateStore((state) => state.templates);
  const load = useActivityTemplateStore((state) => state.load);
  const create = useActivityTemplateStore((state) => state.create);
  const update = useActivityTemplateStore((state) => state.update);
  const enable = useActivityTemplateStore((state) => state.enable);
  const pause = useActivityTemplateStore((state) => state.pause);
  const resume = useActivityTemplateStore((state) => state.resume);
  const remove = useActivityTemplateStore((state) => state.remove);
  const { token } = useAuth();

  useEffect(() => {
    if (!token) return;
    void load();
  }, [load, token]);

  const sorted = useMemo(() => templates.slice().sort((a, b) => Number(b.id) - Number(a.id)), [templates]);

  const openCreate = () => {
    setEditing(null);
    setFormKey((key) => key + 1);
    setOpen(true);
  };

  const openEdit = (template: ActivityTemplate) => {
    setEditing(template);
    setFormKey((key) => key + 1);
    setOpen(true);
  };

  const initialValues: Partial<TemplateFormValues> = editing
    ? {
        name: editing.name,
        category: editing.category,
        subType: editing.subType,
        amount: Number(editing.amount),
        unit: editing.unit,
        frequency: editing.frequency,
        range: [dayjs(editing.startDate), editing.endDate ? dayjs(editing.endDate) : null],
        recomputeMode: RecomputeMode.FUTURE
      }
    : {
        name: '',
        category: ActivityCategory.TRANSPORT,
        subType: 'metro',
        amount: 10,
        unit: 'km',
        frequency: RecurrenceFrequency.WEEKLY,
        range: [dayjs(), null],
        enabled: false
      };

  const handleFinish = async (values: TemplateFormValues) => {
    const [start, end] = values.range;
    const base = {
      name: values.name,
      category: values.category,
      subType: values.subType,
      amount: values.amount,
      unit: values.unit,
      frequency: values.frequency,
      startDate: start.format('YYYY-MM-DD'),
      endDate: end ? end.format('YYYY-MM-DD') : null
    };
    if (editing) {
      await update(Number(editing.id), { ...base, recomputeMode: values.recomputeMode ?? RecomputeMode.FUTURE });
      message.success(Messages.FRONTEND_TEMPLATE_SAVED);
    } else {
      await create({ ...base, enabled: values.enabled });
      message.success(values.enabled ? Messages.FRONTEND_TEMPLATE_ENABLED : Messages.FRONTEND_TEMPLATE_SAVED);
    }
    setOpen(false);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <div>
          <Typography.Title level={2}>周期模板</Typography.Title>
          <Typography.Text type="secondary">按日/周/月自动补算活动，启用后补齐截至当天的缺记录。</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建模板</Button>
      </Space>

      <div className="card-grid">
        {sorted.length ? (
          sorted.map((template) => (
            <Card key={template.id} className="activity-card" size="small">
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text strong>{template.name}</Typography.Text>
                  <Tag color={stateColor(template)}>{formatTemplateState(template.enabled, template.pausedAt)}</Tag>
                </Space>
                <Space size={6} wrap>
                  <CategoryBadge category={template.category} />
                  <Tag>{formatFrequency(template.frequency)}</Tag>
                </Space>
                <Typography.Text type="secondary">{ACTIVITY_CATEGORY_LABELS[template.category]} · {template.subType} · {Number(template.amount)} {template.unit}</Typography.Text>
                <Typography.Text type="secondary">{formatDateRange(template.startDate, template.endDate)}</Typography.Text>
                <div className="split-line">
                  <span>已生成 {template.generatedCount ?? 0} 条</span>
                  {template.pausedAt ? <span>暂停于 {template.pausedAt}</span> : null}
                </div>
                <Space wrap>
                  {!template.enabled ? (
                    <Button size="small" type="primary" onClick={() => { void enable(Number(template.id)).then(() => message.success(Messages.FRONTEND_TEMPLATE_ENABLED)); }}>启用并补算</Button>
                  ) : template.pausedAt ? (
                    <Button size="small" type="primary" onClick={() => { void resume(Number(template.id)).then(() => message.success(Messages.FRONTEND_TEMPLATE_RESUMED)); }}>恢复</Button>
                  ) : (
                    <Button size="small" onClick={() => { void pause(Number(template.id)).then(() => message.success(Messages.FRONTEND_TEMPLATE_PAUSED)); }}>暂停</Button>
                  )}
                  <Button size="small" onClick={() => openEdit(template)}>编辑</Button>
                  <Popconfirm
                    title="删除该模板？"
                    description="已生成的活动会保留为独立记录，不会被删除。"
                    onConfirm={() => remove(Number(template.id)).then(() => message.success(Messages.FRONTEND_TEMPLATE_DELETED))}
                  >
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              </Space>
            </Card>
          ))
        ) : (
          <EmptyState text="暂无周期模板，新建后可自动生成活动" />
        )}
      </div>

      <Modal title={editing ? '编辑周期模板' : '新建周期模板'} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>
        <Form key={formKey} layout="vertical" initialValues={initialValues} onFinish={(values) => void handleFinish(values as TemplateFormValues)}>
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input placeholder="每月电费 / 每日通勤" />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select options={Object.values(ActivityCategory).map((value) => ({ value, label: ACTIVITY_CATEGORY_LABELS[value] }))} />
          </Form.Item>
          <Form.Item name="subType" label="子类型" rules={[{ required: true }]}>
            <Input placeholder="metro / electricity / beef-meal / parcel" />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="amount" label="数量" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={0.01} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="unit" label="单位" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="km / kWh / meal" />
            </Form.Item>
            <Form.Item name="frequency" label="重复频率" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={Object.values(RecurrenceFrequency).map((value) => ({ value, label: RECURRENCE_FREQUENCY_LABELS[value] }))} />
            </Form.Item>
          </Space>
          <Form.Item name="range" label="起止日期（结束日期留空表示长期）" rules={[{ required: true }]}>
            <DatePicker.RangePicker style={{ width: '100%' }} />
          </Form.Item>
          {!editing ? (
            <Form.Item name="enabled" label="保存后立即启用并补算" valuePropName="checked">
              <Switch />
            </Form.Item>
          ) : (
            <Form.Item name="recomputeMode" label="对已生成记录的影响">
              <Radio.Group>
                <Space direction="vertical">
                  {Object.values(RecomputeMode).map((value) => (
                    <Radio key={value} value={value}>{RECOMPUTE_MODE_LABELS[value]}</Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block>保存</Button>
        </Form>
      </Modal>
    </Space>
  );
}
