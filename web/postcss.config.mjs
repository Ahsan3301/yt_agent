// Tailwind v4 ships its own PostCSS plugin. No more `tailwindcss` +
// `autoprefixer` separate plugins — `@tailwindcss/postcss` bundles both.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
