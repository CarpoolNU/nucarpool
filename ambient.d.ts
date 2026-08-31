// Ambient module declarations for imports the packages themselves do not type.
//
// Kept in one file rather than three one-line ones. `tsconfig.json` includes
// `**/*.d.ts`, so nothing needs to reference this path.

// CSS and preprocessor imports, which Next handles but TypeScript does not know
// about on their own.
declare module "*.css";
declare module "*.scss";
declare module "*.sass";

// `driver.js` ships its stylesheet without a type declaration.
declare module "driver.js/dist/driver.css";

// `chartjs-adapter-date-fns` is imported for its side effect of registering the
// date adapter with Chart.js, and publishes no types.
declare module "chartjs-adapter-date-fns";
