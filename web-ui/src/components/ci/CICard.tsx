import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { CI } from '../../services/ci.service';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge from './CITypeBadge';
import { cn } from '../../utils/cn';

interface CICardProps {
  ci: CI;
  onEdit?: (ci: CI) => void;
  onDelete?: (ci: CI) => void;
  onView?: (ci: CI) => void;
  showActions?: boolean;
}

export const CICard: React.FC<CICardProps> = ({
  ci,
  onEdit,
  onDelete,
  onView,
  showActions = true,
}) => {
  const navigate = useNavigate();

  const handleView = () => {
    if (onView) {
      onView(ci);
    } else {
      navigate(`/inventory/${ci.id}`);
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) {
      onEdit(ci);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(ci);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div
      className={cn(
        'h-full flex flex-col bg-card border border-border rounded-lg shadow-sm',
        'transition-all duration-200 hover:-translate-y-1 hover:shadow-md cursor-pointer'
      )}
      onClick={handleView}
    >
      <div className="flex-1 p-4">
        <div className="flex justify-between mb-3">
          <CITypeBadge type={ci.type} />
          <CIStatusBadge status={ci.status} />
        </div>

        <h2 className="text-lg font-semibold mb-2 truncate text-navy">
          {ci.name}
        </h2>

        {ci.description && (
          <p className="text-sm text-muted-foreground mb-3 line-clamp-2 min-h-[2.5em]">
            {ci.description}
          </p>
        )}

        <div className="mb-2">
          <span className="inline-block px-2 py-1 text-xs font-medium border border-line rounded-md capitalize text-ink-soft">
            {ci.environment}
          </span>
        </div>

        {ci.tags && ci.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {ci.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-warm-alt rounded-md text-ink"
              >
                <Icon name="tag" size={12} />
                {tag}
              </span>
            ))}
            {ci.tags.length > 3 && (
              <span className="inline-block px-2 py-0.5 text-xs bg-warm-alt rounded-md text-ink">
                +{ci.tags.length - 3}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center mt-3 text-xs text-muted-foreground">
          <Icon name="clock" size={14} className="mr-1" />
          <span>Updated {formatDate(ci.updated_at)}</span>
        </div>

        {ci.discovered_by && (
          <div className="text-xs text-muted-foreground mt-1">
            Discovered by: {ci.discovered_by}
          </div>
        )}
      </div>

      {showActions && (
        <div className="flex justify-end gap-1 px-4 pb-4">
          <button
            onClick={handleView}
            className="p-1.5 hover:bg-warm rounded transition-colors"
            title="View Details"
          >
            <Icon name="eye" size={16} className="text-muted-foreground" />
          </button>
          {onEdit && (
            <button
              onClick={handleEdit}
              className="p-1.5 hover:bg-sky-soft rounded transition-colors"
              title="Edit"
            >
              <Icon name="pencil-simple" size={16} className="text-sky-text" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={handleDelete}
              className="p-1.5 hover:bg-danger-soft rounded transition-colors"
              title="Delete"
            >
              <Icon name="trash" size={16} className="text-danger" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default CICard;
