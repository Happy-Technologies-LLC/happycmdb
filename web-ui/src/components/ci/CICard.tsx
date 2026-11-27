// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Badge, Card, Icon, IconButton, SectionHeading, Tag, fmtDate } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { CI } from '../../services/ci.service';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge from './CITypeBadge';

interface CICardProps {
  ci: CI;
  onEdit?: (ci: CI) => void;
  onDelete?: (ci: CI) => void;
  onView?: (ci: CI) => void;
  /** Opens the read-only peek drawer; the control shows only when provided. */
  onPeek?: (ci: CI) => void;
  showActions?: boolean;
}

export const CICard: React.FC<CICardProps> = ({
  ci,
  onEdit,
  onDelete,
  onView,
  onPeek,
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

  // The action buttons sit inside the clickable card: their clicks must not also open the record.
  const own = (action: () => void) => (e?: unknown) => {
    (e as React.MouseEvent | undefined)?.stopPropagation?.();
    action();
  };

  return (
    <Card className="flex h-full cursor-pointer flex-col" onClick={handleView}>
      <div className="flex-1">
        <div className="mb-3 flex justify-between">
          <CITypeBadge type={ci.type} />
          <CIStatusBadge status={ci.status} />
        </div>

        <SectionHeading level={3} className="[&_h3]:truncate">
          {ci.name}
        </SectionHeading>

        {ci.description && (
          <p className="mb-3 line-clamp-2 min-h-[2.5em] text-sm text-[var(--hh-text-muted)]">{ci.description}</p>
        )}

        <div className="mb-2">
          <Badge variant="neutral" className="capitalize">
            {ci.environment}
          </Badge>
        </div>

        {ci.tags && ci.tags.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {ci.tags.slice(0, 3).map((tag) => (
              <Tag key={tag} icon="tag">
                {tag}
              </Tag>
            ))}
            {ci.tags.length > 3 && <Tag>+{ci.tags.length - 3}</Tag>}
          </div>
        )}

        <div className="mt-3 flex items-center text-xs text-[var(--hh-text-muted)]">
          <Icon name="clock" size={14} className="mr-1" />
          <span>Updated {fmtDate(ci.updated_at)}</span>
        </div>

        {ci.discovered_by && (
          <div className="mt-1 text-xs text-[var(--hh-text-muted)]">Discovered by: {ci.discovered_by}</div>
        )}
      </div>

      {showActions && (
        <div className="mt-4 flex justify-end gap-1">
          {onPeek && (
            <IconButton
              icon="sidebar-simple"
              variant="ghost"
              size="sm"
              title="Quick view"
              aria-label={`Quick view ${ci.name}`}
              onClick={own(() => onPeek(ci))}
            />
          )}
          <IconButton
            icon="eye"
            variant="ghost"
            size="sm"
            title="View Details"
            aria-label={`View details for ${ci.name}`}
            onClick={own(handleView)}
          />
          {onEdit && (
            <IconButton
              icon="pencil-simple"
              variant="ghost"
              size="sm"
              title="Edit"
              aria-label={`Edit ${ci.name}`}
              onClick={own(() => onEdit(ci))}
            />
          )}
          {onDelete && (
            <IconButton
              icon="trash"
              variant="ghost"
              size="sm"
              title="Delete"
              aria-label={`Delete ${ci.name}`}
              onClick={own(() => onDelete(ci))}
            />
          )}
        </div>
      )}
    </Card>
  );
};

export default CICard;
