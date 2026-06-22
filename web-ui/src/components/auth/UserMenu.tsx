// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * User menu component
 * Avatar dropdown with profile, settings, logout options
 */

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export const UserMenu: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleProfileClick = () => {
    navigate('/settings?tab=profile');
  };

  const handleSettingsClick = () => {
    navigate('/settings');
  };

  const handleLogoutClick = async () => {
    await logout();
  };

  const getInitials = (name: string): string => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  const getRoleBadgeVariant = (roles: string[]): 'default' | 'secondary' | 'destructive' => {
    if (roles.includes('admin')) return 'destructive';
    if (roles.includes('operator')) return 'default';
    return 'secondary';
  };

  const getRoleLabel = (roles: string[]): string => {
    if (roles.includes('admin')) return 'Admin';
    if (roles.includes('operator')) return 'Operator';
    return 'Viewer';
  };

  if (!user) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="focus:outline-none">
        <Avatar className="h-8 w-8 cursor-pointer hover:opacity-80 transition-opacity">
          <AvatarImage src={user.avatar} alt={user.name} />
          <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-3 text-center border-b">
          <Avatar className="h-16 w-16 mx-auto mb-2">
            <AvatarImage src={user.avatar} alt={user.name} />
            <AvatarFallback className="text-lg">{getInitials(user.name)}</AvatarFallback>
          </Avatar>
          <div className="font-semibold">{user.name}</div>
          <div className="text-sm text-muted-foreground">{user.email}</div>
          <div className="mt-2">
            <Badge variant={getRoleBadgeVariant(user.roles)}>
              {getRoleLabel(user.roles)}
            </Badge>
          </div>
        </div>

        <DropdownMenuItem onClick={handleProfileClick}>
          <Icon name="user" size={16} className="mr-2" />
          <span>Profile</span>
        </DropdownMenuItem>

        <DropdownMenuItem onClick={handleSettingsClick}>
          <Icon name="gear-six" size={16} className="mr-2" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleLogoutClick}>
          <Icon name="sign-out" size={16} className="mr-2" />
          <span>Logout</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
