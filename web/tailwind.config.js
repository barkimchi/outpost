/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A deliberate dark-editor palette, not Tailwind's default grays. `gym-*` so
        // nothing here collides with the framework's own scale and every use is
        // unambiguous grep-able intent, not an accidental `bg-gray-800`.
        gym: {
          bg: '#0a0c0f',
          panel: '#111319',
          panel2: '#151822',
          panel3: '#1b1f2a',
          border: '#242938',
          'border-strong': '#333b4f',
          text: '#e6e9f0',
          'text-dim': '#98a1b3',
          'text-faint': '#5c6478',
          accent: '#e0a12e',
          'accent-soft': '#f2c46b',
          'accent-dim': '#4a3a1c',
          green: '#3fd68a',
          'green-dim': '#1c3f2d',
          blue: '#5aa2f7',
          'blue-dim': '#1c2e4a',
          amber: '#e0a12e',
          'amber-dim': '#4a3a1c',
          red: '#f0616a',
          'red-dim': '#4a2226',
          purple: '#b48af0',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 24px rgba(0,0,0,0.35)',
        popover: '0 12px 32px rgba(0,0,0,0.5)',
      },
    },
  },
  plugins: [],
};
