/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
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
