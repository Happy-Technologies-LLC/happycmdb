import React, { useState } from 'react';
import { DiscoveryDefinition, DiscoveryProvider } from '../../services/discovery.service';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import { Icon } from '@happy-technologies/design-system';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { useToast } from '../../contexts/ToastContext';
import { brand } from '@/lib/brandColors';

interface DiscoveryDefinitionCardProps {
  definition: DiscoveryDefinition;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSchedule: (id: string, enabled: boolean) => void;
}

const PROVIDER_CONFIG: Record<
  DiscoveryProvider,
  { name: string; color: string; icon: string }
> = {
  nmap: { name: 'Network Scan (Nmap)', color: brand.navy, icon: 'share-network' },
  ssh: { name: 'SSH Discovery', color: brand.success, icon: 'hard-drive' },
  'active-directory': { name: 'Active Directory', color: brand.sky, icon: 'users' },
  snmp: { name: 'SNMP Discovery', color: brand.danger, icon: 'share-network' },
};

const formatRelativeTime = (dateString?: string): string => {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

const parseCronExpression = (cron?: string): string => {
  if (!cron) return 'Not configured';

  // Basic cron pattern recognition
  const patterns: Record<string, string> = {
    '0 0 * * *': 'Daily at midnight',
    '0 2 * * *': 'Daily at 2 AM',
    '0 0 * * 0': 'Weekly on Sunday',
    '0 0 1 * *': 'Monthly on 1st',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
  };

  return patterns[cron] || cron;
};

export const DiscoveryDefinitionCard: React.FC<DiscoveryDefinitionCardProps> = ({
  definition,
  onRun,
  onEdit,
  onDelete,
  onToggleSchedule,
}) => {
  const config = PROVIDER_CONFIG[definition.provider];
  const [isScheduleEnabled, setIsScheduleEnabled] = useState(definition.schedule.enabled);
  const { showToast } = useToast();

  const handleScheduleToggle = async () => {
    const newState = !isScheduleEnabled;
    setIsScheduleEnabled(newState);
    try {
      await onToggleSchedule(definition.id, newState);
      showToast(
        `Discovery schedule for ${definition.name} has been ${newState ? 'enabled' : 'disabled'}.`,
        'success'
      );
    } catch (error) {
      setIsScheduleEnabled(!newState);
      showToast('Failed to toggle schedule', 'error');
    }
  };

  const handleRun = () => {
    onRun(definition.id);
    showToast(`Running discovery for ${definition.name}...`, 'info');
  };

  const getStatusBadge = () => {
    if (!definition.lastRunStatus) {
      return <Badge variant="outline">Never run</Badge>;
    }

    switch (definition.lastRunStatus) {
      case 'completed':
        return (
          <Badge variant="secondary" className="flex items-center gap-1">
            <Icon name="check-circle" size={12} />
            Success
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="destructive" className="flex items-center gap-1">
            <Icon name="warning-circle" size={12} />
            Failed
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="default" className="flex items-center gap-1">
            <Icon name="clock" size={12} className="animate-spin" />
            Running
          </Badge>
        );
      default:
        return <Badge variant="outline">{definition.lastRunStatus}</Badge>;
    }
  };

  return (
    <Card className={`h-full flex flex-col ${definition.active ? '' : 'opacity-70'}`}>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-3">
            <Avatar className="w-12 h-12" style={{ backgroundColor: config.color }}>
              <AvatarFallback>
                <Icon name={config.icon} size={24} className="text-white" />
              </AvatarFallback>
            </Avatar>
            <div>
              <h3 className="font-semibold">{definition.name}</h3>
              <p className="text-xs text-muted-foreground">
                {config.name}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge variant={definition.active ? 'secondary' : 'outline'}>
              {definition.active ? 'Active' : 'Inactive'}
            </Badge>
            {getStatusBadge()}
          </div>
        </div>
        {definition.description && (
          <p className="text-sm text-muted-foreground mt-2">{definition.description}</p>
        )}
      </CardHeader>

      <CardContent className="flex-1">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="calendar" size={16} />
              <span>Schedule:</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {parseCronExpression(definition.schedule.cronExpression)}
              </span>
              <Switch
                checked={isScheduleEnabled}
                onCheckedChange={handleScheduleToggle}
                disabled={!definition.active || !definition.schedule.cronExpression}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Last Run:</span>
              <span className="text-sm font-medium">
                {formatRelativeTime(definition.lastRunAt)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Created:</span>
              <span className="text-sm font-medium">
                {formatRelativeTime(definition.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex gap-2">
        <Button
          className="flex-1"
          onClick={handleRun}
          disabled={!definition.active}
        >
          <Icon name="play" size={16} className="mr-2" />
          Run Now
        </Button>
        <Button
          variant="outline"
          onClick={() => onEdit(definition.id)}
        >
          <Icon name="pencil-simple" size={16} />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">
              <Icon name="trash" size={16} className="text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Discovery Definition</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{definition.name}"? This action cannot be
                undone. Any scheduled jobs will be cancelled.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(definition.id)}
                className="bg-destructive text-destructive-foreground"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
};

export default DiscoveryDefinitionCard;
