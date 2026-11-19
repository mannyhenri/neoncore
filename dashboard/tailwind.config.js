/** @type {import('tailwindcss').Config} */

/*
 * Night Glass — the NeonCore palette (design: claude.ai/artifact/2UEYxNSgz4RZWyFzSVbTx2).
 *
 * The dashboard is ~19k lines of Tailwind classes written against the old Gridlight palette
 * (gray text, violet/purple accents). Rather than touch every class, the scales those classes
 * name are RE-POINTED here: `gray` becomes the blue-grey text/surface ramp, `violet`/`purple`
 * become the neon blue accent. A component that still says `text-violet-300` renders in the
 * new accent; restyling then only has to fix layout, not colour, file by file.
 */
const neon = {
  50: '#EEF6FF',
  100: '#DCEBFF',
  200: '#CFE6FF',
  300: '#9FD0FF',
  400: '#7CC4FF',
  500: '#5AAEFF',
  600: '#3B8BFF',
  700: '#2A6FE0',
  800: '#1F55B0',
  900: '#173E80',
  950: '#0E2550',
};

const slate = {
  50: '#F3F6FF',
  100: '#E8EEFF',
  200: '#DCE4F7',
  300: '#C9D3EC',
  400: '#A9B5D3',
  500: '#8A97B8',
  600: '#5F6B8C',
  700: '#2A3550',
  800: '#141C30',
  900: '#0B1122',
  950: '#070B16',
};

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'SF Mono', 'Menlo', 'monospace'],
        // Kept as an alias so any leftover `font-pixel` reads as the display face, not a 404.
        pixel: ['"Space Grotesk"', 'Inter', 'sans-serif'],
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 8px 2px rgba(90, 174, 255, 0.3)' },
          '50%': { boxShadow: '0 0 20px 6px rgba(90, 174, 255, 0.5)' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
      },
      colors: {
        gray: slate,
        violet: neon,
        purple: neon,
        neon,
        ink: '#04060C',
        // Needs-you orange (the design's warm accent).
        ember: { 300: '#FFB27A', 400: '#FF9B57', 500: '#FF8A3D' },
        gl: {
          bg: '#04060C',
          surface: '#0E1424',
          elevated: '#141C30',
          header: '#070B16',
          code: '#050913',
          pink: '#FF7AC0',
          purple: '#5AAEFF',
          blue: '#5AAEFF',
          brand: '#5AAEFF',
          teal: '#2EE6D6',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
