import { Card, Space, Tag, Typography } from 'antd';
import { Activity } from '../../types/entities';
import { formatCarbon, formatDate } from '../../utils/formatters';
import { CategoryBadge } from './CategoryBadge';

export function ActivityCard({ activity }: { activity: Activity }) {
  return (
    <Card className="activity-card" size="small">
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space size={6} wrap>
            <CategoryBadge category={activity.category} />
            {activity.isGenerated ? <Tag color="cyan">周期{activity.manuallyAdjusted ? '·已调整' : ''}</Tag> : null}
          </Space>
          <Typography.Text strong>{formatCarbon(activity.carbonValue)}</Typography.Text>
        </Space>
        <Typography.Text>{activity.subType} · {Number(activity.amount).toFixed(2)} {activity.unit}</Typography.Text>
        <div className="split-line">
          <span>{formatDate(activity.recordDate)}</span>
          <span>{activity.note || '无备注'}</span>
        </div>
      </Space>
    </Card>
  );
}

