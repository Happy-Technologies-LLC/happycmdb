# HappyCMDB Documentation Site

This directory contains the VitePress-powered documentation site for HappyCMDB.

## Quick Start

### Prerequisites

- Node.js 20.x or higher
- npm 9.x or higher

### Installation

```bash
# Install dependencies
npm install
```

### Development

Run the development server with hot reload:

```bash
npm run docs:dev
```

The documentation site will be available at `http://localhost:5173`

### Building for Production

Build the static site:

```bash
npm run docs:build
```

The built files will be in `docs/.vitepress/dist`

### Preview Production Build

Preview the production build locally:

```bash
npm run docs:preview
```

### Serve Production Build

Serve the production build:

```bash
npm run docs:serve
```

## Project Structure

```
doc-site/
├── docs/                           # Documentation content
│   ├── .vitepress/
│   │   ├── config.ts              # VitePress configuration
│   │   └── theme/
│   │       ├── index.ts           # Theme customization
│   │       └── custom.css         # Custom styles
│   ├── public/                    # Static assets
│   │   ├── logos/                 # Logo files
│   │   └── images/                # Images and screenshots
│   ├── index.md                   # Homepage
│   ├── getting-started/           # Getting started guides
│   ├── architecture/              # Architecture documentation
│   ├── components/                # Component guides
│   ├── deployment/                # Deployment guides
│   ├── operations/                # Operations guides
│   ├── monitoring/                # Monitoring guides
│   ├── configuration/             # Configuration guides
│   ├── integration/               # Integration guides
│   ├── api/                       # API reference
│   ├── troubleshooting/           # Troubleshooting guides
│   └── quick-reference/           # Quick reference guides
├── package.json                   # Dependencies and scripts
├── .gitignore                     # Git ignore rules
└── README.md                      # This file
```

## Documentation Structure

The documentation is organized by audience and use case:

### Getting Started
- Quick start guide
- Installation instructions
- Key concepts
- Project structure

### Architecture
- System overview
- Backend architecture
- Frontend architecture
- Database architecture
- Job scheduling

### Component Guides
- BullMQ integration
- Web UI
- Data mart
- Authentication
- Discovery agents

### Deployment
- Quick start deployment
- Docker Compose
- Kubernetes deployment
- Cloud deployment
- Health checks

### Operations
- Daily operations
- Backup and restore
- Scaling strategies
- Maintenance procedures

### Monitoring
- Metrics collection
- Dashboards setup
- Alerting configuration
- Observability

### Configuration
- Environment variables
- Security configuration
- Service configuration

### Integration
- Cloud provider integrations (AWS, Azure, GCP)
- SSH discovery
- Network discovery
- Custom integrations

### API Reference
- REST API documentation
- GraphQL API documentation
- Authentication

### Troubleshooting
- Common issues
- Debug mode
- Performance tuning

### Quick Reference
- CLI commands cheat sheet
- API endpoints reference
- Configuration options
- Environment variables

## Adding Content

### Creating a New Page

1. Create a new markdown file in the appropriate directory
2. Add frontmatter (optional):

```yaml
---
title: Page Title
description: Page description for SEO
---
```

3. Write your content using markdown
4. Update the sidebar navigation in `docs/.vitepress/config.ts` if needed

### Using VitePress Features

#### Custom Containers

```markdown
::: tip
This is a tip
:::

::: warning
This is a warning
:::

::: danger
This is a danger message
:::

::: info
This is an info message
:::
```

#### Code Blocks with Syntax Highlighting

````markdown
```typescript
const greeting: string = "Hello, HappyCMDB!";
console.log(greeting);
```
````

#### Code Groups

````markdown
::: code-group
```bash [npm]
npm install
```

```bash [yarn]
yarn install
```

```bash [pnpm]
pnpm install
```
:::
````

#### Custom Badges

```markdown
<Badge type="tip" text="New" />
<Badge type="warning" text="Beta" />
<Badge type="danger" text="Deprecated" />
```

## Customization

### Branding Assets

Place your logo files in `docs/public/logos/`:

- `happycmdb-logo.svg` - Navigation bar logo
- `happycmdb-hero.svg` - Homepage hero image
- `favicon.svg` / `favicon.png` - Browser favicon
- `og-image.png` - Social sharing image (1200x630px)

### Theme Colors

Edit `docs/.vitepress/theme/custom.css` to customize colors:

```css
:root {
  --cb-primary: #0ea5e9;        /* Primary brand color */
  --cb-primary-dark: #0284c7;   /* Hover states */
  --cb-primary-light: #38bdf8;  /* Accents */
  /* ... more colors ... */
}
```

### Navigation

Edit `docs/.vitepress/config.ts` to customize:

- Top navigation bar
- Sidebar structure
- Social links
- Footer content

## Deployment

### Deploy with Docker (Recommended)

The documentation site can be deployed as a standalone Docker container using the included configuration.

#### Quick Start with Docker

```bash
# Build the Docker image
docker build -t happycmdb-docs .

# Run the container
docker run -d -p 8080:80 --name happycmdb-docs happycmdb-docs

# Access the documentation
# Open http://localhost:8080 in your browser
```

#### Using Docker Compose

```bash
# Start the documentation site
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the site
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

The documentation will be available at `http://localhost:8080`

#### Docker Features

- **Multi-stage build**: Optimized image size using Alpine Linux
- **Nginx serving**: Fast static file serving with compression
- **Health checks**: Built-in health monitoring endpoint at `/health`
- **Security headers**: CSP, X-Frame-Options, and other security headers
- **Cache optimization**: Aggressive caching for static assets
- **Production-ready**: Auto-restart, resource limits, and logging

#### Container Configuration

Edit `docker-compose.yml` to customize:

- **Port mapping**: Change `8080:80` to your desired port
- **Resource limits**: Adjust CPU and memory limits
- **Restart policy**: Change restart behavior
- **Volume mounts**: Enable for development mode

### Deploy to GitHub Pages

```bash
# Build the site
npm run docs:build

# Deploy to GitHub Pages (example)
cd docs/.vitepress/dist
git init
git add -A
git commit -m 'Deploy documentation'
git push -f git@github.com:happycmdb/happycmdb.git main:gh-pages
```

### Deploy to Netlify

1. Connect your repository to Netlify
2. Set build command: `npm run docs:build`
3. Set publish directory: `docs/.vitepress/dist`

### Deploy to Vercel

1. Import project to Vercel
2. Set build command: `npm run docs:build`
3. Set output directory: `docs/.vitepress/dist`

## Features

- Local search functionality
- Dark mode support
- Mobile responsive
- Fast page loads
- SEO optimized
- Syntax highlighting
- Custom theme
- Graph visualizations support
- API reference tools

## Resources

- [VitePress Documentation](https://vitepress.dev/)
- [Markdown Guide](https://www.markdownguide.org/)
- [HappyCMDB GitHub](https://github.com/happycmdb/happycmdb)

## Contributing

To contribute to the documentation:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `npm run docs:dev`
5. Submit a pull request

## License

This documentation is part of the HappyCMDB project and is released under the MIT License.
