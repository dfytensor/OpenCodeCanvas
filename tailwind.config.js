/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: {
          bg: '#0d1117',
          grid: '#1b2230',
          node: '#161b22',
          border: '#30363d',
          accent: '#2f81f7',
          fork: '#a371f7'
        }
      }
    }
  },
  plugins: []
}
