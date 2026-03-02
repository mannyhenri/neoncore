/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 8px 2px rgba(59, 130, 246, 0.3)' },
          '50%': { boxShadow: '0 0 20px 6px rgba(59, 130, 246, 0.5)' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
      },
      colors: {
        gl: {
          bg: '#0f0f23',
          surface: '#1a1a2e',
          elevated: '#252542',
          header: '#12121a',
          code: '#0d0d14',
          pink: '#ec4899',
          purple: '#a855f7',
          blue: '#3b82f6',
          brand: '#e91e63',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
