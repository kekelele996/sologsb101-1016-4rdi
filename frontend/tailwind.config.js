/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brine: {
          50: '#eff9fb',
          100: '#d6f0f5',
          200: '#aee1ea',
          300: '#79c9d8',
          400: '#42a8bd',
          500: '#268ba2',
          600: '#1e6f89',
          700: '#1d5a70',
          800: '#1e4b5d',
          900: '#1d4050',
        },
        salt: {
          100: '#fdf6e7',
          200: '#f7e7bf',
          300: '#eed392',
          400: '#e0b75c',
          500: '#cf9a30',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
