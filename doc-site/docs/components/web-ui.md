---
title: Web UI
description: React dashboard setup, components, and development guide
---

# Web UI

React dashboard for HappyCMDB platform.

## Getting Started

### Installation & Setup

```bash
# Navigate to web-ui directory
cd /path/to/happycmdb/web-ui

# Install dependencies
npm install

# Create environment file
cat > .env << EOF
VITE_API_BASE_URL=http://localhost:3001
VITE_GRAPHQL_URL=http://localhost:3001/graphql
EOF

# Start development server
npm run dev

# Open browser
# http://localhost:3000
```

### Available Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `npm run dev` | Start dev server | Development |
| `npm run build` | Build for production | Before deployment |
| `npm run preview` | Preview production build | Test build locally |
| `npm run lint` | Run ESLint | Before commit |
| `npm run type-check` | TypeScript check | Before commit |

## Project Structure

```
web-ui/src/
├── components/     # React components (organized by domain)
│   ├── analytics/  # Charts, metrics, reports
│   ├── auth/       # Login, user menu, protected routes
│   ├── ci/         # CI cards, lists, forms, badges
│   ├── common/     # Reusable components (Header, Sidebar, etc.)
│   ├── discovery/  # Provider cards, job monitoring
│   ├── jobs/       # Job lists, queue stats, workers
│   ├── settings/   # Settings pages and forms
│   └── visualization/ # Graphs, topology maps
├── pages/          # Route components (Dashboard, Inventory, etc.)
├── services/       # API clients (REST & GraphQL)
├── hooks/          # Custom React hooks (useCIs, useJobs, etc.)
├── contexts/       # React Context providers (AuthContext)
├── types/          # TypeScript type definitions
├── styles/         # Theme and global styles
├── utils/          # Helper functions
├── App.tsx         # Root component with routing
└── main.tsx        # Entry point
```

### Key Directories

#### `/components` - UI Components
Organized by domain. Each folder has:
- Component files (`.tsx`)
- `index.ts` barrel export

#### `/pages` - Route Components
Top-level pages mapped to routes:
- `Dashboard.tsx` → `/`
- `Inventory.tsx` → `/inventory`
- `Discovery.tsx` → `/discovery`
- `Jobs.tsx` → `/jobs`
- `Analytics.tsx` → `/analytics`
- `Settings.tsx` → `/settings`
- `Login.tsx` → `/login`

#### `/services` - API Layer
API clients for backend communication:
- `api.ts` - Axios instance with interceptors
- `ci.service.ts` - CI CRUD operations
- `discovery.service.ts` - Discovery operations
- `jobs.service.ts` - Job queue operations
- `analytics.service.ts` - Analytics data
- `auth.service.ts` - Authentication
- `graphql.ts` - Apollo Client instance

#### `/hooks` - Custom Hooks
React hooks for data fetching and business logic:
- `useCIs.ts` - CI data and mutations
- `useDiscovery.ts` - Discovery operations
- `useJobs.ts` - Job queue data
- `useAuth.ts` - Authentication state

## Common Components

### Header
```typescript
import Header from '@components/common/Header';

<Header />
```
**Features**: Logo, search bar, notifications, user menu

### Sidebar
```typescript
import Sidebar from '@components/common/Sidebar';

<Sidebar />
```
**Features**: Navigation menu, route highlighting

### LoadingSpinner
```typescript
import LoadingSpinner from '@components/common/LoadingSpinner';

<LoadingSpinner />
```
**Variants**: Full page, inline

### DataTable
```typescript
import DataTable from '@components/common/DataTable';
import { GridColDef } from '@mui/x-data-grid';

const columns: GridColDef[] = [
  { field: 'id', headerName: 'ID', width: 100 },
  { field: 'name', headerName: 'Name', width: 200 },
  { field: 'status', headerName: 'Status', width: 150 },
];

<DataTable
  rows={data}
  columns={columns}
  loading={isLoading}
  onRowClick={(row) => console.log(row)}
  pageSize={25}
/>
```

## CI Components

### CICard
```typescript
import { CICard } from '@components/ci';

<CICard
  ci={{
    id: 'ci-1',
    name: 'web-server-01',
    type: 'server',
    status: 'active',
    environment: 'production',
  }}
  onClick={(ci) => navigate(`/inventory/${ci.id}`)}
/>
```

### Status & Type Badges
```typescript
import { CIStatusBadge, CITypeBadge } from '@components/ci';

<CIStatusBadge status="active" />
<CITypeBadge type="server" />
```

## Visualization Components

### DependencyGraph
```typescript
import { DependencyGraph } from '@components/visualization';

<Box sx={{ height: 600 }}>
  <DependencyGraph
    ciId="ci-12345"
    depth={2}
    direction="both"
  />
</Box>
```
**Note**: Container must have explicit height

### TopologyMap
```typescript
import { TopologyMap } from '@components/visualization';

<Box sx={{ height: 500 }}>
  <TopologyMap nodes={nodes} edges={edges} />
</Box>
```

## Analytics Components

### MetricCard
```typescript
import { MetricCard } from '@components/analytics';

<MetricCard
  title="Total CIs"
  value={1234}
  change={+12}
  icon={<DevicesIcon />}
  color="primary"
/>
```

### TypeDistribution
```typescript
import { TypeDistribution } from '@components/analytics';

<TypeDistribution data={distributionData} />
```

## React Query Hooks

### useCIs
```typescript
import { useCIs, useCI, useCreateCI, useUpdateCI, useDeleteCI } from '@hooks/useCIs';

// Get all CIs
const { data, isLoading, error } = useCIs({ status: 'active' });

// Get single CI
const { data: ci } = useCI('ci-12345');

// Create CI
const createCI = useCreateCI();
createCI.mutate({
  name: 'new-ci',
  type: 'server',
  status: 'active',
});

// Update CI
const updateCI = useUpdateCI();
updateCI.mutate({
  id: 'ci-12345',
  data: { status: 'maintenance' },
});

// Delete CI
const deleteCI = useDeleteCI();
deleteCI.mutate('ci-12345');
```

### useDiscovery
```typescript
import {
  useDiscoveryJobs,
  useTriggerDiscovery,
  useDiscoverySchedules,
} from '@hooks/useDiscovery';

// Get jobs
const { data: jobs } = useDiscoveryJobs({ status: 'completed' });

// Trigger discovery
const triggerDiscovery = useTriggerDiscovery();
triggerDiscovery.mutate({
  provider: 'aws',
  scope: 'incremental',
});

// Get schedules
const { data: schedules } = useDiscoverySchedules();
```

### useAuth
```typescript
import { useAuth } from '@hooks/useAuth';

function MyComponent() {
  const { user, isAuthenticated, login, logout } = useAuth();

  const handleLogin = async () => {
    await login('admin@example.com', 'password123');
  };

  const handleLogout = () => {
    logout();
  };

  return (
    <div>
      {isAuthenticated ? (
        <div>
          <p>Welcome, {user.name}!</p>
          <button onClick={handleLogout}>Logout</button>
        </div>
      ) : (
        <button onClick={handleLogin}>Login</button>
      )}
    </div>
  );
}
```

## Styling Guidelines

### Using sx Prop (Recommended)

```typescript
<Box
  sx={{
    p: 3,                          // padding: 24px (3 * 8px)
    m: 2,                          // margin: 16px (2 * 8px)
    bgcolor: 'primary.main',       // background color from theme
    color: 'primary.contrastText', // text color
    borderRadius: 2,               // border-radius: 16px
    boxShadow: 3,                  // box-shadow from theme
    '&:hover': {
      boxShadow: 5,
      transform: 'scale(1.02)',
    },
  }}
>
  Content
</Box>
```

### Responsive Styling

```typescript
<Box
  sx={{
    display: 'flex',
    flexDirection: {
      xs: 'column',   // Mobile: stack vertically
      md: 'row',      // Desktop: horizontal layout
    },
    gap: { xs: 2, md: 3 },
    p: { xs: 2, sm: 3, md: 4 },
  }}
>
  <Box sx={{ flex: 1 }}>Left</Box>
  <Box sx={{ flex: 1 }}>Right</Box>
</Box>
```

### Common Spacing Values

```typescript
// Material-UI spacing: 1 unit = 8px
sx={{ p: 1 }}   // padding: 8px
sx={{ p: 2 }}   // padding: 16px
sx={{ p: 3 }}   // padding: 24px
sx={{ p: 4 }}   // padding: 32px

sx={{ mt: 2 }}  // margin-top: 16px
sx={{ mb: 3 }}  // margin-bottom: 24px
sx={{ mx: 2 }}  // margin-left & right: 16px
sx={{ my: 3 }}  // margin-top & bottom: 24px
```

### Color Palette

```typescript
// Primary colors
sx={{ bgcolor: 'primary.main' }}       // #1976d2
sx={{ bgcolor: 'primary.light' }}      // #42a5f5
sx={{ bgcolor: 'primary.dark' }}       // #1565c0

// Status colors
sx={{ bgcolor: 'success.main' }}       // #2e7d32 (green)
sx={{ bgcolor: 'warning.main' }}       // #ed6c02 (orange)
sx={{ bgcolor: 'error.main' }}         // #d32f2f (red)
sx({ bgcolor: 'info.main' }}          // #0288d1 (blue)

// Background colors
sx={{ bgcolor: 'background.default' }} // #f5f5f5
sx={{ bgcolor: 'background.paper' }}   // #ffffff

// Text colors
sx={{ color: 'text.primary' }}         // rgba(0, 0, 0, 0.87)
sx={{ color: 'text.secondary' }}       // rgba(0, 0, 0, 0.6)
```

## Code Patterns

### Loading State Pattern

```typescript
function MyComponent() {
  const { data, isLoading, error } = useCIs();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography color="error">Error: {error.message}</Typography>
      </Box>
    );
  }

  return <div>{/* Render data */}</div>;
}
```

### Modal Pattern

```typescript
function MyComponent() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Modal</Button>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Modal Title</DialogTitle>
        <DialogContent>
          <Typography>Modal content here</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => setOpen(false)}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
```

### Error Handling Pattern

```typescript
function MyComponent() {
  const createCI = useCreateCI();

  const handleSubmit = async (data: CreateCIInput) => {
    try {
      await createCI.mutateAsync(data);
      toast.success('CI created successfully');
    } catch (error) {
      toast.error(`Failed to create CI: ${error.message}`);
    }
  };

  return <CIForm onSubmit={handleSubmit} />;
}
```

## Common Pitfalls

### 1. Forgetting Container Height for Graphs

❌ **Wrong**:
```typescript
<DependencyGraph ciId="ci-123" />
```

✅ **Correct**:
```typescript
<Box sx={{ height: 600 }}>
  <DependencyGraph ciId="ci-123" />
</Box>
```

### 2. Not Invalidating Queries After Mutation

❌ **Wrong**:
```typescript
const createCI = useMutation({
  mutationFn: ciService.createCI,
  // Missing onSuccess!
});
```

✅ **Correct**:
```typescript
const createCI = useMutation({
  mutationFn: ciService.createCI,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['cis'] });
  },
});
```

### 3. Using Absolute Paths Instead of Aliases

❌ **Wrong**:
```typescript
import { useCIs } from '../../../hooks/useCIs';
```

✅ **Correct**:
```typescript
import { useCIs } from '@hooks/useCIs';
```

### 4. Not Handling Loading and Error States

❌ **Wrong**:
```typescript
function MyComponent() {
  const { data } = useCIs();
  return <DataTable rows={data.cis} />; // data might be undefined!
}
```

✅ **Correct**:
```typescript
function MyComponent() {
  const { data, isLoading, error } = useCIs();

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} />;
  if (!data) return null;

  return <DataTable rows={data.cis} />;
}
```

## Useful Snippets

### Debounced Search

```typescript
import { useState, useEffect } from 'react';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Usage
function SearchComponent() {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebounce(searchQuery, 300);

  const { data } = useCIs({ search: debouncedQuery });

  return (
    <TextField
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      placeholder="Search..."
    />
  );
}
```

### Copy to Clipboard

```typescript
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch (error) {
    toast.error('Failed to copy');
  }
};

// Usage
<Button onClick={() => copyToClipboard(ci.id)}>
  Copy ID
</Button>
```

### Export to CSV

```typescript
const exportToCSV = (data: any[], filename: string) => {
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map((row) =>
    Object.values(row)
      .map((val) => `"${val}"`)
      .join(',')
  );
  const csv = [headers, ...rows].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
};

// Usage
<Button onClick={() => exportToCSV(cis, 'cis.csv')}>
  Export to CSV
</Button>
```

## See Also

- [Authentication Guide](/components/authentication)
- [Getting Started](/getting-started/quick-start)
- [Development Guide](/development/overview)
