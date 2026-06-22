// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  type?: string;
}

interface SearchBarProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSearch?: (value: string) => void;
  onResultClick?: (result: SearchResult) => void;
  results?: SearchResult[];
  loading?: boolean;
  showFilters?: boolean;
  onFilterClick?: () => void;
  debounceTime?: number;
  fullWidth?: boolean;
}

// Debounce utility
function debounce<T extends (...args: any[]) => any>(func: T, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

const SearchBar: React.FC<SearchBarProps> = ({
  placeholder = 'Search configuration items...',
  value: controlledValue,
  onChange,
  onSearch,
  onResultClick,
  results = [],
  loading = false,
  showFilters = false,
  onFilterClick,
  debounceTime = 300,
  fullWidth = false,
}) => {
  const [value, setValue] = useState(controlledValue || '');
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync with controlled value
  useEffect(() => {
    if (controlledValue !== undefined) {
      setValue(controlledValue);
    }
  }, [controlledValue]);

  // Debounced search
  const debouncedSearch = useCallback(
    debounce((searchValue: string) => {
      onSearch?.(searchValue);
    }, debounceTime),
    [onSearch, debounceTime]
  );

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = event.target.value;
    setValue(newValue);
    onChange?.(newValue);

    if (newValue.length > 0) {
      debouncedSearch(newValue);
      setShowResults(true);
    } else {
      setShowResults(false);
    }
  };

  const handleClear = () => {
    setValue('');
    onChange?.('');
    setShowResults(false);
  };

  const handleResultClick = (result: SearchResult) => {
    onResultClick?.(result);
    setShowResults(false);
  };

  const handleFocus = () => {
    if (value.length > 0 && results.length > 0) {
      setShowResults(true);
    }
  };

  return (
    <div className={cn('relative', fullWidth ? 'w-full' : 'w-auto')}>
      <div className={cn(
        'flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm',
        fullWidth ? 'w-full' : 'w-[400px]'
      )}>
        <Icon name="magnifying-glass" size={16} className="text-muted-foreground" />
        <Input
          ref={inputRef}
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          className="flex-1 border-0 p-0 shadow-none focus-visible:ring-0"
        />
        {value && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClear}
              className="h-6 w-6"
            >
              <Icon name="x" size={16} />
            </Button>
            <Separator orientation="vertical" className="h-6" />
          </>
        )}
        {showFilters && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onFilterClick}
            className="h-6 w-6"
          >
            <Icon name="funnel" size={16} />
          </Button>
        )}
      </div>

      {showResults && (value.length > 0) && (
        <Popover open={showResults} onOpenChange={setShowResults}>
          <PopoverContent
            align="start"
            className={cn(
              'mt-1 max-h-[400px] overflow-auto p-0',
              fullWidth ? 'w-full' : 'w-[400px]'
            )}
          >
            {loading ? (
              <div className="p-4 text-center">
                <p className="text-sm text-muted-foreground">Searching...</p>
              </div>
            ) : results.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-sm text-muted-foreground">No results found</p>
              </div>
            ) : (
              <div className="divide-y">
                {results.map((result) => (
                  <button
                    key={result.id}
                    onClick={() => handleResultClick(result)}
                    className="w-full px-4 py-3 text-left hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{result.title}</span>
                      {result.type && (
                        <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {result.type}
                        </span>
                      )}
                    </div>
                    {result.subtitle && (
                      <p className="mt-1 text-xs text-muted-foreground">{result.subtitle}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
};

export default SearchBar;
