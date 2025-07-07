import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ 
            backgroundColor: '#ff9500', 
            padding: '4px 8px', 
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <img 
              src="/img/icon.png" 
              alt="elizaOS" 
              style={{ 
                height: '24px', 
                width: '24px'
              }}
            />
            <span style={{ 
              fontSize: '1.1rem', 
              fontWeight: '600', 
              color: 'white'
            }}>
              elizaOS
            </span>
          </div>
          <span style={{ fontSize: '0.875rem', color: '#666', fontWeight: 'normal' }}>
            Docs
          </span>
        </div>
      </>
    ),
  },
  // see https://fumadocs.dev/docs/ui/navigation/links
  links: [
    {
      text: 'Quick Start',
      url: '/docs/quickstart',
    },
    {
      text: 'Simple Track',
      url: '/docs/simple',
    },
    {
      text: 'Technical Track',
      url: '/docs/technical',
    },
    {
      text: 'GitHub',
      url: 'https://github.com/elizaos/eliza',
      external: true,
    },
    {
      text: 'Discord',
      url: 'https://discord.gg/elizaos',
      external: true,
    },
  ],
  githubUrl: 'https://github.com/elizaos/eliza',
};
